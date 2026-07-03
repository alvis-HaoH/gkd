#!/usr/bin/env node
// gkd-runtime —— GKD 的换脑底座。
// 借 Claude Code 的完整 harness,spawn 一个以委派模型(GLM/Kimi/GPT 等任意注册模型)为大脑的 claude -p 子进程,
// 让它在自己的上下文里读文件/思考/迭代,只把结果回传。主 Claude 不烧重活的 token。
//
// 用法:
//   node gkd-runtime.mjs [--<modelKey>] [--write] [--resume] [--with-context]
//                        [--allowed-tools "Read Grep Glob"] [--json] [--help] "<任务文本(含文件路径)>"
//
// 模型选择:
//   --<modelKey> 是 config/models.json 里的 key(任意一个),例如 --glm / --kimi / --gpt。
//   不写则使用第一个未禁用的模型。运行 `--help` 查看当前可用模型列表。
//
// 上下文三档:
//   (默认 A) 干净委派:不带任何历史
//   --resume        (B) 续上次本工具的委派线程
//   --with-context  (C) 让子进程加载主 Claude 当前对话历史(fork,只读继承,主 token 几乎免费)

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, realpathSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── 模型注册表:从 config/models.json 读取 ───────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_FILE = join(__dirname, "..", "config", "models.json");

function pickDefaultModel(models) {
  // 取第一个未禁用的 key 当默认
  for (const [k, v] of Object.entries(models)) {
    if (!v.disabled) return k;
  }
  return Object.keys(models)[0];
}

function expandEnv(str) {
  // 把 "${VAR}" / "$VAR" 插值成环境变量值
  if (typeof str !== "string") return str;
  return str.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/gi,
    (_, a, b) => process.env[a || b] ?? "");
}

function loadModels() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
  } catch (e) {
    fail(`无法读取模型配置 ${MODELS_FILE}: ${e.message}`);
  }
  if (!raw.models || typeof raw.models !== "object") {
    fail(`${MODELS_FILE} 缺少 models 字段`);
  }
  return raw.models;
}

// ── 主对话 session jsonl 定位(供 --with-context 找文件)──────────────────
// Claude Code 把每个 session 的 jsonl 落在 ~/.claude/projects/<编码后的启动 cwd>/<sessionId>.jsonl。
// 用户在会话中 cd 后,jsonl 仍在启动 cwd 对应的项目目录里,不会跟 process.cwd() 同步。
// 所以 spawn 子进程时若直接继承漂移后的 cwd,claude --resume <id> 会按当前 cwd 编码找,找不到。
// 这里扫所有 projects 目录定位 jsonl,读首行的 cwd 字段,返回原始启动 cwd —— spawn 时把 child 的
// cwd override 成它,child claude 才能解析到正确的项目目录。
function findSessionCwd(sessionId) {
  if (!sessionId) return null;
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const jsonlPath = join(projectsDir, e.name, `${sessionId}.jsonl`);
    if (!existsSync(jsonlPath)) continue;
    // jsonl 的前几行可能是 metadata(type=mode/file-history-snapshot/ai-title 等)没有 cwd 字段,
    // 真正带 cwd 的是首条 user/assistant/system 记录。扫前 50 行内拿第一个 cwd 即可。
    try {
      const lines = readFileSync(jsonlPath, "utf8").split("\n", 50);
      for (const ln of lines) {
        if (!ln) continue;
        try {
          const obj = JSON.parse(ln);
          if (typeof obj?.cwd === "string" && obj.cwd) return obj.cwd;
        } catch { /* 单行损坏跳过 */ }
      }
    } catch { /* 文件读不到跳过 */ }
  }
  return null;
}

// ── 委派流水 delegations.jsonl —— 单一 append-only 记录 ────────────────────
// 每行 = 一次委派(含 session/cost/task 全部属性)。它同时充当:
//   ① 用量流水(供 /gkd:stats)② session 索引(供 --resume 续本目录上次)③ task 检索源。
// append-only 天然无并发 lost update:每个进程只往末尾加自己那行,不做整体 read-modify-write。
const STATE_DIR = join(homedir(), ".claude", "gkd");
const DELEGATIONS_FILE = join(STATE_DIR, "delegations.jsonl");
const LEGACY_USAGE_FILE = join(STATE_DIR, "usage.jsonl");   // 旧:用量流水,迁移后不再写
const LEGACY_STATE_FILE = join(STATE_DIR, "sessions.json"); // 旧:每 cwd 最后一次 session,迁移后不再写

// state 目录/文件含原始任务文本等本地敏感数据,权限收紧到仅当前用户(目录 0700 / 文件 0600)。
// 已存在的目录也 chmod 到 0700,让老用户的既有目录无感升级。
function ensureStateDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(STATE_DIR, 0o700); } catch { /* 改不动就算了,不阻断委派 */ }
}

// 一次性迁移(幂等):把老 usage.jsonl + sessions.json 合并成 delegations.jsonl。
// 关键:老 usage.jsonl 早期行没有 sessionId(那些字段是后来才加的),单靠它老目录续不上;
// 必须把 sessions.json 每条(每 cwd 最后一次 session)折叠成合成 delegation 行补进去。
// 老文件保留不删(降级安全),迁移后 runtime 只认 delegations.jsonl。
function migrateLegacyState() {
  if (existsSync(DELEGATIONS_FILE)) return;  // 迁移过了
  if (!existsSync(LEGACY_USAGE_FILE) && !existsSync(LEGACY_STATE_FILE)) return;  // 全新用户,无可迁移
  try {
    ensureStateDir();
    let lines = [];
    // ① 老 usage.jsonl 整体作为基础(原样保留,老行缺字段无妨)
    if (existsSync(LEGACY_USAGE_FILE)) {
      lines = readFileSync(LEGACY_USAGE_FILE, "utf8").split("\n").filter((l) => l.trim());
    }
    // ② sessions.json 每条折叠成合成行,让老目录的「续上次」不断
    if (existsSync(LEGACY_STATE_FILE)) {
      try {
        const state = JSON.parse(readFileSync(LEGACY_STATE_FILE, "utf8"));
        for (const [cwd, v] of Object.entries(state)) {
          if (!v?.sessionId) continue;
          lines.push(JSON.stringify({
            ts: v.ts || new Date(0).toISOString(),
            sessionId: v.sessionId,
            task: null,
            parentSessionId: null,
            modelKey: null,
            model: [],
            mode: "clean",
            write: v.mode === "write",
            cwd,
            sessionCwd: cwd,   // 旧 sessions.json 的 key 就是归属目录
            ok: true,
            durationMs: null,
            usage: {},
            _migrated: "sessions.json",
          }));
        }
      } catch { /* sessions.json 损坏就跳过,不阻断迁移 */ }
    }
    // 原子写:先写临时文件再 rename。否则 writeFileSync 写一半被中断/并发,会留下残缺 delegations.jsonl,
    // 而 existsSync 是"已迁移"的唯一闸门 → 残缺文件永久固化、老数据成沉默孤源。rename 保证要么完整要么不存在。
    const tmp = `${DELEGATIONS_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
    renameSync(tmp, DELEGATIONS_FILE);
  } catch (e) {
    process.stderr.write(`[gkd] 迁移 state 失败(忽略,将按空历史继续): ${e.message}\n`);
  }
}

// 倒序扫 delegations.jsonl,取第一条 sessionCwd===cwd 的行 → { sessionId, write }。
// 等价于旧 readState()[cwd];链式续接每次 append 新行,倒序自然取最新 fork。
function findLastDelegation(cwd) {
  if (!existsSync(DELEGATIONS_FILE)) return null;
  try {
    const lines = readFileSync(DELEGATIONS_FILE, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const e = JSON.parse(lines[i]);
        if (e.sessionId && e.sessionCwd === cwd) return { sessionId: e.sessionId, write: !!e.write };
      } catch { /* 单行损坏跳过 */ }
    }
  } catch { /* 文件读不到跳过 */ }
  return null;
}

// 从 delegations.jsonl 倒序找某 sessionId 最后一次委派的读写模式(供点名续 id 时恢复 mode)。
function findSessionMode(sessionId) {
  if (!sessionId || !existsSync(DELEGATIONS_FILE)) return null;
  try {
    const lines = readFileSync(DELEGATIONS_FILE, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const e = JSON.parse(lines[i]);
        if (e.sessionId === sessionId) return e.write ? "write" : "read";
      } catch { /* 单行损坏跳过 */ }
    }
  } catch { /* 文件读不到跳过 */ }
  return null;
}

// 任务摘要:空白归一化 + 按 Unicode 字符(非字节,防截断中文)截断到 120 字 + 省略号。
// 供主 Claude 按「模糊描述」在 delegations.jsonl 里检索历史 session。含原始任务文本,本地敏感。
function makeTaskPreview(task) {
  const s = String(task ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const chars = Array.from(s);
  return chars.length > 120 ? chars.slice(0, 120).join("") + "…" : s;
}

// 每次委派追加一行到 delegations.jsonl。失败不让 runtime 崩。
function appendDelegation(entry) {
  try {
    ensureStateDir();
    appendFileSync(DELEGATIONS_FILE, JSON.stringify(entry) + "\n");
  } catch (e) {
    process.stderr.write(`[gkd] 写 delegations 日志失败(忽略): ${e.message}\n`);
    return;
  }
  // 权限收紧单独处理:写成功但 chmod 失败(如 iCloud/NFS/只读挂载)不该被当成"写失败",
  // 但也不能静默——文件含原始任务文本,权限没收紧时明确告警,让用户知道可能被同机其他用户读到。
  try {
    chmodSync(DELEGATIONS_FILE, 0o600);
  } catch (e) {
    process.stderr.write(`[gkd] ⚠ 无法收紧 delegations.jsonl 权限(${e.code || e.message}):该文件含原始任务文本,当前权限下同机其他用户可能可读\n`);
  }
}

// Claude Code sessionId 是 UUID v4 形态(8-4-4-4-12 hex)。用它闸门 --resume 的可选 id 参数。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── 参数解析 ──────────────────────────────────────────────────────────
// modelKeys:从 models.json 动态读出的合法模型 key 集合,任意 --<key> 都识别
function parseArgs(argv, modelKeys) {
  const opts = {
    model: null,           // 由 main 在解析后兜底成默认
    write: false,
    resume: false,
    resumeId: null,        // --resume 后跟的显式 sessionId(点名续任意历史 session)
    withContext: false,
    allowedTools: null,
    promptFile: null,      // --prompt-file:把文件内容作为前置系统指令注入子进程
    render: null,          // --render <kind>:对子进程 result 做结构化渲染(目前仅 "review")
    json: false,
    help: false,
    quiet: false,
    task: [],
  };
  const RENDER_KINDS = ["review"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--write") opts.write = true;
    else if (a === "--resume") {
      // --resume 后紧跟一个 UUID 形态的值 = 点名续该 sessionId;否则 = 续本目录上次。
      // 必须用 UUID 正则闸门:命令层把任务文本作为单个 argv 传入,不闸门会把任务文本误当 id。
      const next = argv[i + 1];
      if (next && UUID_RE.test(next)) { opts.resumeId = next; i++; }
      opts.resume = true;
    }
    else if (a === "--with-context") opts.withContext = true;
    else if (a === "--allowed-tools") opts.allowedTools = argv[++i];
    else if (a === "--prompt-file") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail("--prompt-file 需要一个文件路径参数");
      opts.promptFile = v;
    }
    else if (a === "--render") {
      const v = argv[++i];
      if (!v || !RENDER_KINDS.includes(v)) fail(`--render 需要一个渲染类型参数(当前支持: ${RENDER_KINDS.join(", ")})`);
      opts.render = v;
    }
    else if (a === "--model") fail("--model 已废弃,请用 --<modelKey>(如 --glm),见 --help");
    else if (a === "--json") opts.json = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a.startsWith("--") && modelKeys.includes(a.slice(2))) opts.model = a.slice(2);
    else opts.task.push(a);
  }
  opts.task = opts.task.join(" ").trim();
  return opts;
}

function printHelp(models) {
  const rows = Object.entries(models).map(([k, v]) => {
    const tag = v.disabled ? "❌" : "✅";
    return `  ${tag} --${k.padEnd(12)} ${v.model.padEnd(24)} ${v.disabled ? "(禁用: " + (v.disabledReason || "") + ")" : ""}\n` +
           `       ${v.description || ""}`;
  }).join("\n");
  process.stdout.write(`gkd-runtime —— 把任务委派给指定模型的 Claude Code 子进程

用法:  node gkd-runtime.mjs [--<modelKey>] [选项] "<任务>"

可用模型(来自 config/models.json):
${rows}

选项:
  --<modelKey>          选择模型(任意 models.json 里的 key)
  --write               允许子进程改文件(默认只读)
  --resume [<id>]       续委派线程(B 档):不带 id=续本目录上次;带 UUID=点名续该 session(可跨目录)
  --with-context        让子进程加载主对话历史(C 档,需 CLAUDE_CODE_SESSION_ID)
  --allowed-tools "..." 自定义工具列表
  --prompt-file <path>  把文件内容作为前置系统指令注入子进程(如 review prompt 模板)
  --render review       把子进程 result(应为 JSON)渲染成干净审查报告;解析失败则原文降级
  --json                结构化输出(供 workflow 消费)
  --help, -h            打印此帮助
`);
}

// ── 构造换脑子进程的参数 + 要注入的 env override ──────────────────────
function buildSpawn(opts, cwd, models) {
  const m = models[opts.model];
  if (!m) {
    fail(`未知模型别名: ${opts.model}。可用: ${Object.keys(models).join(", ")}`);
  }
  if (m.disabled) {
    fail(`模型 ${opts.model}(${m.model})当前不可用:${m.disabledReason || "(未注明原因)"}`);
  }

  const baseUrl = expandEnv(m.baseUrl);
  const authToken = expandEnv(m.authToken);
  if (!baseUrl) fail(`模型 ${opts.model} 的 baseUrl 为空(检查 config/models.json)`);
  if (!authToken) fail(`模型 ${opts.model} 的 authToken 为空(检查环境变量是否已 export)`);

  // 模型可选 env:注入到子进程环境,支持 ${VAR} 插值。
  // 用于按网关差异调整 CLI 行为,例如某些端点未适配 adaptive thinking,需 MAX_THINKING_TOKENS=0 关闭。
  const modelEnv = {};
  if (m.env && typeof m.env === "object") {
    for (const [k, v] of Object.entries(m.env)) modelEnv[k] = expandEnv(String(v));
  }

  const args = ["-p", opts.task];
  // 换脑:唯一可靠开关
  args.push("--model", m.model);
  // 排除 user settings(避免主环境配置污染),认证来自继承的 shell env
  args.push("--setting-sources", "project");

  // --prompt-file:把模板文件内容作为前置系统指令注入(主 token 零经手)。
  // 用于 review 等"角色/立场指令固定"的场景——指令沉在文件里,不靠主 Claude 现拼进任务文本。
  if (opts.promptFile) {
    let promptText;
    try {
      promptText = readFileSync(opts.promptFile, "utf8");
    } catch (e) {
      fail(`--prompt-file 读取失败 ${opts.promptFile}: ${e.message}`);
    }
    args.push("--append-system-prompt", promptText);
  }

  // 读写权限
  const tools = opts.allowedTools
    ? opts.allowedTools.split(/\s+/)
    : opts.write
      ? ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]
      : ["Read", "Grep", "Glob"];
  args.push("--allowed-tools", ...tools);
  args.push("--permission-mode", opts.write ? "acceptEdits" : "default");

  // --with-context 与 --resume 互斥(不论带不带 id):前者续主对话、后者续委派子进程,
  // 同传时 buildSpawn 会静默进 with-context 分支、把 --resume 吞掉,续委派意图丢失,故直接 fail。
  if (opts.withContext && opts.resume) {
    fail("--with-context 不能和 --resume 同时使用:要么续委派线程(--resume [<id>]),要么从主对话 fork(--with-context),二选一");
  }

  // 上下文三档
  let spawnCwd = null;       // 默认 null = 继承父进程 cwd(A/B 档默认)
  let stateCwd = cwd;        // 结束时把新 fork 的 session 记到哪个 cwd 下(默认调用 cwd)
  let parentSessionId = null; // B 档:本次 fork 自哪个委派 session(供重建 fork 链、检索最新节点)
  if (opts.withContext) {
    // C 档:加载主 Claude 当前对话历史(fork → 只读继承,不污染主 session 文件)
    const mainSession = process.env.CLAUDE_CODE_SESSION_ID;
    if (!mainSession) {
      fail("--with-context 需要主对话 session-id,但未找到 CLAUDE_CODE_SESSION_ID");
    }
    // 关键:child claude 按自己的 cwd 编码去找 ~/.claude/projects/<encoded-cwd>/<id>.jsonl,
    // 但用户在主会话期间可能 cd 漂移过,jsonl 实际还在启动 cwd 那一档。
    // 我们扫盘定位 jsonl 的真实归属 cwd,把 child 的 cwd 钉在那里,确保 --resume 能解析到。
    const sessionOriginCwd = findSessionCwd(mainSession);
    if (!sessionOriginCwd) {
      fail(`--with-context 找不到主 session ${mainSession.slice(0, 8)}... 的 jsonl 文件(扫遍 ~/.claude/projects/*)。可能 session 还没落盘,或文件被清理了。`);
    }
    if (sessionOriginCwd !== cwd) {
      process.stderr.write(`[gkd] --with-context: 检测到 cwd 漂移(用户 ${cwd} → 原 session ${sessionOriginCwd}),已 override 子进程 cwd 以定位 session 文件\n`);
    }
    spawnCwd = sessionOriginCwd;
    stateCwd = sessionOriginCwd;  // fork 出的 session 落在主对话归属目录,state/usage 的 sessionCwd 须与之一致
    args.push("--resume", mainSession, "--fork-session");
  } else if (opts.resume) {
    // B 档:续委派线程。opts.resumeId = 点名续该 id;否则续本目录上次
    const sid = opts.resumeId || findLastDelegation(cwd)?.sessionId;
    if (!sid) {
      fail("--resume 找不到上次的委派线程(本目录还没委派过)。若要点名续历史,传 --resume <sessionId>");
    }
    // 无论点名还是续上次,都按 id 反查 jsonl 真实归属目录钉住 child cwd,
    // 否则 child claude 会按当前 cwd 编码找 jsonl → 跨目录续必然找不到。
    const originCwd = findSessionCwd(sid);
    if (!originCwd) {
      fail(`找不到 session ${sid.slice(0, 8)}... 的 jsonl(扫遍 ~/.claude/projects/*)。可能:id 复制错了、文件被手动清理、或是别的机器/用户目录里的 session。`);
    }
    if (originCwd !== cwd) {
      process.stderr.write(`[gkd] --resume: session 归属目录 ${originCwd}(≠ 当前 ${cwd}),子进程将在该目录运行\n`);
    }
    spawnCwd = originCwd;
    stateCwd = originCwd;  // 关键:新 fork 记到 session 真实归属目录,不污染调用 cwd 的 state
    parentSessionId = sid; // 记下被续的 id,让 fork 链 A→B→C 可从 delegations 重建
    args.push("--resume", sid, "--fork-session");
  }
  // A 档:什么都不加

  args.push("--output-format", "json");
  return {
    args,
    envOverride: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: authToken, ...modelEnv },
    spawnCwd,
    stateCwd,
    parentSessionId,
  };
}

function fail(msg) {
  process.stderr.write(`[gkd] 错误: ${msg}\n`);
  process.exit(1);
}

// 清理代理变量(与 ~/.zshrc 的 claude 包装函数一致),避免内网网关被代理拦截。
// override 用于按所选模型注入 BASE_URL/AUTH_TOKEN(不同模型可能走不同端点)。
function childEnv(override = {}) {
  const env = { ...process.env, ...override };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                    "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    delete env[k];
  }
  return env;
}

// ── review 结构化渲染 ─────────────────────────────────────────────────
// 子进程被 prompt 要求"最终消息只吐一个 JSON 对象",但便宜模型常在 JSON 前后夹带独白、
// 套 markdown 围栏,或在字符串里塞非法转义(如 \` —— JSON 只认 \" \\ \/ \b \f \n \r \u)。
// 这里从多个候选来源提取,每个候选都先原样 parse、失败再清洗非法转义重试,校验形状后渲染。
// 全部失败 → 原文降级(不崩,把原始 result 附回让用户自己看)。

// 删掉字符串里"反斜杠后接非合法 JSON 转义字符"的反斜杠(模型误转义 markdown 反引号等常见)。
// 边界:这只处理孤立非法反斜杠,兜不住 \u 后接非 4 位 hex、或字符串内的字面控制字符等。
// 属尽力而为的容错——兜不住就让候选 parse 失败、最终降级原文(不崩),这是设计预期。
function stripBadEscapes(s) {
  return s.replace(/\\(?!["\\/bfnrtu])/g, "");
}

// 先原样 parse,失败再清洗非法转义 parse。任一成功即返回 {ok,data}。
function tryParseJson(s) {
  try { return { ok: true, data: JSON.parse(s) }; } catch { /* 继续 */ }
  try { return { ok: true, data: JSON.parse(stripBadEscapes(s)) }; } catch { /* 继续 */ }
  return { ok: false };
}

// 提取审查 JSON。候选来源:整串 → 围栏内容 → 所有顶层平衡对象(按长度降序)。
// 关键:对每个候选先 parse 再 validateReviewShape,校验通过才采纳——否则一个语法合法但
// 形状不符的诱饵 JSON(如模型在 recommendation 里贴的代码块)会挤掉真报告。
// 残余风险:若诱饵本身形状也合规(模型贴了个完整合法的示例审查 JSON),按长度降序它可能
// 先于真报告被采纳。这已达纯启发式的极限,靠 prompt 约束"别贴示例 JSON"缓解,不在此强防。
function extractReviewJson(result) {
  const raw = (result || "").trim();
  if (!raw) return { ok: false, error: "result 为空" };

  const candidates = [raw];
  // ② markdown 围栏内容(```json … ``` 或 ``` … ```)
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  // ③ 所有顶层平衡 {…}(按长度降序),应对独白 + JSON 混排 / 前置诱饵 JSON
  candidates.push(...topLevelObjects(raw));

  let lastShapeErr = null;
  for (const c of candidates) {
    const r = tryParseJson(c);
    if (!r.ok) continue;
    const shapeErr = validateReviewShape(r.data);
    if (!shapeErr) return { ok: true, data: r.data };
    lastShapeErr = shapeErr;  // 语法合法但形状不符,记下继续试下一个候选
  }
  return {
    ok: false,
    error: lastShapeErr
      ? `提取到 JSON 但形状不符(${lastShapeErr})`
      : "未能从 result 中提取出合法 JSON 对象",
  };
}

// 从文本里找出所有顶层(depth 从 0 到 0)的括号平衡 {…} 子串,忽略字符串字面量内的花括号,
// 按长度降序返回。降序让"最外层最完整"的对象优先被尝试,同时保留次长候选供回退。
function topLevelObjects(s) {
  const found = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          found.push(s.slice(i, j + 1));
          i = j;  // 跳过这个对象内部的 { 起点,只收顶层
          break;
        }
      }
    }
  }
  return found.sort((a, b) => b.length - a.length);
}

// 手动校验(不引 JSON-Schema 库,与 prompts/review-output.schema.json 手动保持同步——
// 改 schema 记得同步改这里)。校验 enum 取值,拦住模型漂移出契约的输出。
const VERDICT_VALUES = ["correct", "incorrect", "approve", "needs-attention"];
const PRIORITY_VALUES = ["P0", "P1", "P2", "P3"];

function validateReviewShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "顶层不是 JSON 对象";
  if (typeof data.verdict !== "string" || !data.verdict.trim()) return "缺少有效 verdict";
  if (!VERDICT_VALUES.includes(data.verdict)) return `verdict 取值非法: ${data.verdict}`;
  if (typeof data.summary !== "string" || !data.summary.trim()) return "缺少有效 summary";
  if (!Array.isArray(data.findings)) return "findings 不是数组";
  for (let i = 0; i < data.findings.length; i++) {
    const f = data.findings[i];
    if (!f || typeof f !== "object") return `findings[${i}] 不是对象`;
    for (const k of ["title", "file", "body"]) {
      if (typeof f[k] !== "string" || !f[k].trim()) return `findings[${i}] 缺少有效 ${k}`;
    }
    if (f.priority !== undefined && !PRIORITY_VALUES.includes(f.priority)) {
      return `findings[${i}] priority 取值非法: ${f.priority}`;
    }
    if (f.confidence !== undefined &&
        (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1)) {
      return `findings[${i}] confidence 须是 0~1 的数值`;
    }
  }
  return null;
}

const P_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

function renderReview(data) {
  const findings = [...data.findings];
  // 缺陷式(带 priority)按 P0→P3 排;对抗式保留模型给的原序——模型已被要求按风险严重度排,
  // 不能用 confidence 覆盖它(高危风险常置信度更低,重排会把它压到后面)。
  if (findings.some((f) => f.priority)) {
    findings.sort((a, b) => (P_RANK[a.priority] ?? 9) - (P_RANK[b.priority] ?? 9));
  }

  const out = [];
  out.push(`## 审查报告\n`);

  if (findings.length === 0) {
    out.push("**无发现** —— 未发现值得报的问题。\n");
  } else {
    findings.forEach((f, idx) => {
      const tag = f.priority ? `[${f.priority}] ` : "";
      const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      out.push(`### ${idx + 1}. ${tag}${f.title}`);
      out.push(`- 位置:${loc}`);
      out.push(`- 问题:${f.body}`);
      if (f.recommendation && f.recommendation.trim()) out.push(`- 建议:${f.recommendation}`);
      if (typeof f.confidence === "number") out.push(`- 置信度:${f.confidence}`);
      out.push("");
    });
  }

  out.push(`**总判定:\`${data.verdict}\`** —— ${data.summary}`);
  return out.join("\n");
}

// 渲染入口:成功 → 干净报告;失败 → 原文降级(带告警前缀)。
// extractReviewJson 内部已做形状校验,这里 ok 即代表 data 形状合法,直接渲染。
// 降级前缀只给用户"这不是正常报告"的信号,不塞 extracted.error 那种内部诊断术语
// (verdict/result 等对终端用户是噪音;要诊断走 --json 或 stderr 元信息)。
function renderReviewResult(result) {
  const extracted = extractReviewJson(result);
  if (!extracted.ok) {
    return `[gkd] ⚠ 模型输出未通过结构化校验,以下为原始输出:\n\n${result}`;
  }
  return renderReview(extracted.data);
}

// ── 主流程 ────────────────────────────────────────────────────────────
function main() {
  const models = loadModels();
  const opts = parseArgs(process.argv.slice(2), Object.keys(models));
  const cwd = process.cwd();

  if (opts.help) { printHelp(models); process.exit(0); }
  if (!opts.model) opts.model = pickDefaultModel(models);

  migrateLegacyState();  // 幂等:首次运行把老 usage.jsonl+sessions.json 合并成 delegations.jsonl

  if (!opts.task && !opts.resume) {
    fail("缺少任务文本。运行 gkd-runtime --help 查看用法。");
  }

  // --resume 时,若用户没显式 --write,则恢复该会话的读写模式。显式 --write 永远胜过继承。
  // 两条来源分开:点名续 id 从 delegations.jsonl 按 id 反查;续本目录上次取该 cwd 最新一条。
  if (opts.resume && !opts.write) {
    if (opts.resumeId) {
      const m = findSessionMode(opts.resumeId);
      if (m === "write") {
        opts.write = true;
        if (!opts.quiet) process.stderr.write(`[gkd] 点名续会话:从委派记录恢复写模式\n`);
      } else if (!opts.quiet) {
        process.stderr.write(`[gkd] 点名续会话:${m === "read" ? "恢复只读模式" : "无历史读写记录,默认只读"};需写文件请用 /gkd:do --resume ${opts.resumeId.slice(0, 8)}...\n`);
      }
    } else {
      const last = findLastDelegation(cwd);
      if (last?.write) {
        opts.write = true;
        if (!opts.quiet) process.stderr.write(`[gkd] 续会话:从上次继承写模式\n`);
      }
    }
  }

  const { args: claudeArgs, envOverride, spawnCwd, stateCwd, parentSessionId } = buildSpawn(opts, cwd, models);
  const cli = process.env.GKD_CLAUDE_BIN || "claude";

  const startMs = Date.now();
  const child = spawn(cli, claudeArgs, {
    env: childEnv(envOverride),
    stdio: ["ignore", "pipe", "pipe"],
    cwd: spawnCwd || undefined,  // null/undefined = 继承父进程 cwd(默认行为)
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  child.on("error", (e) => fail(`无法启动 claude 子进程: ${e.message}`));

  child.on("close", (code) => {
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      fail(`子进程输出非 JSON(exit ${code}):\n${stdout.slice(0, 500)}\n${stderr.slice(0, 300)}`);
    }

    const result = parsed.result ?? "";
    const modelUsed = parsed.modelUsage ? Object.keys(parsed.modelUsage) : [];
    // 只追加一条 delegation 行:其 sessionCwd 字段兼任「续本目录上次」的索引(取代旧 sessions.json)。
    appendDelegation({
      ts: new Date().toISOString(),
      sessionId: parsed.session_id,  // 供 findSessionMode 反查 mode / findLastDelegation 续本目录上次
      // task = 委派原始任务摘要,供模糊检索。resume 行的 opts.task 是补充指令(非原始意图),
      // 写 null 保持语义纯净——该 session 的原始任务已记在它 spawn 那行。
      task: opts.resume ? null : makeTaskPreview(opts.task),
      parentSessionId,  // B 档 fork 自哪个 session(A/C 档为 null);串起 fork 链,检索时可回溯到最新节点
      modelKey: opts.model,
      model: modelUsed,
      mode: opts.withContext ? "with-context" : opts.resume ? "resume" : "clean",
      write: opts.write,
      cwd,                 // 调用时的当前目录
      sessionCwd: stateCwd, // session 真实归属目录(跨目录续时 ≠ cwd),兼任续本目录上次的索引键
      ok: !parsed.is_error,
      durationMs: Date.now() - startMs,
      usage: parsed.modelUsage ?? {},
    });

    if (opts.json) {
      // 结构化输出,供命令/workflow 消费
      process.stdout.write(JSON.stringify({
        ok: !parsed.is_error,
        model: modelUsed,
        sessionId: parsed.session_id,
        result,
      }, null, 2) + "\n");
    } else {
      // 人类可读:结果 + 一行元信息(--quiet 时压制,供 brainstorm 等下游脚本干净消费 stdout)
      // --render review:把子进程 result(应为 JSON)渲染成干净报告;提取/校验失败则原文降级。
      const humanOut = opts.render === "review" ? renderReviewResult(result) : result;
      process.stdout.write(humanOut + "\n");
      if (!opts.quiet) {
        const tag = parsed.is_error ? "❌ 失败" : "✅";
        process.stderr.write(`\n[gkd] ${tag} | 实际模型: ${modelUsed.join(",") || "?"} | session: ${parsed.session_id || "?"}\n`);
      }
    }
    process.exit(parsed.is_error ? 1 : 0);
  });
}

// 仅在作为脚本直接运行时启动 main;被 import(如单测)时不自动执行。
// 注意:plugin 常以 symlink 安装(~/.claude/skills/gkd → 源仓库),此时 process.argv[1]
// 保留 symlink 路径,而 import.meta.url 是 ESM loader 解析后的 realpath,直接比较会失配
// 导致 main 不跑、脚本静默哑火。故两侧都 realpath 归一后再比。
function isRunAsScript() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(invoked) === realpathSync(self);
  } catch {
    // realpath 失败(symlink 断裂/文件被删/跨盘等)极罕见。退化为绝对路径字符串比较:
    // 只有归一后仍相等才判为直接运行。不无条件返回 true——否则被 import 跑单测时,
    // 若 realpath 恰好抛错会误触发 main 去 spawn 子进程,污染测试。
    return resolve(invoked) === resolve(self);
  }
}
if (isRunAsScript()) {
  main();
}

export { extractReviewJson, validateReviewShape, renderReview, renderReviewResult };
