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
//   --with-context  (C) 让子进程加载主 Claude 当前对话历史(claude:fork,只读继承,主 token 几乎免费;
//                       codex:首次把当前对话导入成 codex thread 再续,约 1-2s)

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, realpathSync, chmodSync, renameSync, unlinkSync, openSync, readSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importClaudeSessionToCodex } from "./gkd-codex-import.mjs";

// ── 模型注册表:从 config/models.json 读取 ───────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_FILE = join(__dirname, "..", "config", "models.json");

// ── 传给官方 claude CLI 的 flag 名,集中一处 ──
// 换脑靠 spawn `claude -p --model` 子进程,这些字符串必须和当前 claude CLI 认的 flag 一字不差。
// 官方升级若改了某个 flag 名,只改这里一行即可,不必翻遍 buildSpawn。
// (注:用户在 gkd 命令行敲的 flag 如 --glm/--with-context/--resume 由 parseArgs 处理,不在此表。)
const CLI_FLAGS = {
  print: "-p",                       // headless 非交互调用
  model: "--model",                  // 换脑唯一可靠开关
  settingSources: "--setting-sources", // 排除 user settings,认证走继承的 shell env
  appendSystemPrompt: "--append-system-prompt", // 前置系统指令(--prompt-file 内容)
  allowedTools: "--allowed-tools",   // 读/写权限边界
  permissionMode: "--permission-mode",
  resume: "--resume",                // 续 session(委派线程 或 主对话 fork)
  forkSession: "--fork-session",     // 只读继承,不污染源 session
  effort: "--effort",                // 思考强度(none/low/medium/high/xhigh/max),透传原生 --effort
  outputFormat: "--output-format",   // json,供解析
};

// ── 传给官方 codex CLI 的参数名,集中一处(同 CLI_FLAGS 的隔离意图)──
// codex 是另一套 harness(不是模型):spawn `codex exec` 子进程,GPT 在自家工具循环里干活。
// 这些字符串必须和当前 codex CLI(实测 codex-cli 0.136.0)认的一字不差,官方改参数只改这里。
// 子命令(exec/resume)和 flag(-m/-s/…)分两张表:前者是命令链、后者是选项,语义不同,别混。
const CODEX_SUBCOMMANDS = {
  exec: "exec",                      // 非交互子命令:`codex exec <task>`
  resume: "resume",                  // `codex exec resume <id>` 续 thread(注:不接受 -s/-C)
};
const CODEX_FLAGS = {
  model: "-m",                       // 指定模型(缺省用本机 config.toml 默认)
  sandbox: "-s",                     // read-only / workspace-write / danger-full-access
  cd: "-C",                          // 工作根目录(等价 claude 的 spawnCwd)
  skipGitCheck: "--skip-git-repo-check", // 允许非 git 目录运行(对齐 claude 的无所谓语义)
  json: "--json",                    // 事件流以 JSONL 打到 stdout(取 thread_id / usage)
  outputLast: "-o",                  // 最终消息写入指定文件(等价 claude 的 result)
  config: "-c",                      // 覆盖 config.toml 的键(如 model_reasoning_effort、sandbox_mode)
};

// 探测本机某个 CLI 是否可用(能跑 `<bin> --version` 且退出码 0)。惰性缓存到 bin 维度。
// 用于 harness 条目的 autoDetect:配置里声明了 harness 但本机没装对应 CLI 时,把条目标 disabled。
const _binAvailable = new Map();
function detectBin(bin) {
  if (_binAvailable.has(bin)) return _binAvailable.get(bin);
  let ok = false;
  try {
    const r = spawnSync(bin, ["--version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
    ok = r.status === 0;
  } catch { ok = false; }
  _binAvailable.set(bin, ok);
  return ok;
}

// codex 的默认条目模板 —— 仅当用户的 models.json 没有 codex 条目、但本机装了 codex 时,
// 作为"开箱即用"的兜底注入(等价于把 models.example.json 的 codex 示例条目内置一份)。
// 用户在 models.json 里显式配了 codex 就以用户为准,这个模板不参与。
// 它是"缺省模板"而非"唯一真相":描述/能力/needsProxy 都可被用户配置覆盖。
const CODEX_DEFAULT_ENTRY = {
  harness: "codex",
  model: null,                 // null = 用本机 ~/.codex/config.toml 的默认模型
  // 不写死 bin:让 resolveBin 走 GKD_CODEX_BIN env 兜底 → "codex",这样 env 覆盖对探测也生效。
  supportsVision: true,        // codex(GPT)接受图片输入
  needsProxy: true,            // codex 走公网、需要代理 → 保留用户环境的代理变量
  autoDetect: true,            // 本机没装 codex CLI 时自动标 disabled
};

// 解析 harness 条目的实际调用 bin:条目 bin 字段 > 环境变量兜底 > harness 默认名。
function resolveBin(m) {
  if (m.bin) return m.bin;
  if (m.harness === "codex") return process.env.GKD_CODEX_BIN || "codex";
  return process.env.GKD_CLAUDE_BIN || "claude";
}

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
  const models = raw.models;

  // 兜底:用户没在 models.json 配 codex → 注入默认模板条目(等价内置一份 example 的 codex 示例)。
  // 用户显式配了 codex 就以用户为准,不覆盖。这样"配置化"(条目可改)与"开箱即用"(装了就有)兼得。
  // 无条件注入(不看有没有装):装没装交给下面的 autoDetect 决定 disabled,这样本机没装 codex 时
  // `--codex` 会得到明确的"未检测到 codex CLI"禁用报错,而不是静默退化成默认模型跑一遍。
  if (!models.codex) {
    models.codex = { ...CODEX_DEFAULT_ENTRY };
  }

  // 可用性装饰:任何声明了 autoDetect 的条目,本机没装对应 CLI 就标 disabled(而非凭空消失)。
  // 这样 --help 里能看到"❌ --codex (禁用: 未检测到 codex CLI)",用户知道装了就能用,比静默注入更透明。
  for (const [, m] of Object.entries(models)) {
    if (m.autoDetect && !m.disabled && !detectBin(resolveBin(m))) {
      m.disabled = true;
      m.disabledReason = m.disabledReason || `本机未检测到 ${resolveBin(m)} CLI(或未登录)`;
    }
  }
  return models;
}

// ── 主对话 session jsonl 定位(供 --with-context 找文件)──────────────────
// Claude Code 把每个 session 的 jsonl 落在 ~/.claude/projects/<编码后的启动 cwd>/<sessionId>.jsonl。
// 用户在会话中 cd 后,jsonl 仍在启动 cwd 对应的项目目录里,不会跟 process.cwd() 同步。
// 所以 spawn 子进程时若直接继承漂移后的 cwd,claude --resume <id> 会按当前 cwd 编码找,找不到。
// 这里扫所有 projects 目录定位 jsonl,读首行的 cwd 字段,返回原始启动 cwd —— spawn 时把 child 的
// cwd override 成它,child claude 才能解析到正确的项目目录。
// 扫盘定位 session jsonl,返回 { cwd, jsonlPath }:cwd 是从 jsonl 首条带 cwd 的记录读到的原始
// 启动目录(用于钉住 child cwd),jsonlPath 是文件本身(codex C 档 import 需要把它交给 app-server)。
// 找不到返回 null。findSessionCwd 基于它实现,两者共用同一份扫盘逻辑。
// 按行流式扫描文件,对每行调 onLine;onLine 返回 true 即提前停止(关文件返回)。
// 避免对可能几十 MB 的 jsonl 做整文件 readFileSync —— 只读到满足条件那一刻。
// 读不到文件静默返回(调用方自行决定默认值)。
function scanLines(path, onLine) {
  let fd;
  try { fd = openSync(path, "r"); } catch { return; }
  try {
    const buf = Buffer.allocUnsafe(65536);
    // StringDecoder 跨块保留未完成的多字节序列:jsonl 单行(中文历史/中文目录 cwd)常超 64KiB,
    // 直接 buf.toString 会把切在块边界的多字节字符替换成 U+FFFD 污染内容(如钉错 spawnCwd)。
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let bytes;
    while ((bytes = readSync(fd, buf, 0, buf.length, null)) > 0) {
      carry += decoder.write(buf.subarray(0, bytes));
      let nl;
      while ((nl = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (onLine(line) === true) return;
      }
    }
    carry += decoder.end();
    if (carry) onLine(carry);
  } finally {
    closeSync(fd);
  }
}

function findSessionJsonl(sessionId) {
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
    let found = null;
    let scanned = 0;
    scanLines(jsonlPath, (ln) => {
      if (scanned++ >= 50) return true;  // 只扫前 50 行,拿不到 cwd 就放弃这个文件
      if (!ln) return false;
      try {
        const obj = JSON.parse(ln);
        if (typeof obj?.cwd === "string" && obj.cwd) { found = { cwd: obj.cwd, jsonlPath }; return true; }
      } catch { /* 单行损坏跳过 */ }
      return false;
    });
    if (found) return found;
  }
  return null;
}

function findSessionCwd(sessionId) {
  return findSessionJsonl(sessionId)?.cwd ?? null;
}

// 主对话 jsonl 里是否含图片输入(image content block)。--with-context 会把这段历史交给子进程
// (claude 分支 --resume --fork-session;codex 分支 import 成 thread),图片随之进入子进程的模型请求。
// 若子进程模型不支持视觉,含图请求会被端点拒绝(实测非 vision 端点返回 400)。所以带上下文委派前
// 据此判断:含图 → 该次委派必须落到 supportsVision 模型上。检测只看 image block 是否出现,不解码 data。
// 注:这只覆盖"图在主对话历史里"这一条路径;"子进程自己 Read 一个图片文件"runtime 无从预判
// (任务是纯文本,不知道会读什么),那条仍靠命令层约定 + 子进程自身报错兜底。
function jsonlHasImage(jsonlPath) {
  if (!jsonlPath || !existsSync(jsonlPath)) return false;
  // 逐行流式扫描(大历史 jsonl 可能几十 MB,不整文件读入);
  // 任一 user/assistant 消息的 content 数组里出现 type:"image" 即判含图。
  let hasImage = false;
  scanLines(jsonlPath, (ln) => {
    if (!ln || ln.indexOf('"image"') === -1) return false;  // 快速预筛:整行无 image 字样直接跳过
    try {
      const c = JSON.parse(ln)?.message?.content;
      if (Array.isArray(c) && c.some((b) => b?.type === "image")) { hasImage = true; return true; }
    } catch { /* 单行损坏跳过 */ }
    return false;
  });
  return hasImage;
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

// 倒序扫 delegations.jsonl,取第一条 sessionCwd===cwd 的行 → { sessionId, write, harness }。
// 等价于旧 readState()[cwd];链式续接每次 append 新行,倒序自然取最新 fork。
// harnessFilter:传了就只认该 harness 的行(老行无 harness 字段视为 "claude")。
// 为何要过滤:claude 和 codex 的 session 存储/续接机制完全不同(claude 扫 ~/.claude/projects
// 反查 jsonl,codex 靠 ~/.codex/sessions),续接时必须只认同 harness 的上次委派,否则
// 会拿 codex thread_id 去 claude 分支扫 jsonl → 硬失败(见 review 发现 A)。
function findLastDelegation(cwd, harnessFilter = null) {
  if (!existsSync(DELEGATIONS_FILE)) return null;
  try {
    const lines = readFileSync(DELEGATIONS_FILE, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const e = JSON.parse(lines[i]);
        if (!e.sessionId || e.sessionCwd !== cwd) continue;
        const h = e.harness || "claude";  // 老行无此字段,视为 claude
        if (harnessFilter && h !== harnessFilter) continue;
        return { sessionId: e.sessionId, write: !!e.write, harness: h };
      } catch { /* 单行损坏跳过 */ }
    }
  } catch { /* 文件读不到跳过 */ }
  return null;
}

// 从 delegations.jsonl 倒序找某 sessionId 的归属目录(sessionCwd)。
// 用于 codex 点名续接:codex 的 session 不在 ~/.claude/projects(findSessionCwd 扫不到),
// 只能靠 gkd 自己记的 sessionCwd 还原它属于哪个目录,避免把外部线程错记到当前 cwd。
function findSessionCwdInDelegations(sessionId) {
  if (!sessionId || !existsSync(DELEGATIONS_FILE)) return null;
  try {
    const lines = readFileSync(DELEGATIONS_FILE, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const e = JSON.parse(lines[i]);
        if (e.sessionId === sessionId && e.sessionCwd) return e.sessionCwd;
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
    effort: null,          // --effort:统一的思考强度旋钮(none/low/medium/high/xhigh/max)。claude harness 透传原生
                           //   --effort(none 就近映射为 low);codex harness 翻译成 model_reasoning_effort(全档原样透传)。
    codexModel: null,      // --codex-model:覆盖 codex 的模型(缺省用本机 config.toml 默认);仅 harness=codex 有意义
    json: false,
    help: false,
    quiet: false,
    task: [],
  };
  const RENDER_KINDS = ["review"];
  // 统一档位并集。实测(见 review):claude harness 接受 low/medium/high/xhigh/max;
  // codex(gpt-5.6-sol 后端)接受 none/low/medium/high/xhigh/max。两 harness 的构造器各自把不支持的
  // 档就近映射到最接近的支持档(none→low on claude),不报错不丢语义。minimal 两边都不真支持,故不收。
  const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--list-vision") opts.listVision = true;
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
    else if (a === "--effort") {
      const v = argv[++i];
      if (!v || !EFFORT_LEVELS.includes(v)) fail(`--effort 需要一个档位参数(${EFFORT_LEVELS.join("/")})`);
      opts.effort = v;
    }
    // --codex-effort 已并入统一的 --effort。显式识别并报迁移错误,而不是让它掉进 opts.task 兜底分支——
    // 否则旧用法会静默失效且把 flag 污染进任务正文(见 review)。
    else if (a === "--codex-effort") {
      fail("--codex-effort 已废弃,思考强度统一用 --effort <档>(none/low/medium/high/xhigh/max)");
    }
    else if (a === "--codex-model") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail("--codex-model 需要一个模型名参数");
      opts.codexModel = v;
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
    // codex 虚拟条目 model 为 null(用本机默认),展示成 "(codex 默认)";harness 非 claude 时标出。
    const modelName = v.model || (v.harness === "codex" ? "(codex 默认)" : "?");
    const hTag = v.harness && v.harness !== "claude" ? ` [harness:${v.harness}]` : "";
    const vTag = v.supportsVision ? " [vision]" : "";
    return `  ${tag} --${k.padEnd(12)} ${modelName.padEnd(24)}${hTag}${vTag} ${v.disabled ? "(禁用: " + (v.disabledReason || "") + ")" : ""}`;
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
  --list-vision         打印支持视觉的模型 key(空格分隔),供命令文件注入;不跑委派
  --effort <档>         思考强度(none/low/medium/high/xhigh/max);两 harness 通用(claude 上 none 就近取 low)
  --codex-model <名>    仅 --codex:覆盖 codex 模型(缺省用本机 config.toml 默认)
  --json                结构化输出(供 workflow 消费)
  --help, -h            打印此帮助
`);
}

// ── harness 派发:按所选模型的 harness 字段选构造器 ────────────────────
// 缺省 harness = "claude"(现状:spawn claude -p 换 BASE_URL);harness=="codex" 走 buildCodexSpawn。
// 两个构造器返回统一形状,供 main() 无差别 spawn:
//   { cli, args, envOverride, spawnCwd, stateCwd, parentSessionId, harness, outFile? }
// async:codex C 档要 await 一次性 import。claude 分支同步,但 async 函数里直接 return 同步值无妨。
async function buildSpawn(opts, cwd, models) {
  const m = models[opts.model];
  if (!m) {
    fail(`未知模型别名: ${opts.model}。可用: ${Object.keys(models).join(", ")}`);
  }
  if (m.disabled) {
    fail(`模型 ${opts.model}(${m.model || m.harness || "?"})当前不可用:${m.disabledReason || "(未注明原因)"}`);
  }
  if (m.harness === "codex") return buildCodexSpawn(opts, cwd, m);
  return buildClaudeSpawn(opts, cwd, m);
}

// ── codex harness:spawn `codex exec` 子进程 ──────────────────────────
// 与 claude 分支的返回形状一致。差异点:
//   · 结果不走 stdout JSON,而是 -o 写临时文件(main 读它当 result)
//   · session_id / usage 从 --json 的 JSONL 事件流里取(main 解析)
//   · 读写靠 sandbox 三档(-s),不是 allowed-tools
//   · resume 走 `codex exec resume <id>`,该子命令不接受 -s/-C(见下注释)
//   · C 档 --with-context:先把主对话 jsonl 导入成 codex thread(一次性 app-server import),
//     再走和 B 档点名续接完全相同的 `codex exec resume <thread_id>` 路径。故本函数是 async。
async function buildCodexSpawn(opts, cwd, m) {
  const outFile = join(tmpdir(), `gkd-codex-${process.pid}-${Date.now()}.txt`);
  const args = [CODEX_SUBCOMMANDS.exec];

  // 上下文档:A(默认新起)/ B(--resume 续 codex thread)/ C(--with-context 导入主对话再续)。
  // B 和 C 都归到「续某个 codex thread」这条路径(resuming),差别只在 thread_id 从哪来:
  //   B 点名 → opts.resumeId;B 续上次 → delegations 里本目录最近一条;C → 导入主对话得到的新 thread。
  let parentSessionId = null;
  let stateCwd = cwd;   // 新委派记账到调用目录;续接改记原 thread 的归属目录(见下)
  const resuming = opts.resume || opts.withContext;
  if (resuming) {
    // codex 的 session 存 ~/.codex/sessions,按 thread_id 续。
    args.push(CODEX_SUBCOMMANDS.resume);
    if (opts.withContext) {
      // C 档:导入主 Claude 当前对话历史成 codex thread,再续它。
      const mainSession = process.env.CLAUDE_CODE_SESSION_ID;
      if (!mainSession) {
        fail("--with-context 需要主对话 session-id,但未找到 CLAUDE_CODE_SESSION_ID");
      }
      // 定位主对话 jsonl:扫盘拿 { cwd: originCwd, jsonlPath }。用户会话期间可能 cd 漂移过,
      // jsonl 仍在启动 cwd 那一档。import 时把 cwd 传 originCwd(与 claude 分支 spawnCwd=originCwd
      // 对齐),让导入 thread 的工作目录 = 历史发生处,后续 resume 的 cwd 才和历史里的文件路径一致。
      const found = findSessionJsonl(mainSession);
      if (!found) {
        fail(`--with-context 找不到主 session ${mainSession.slice(0, 8)}... 的 jsonl 文件(扫遍 ~/.claude/projects/*)。可能 session 还没落盘,或文件被清理了。`);
      }
      // 视觉护栏:主对话含图但选定模型不支持视觉 → 提前 fail(与 claude 分支一致)。
      if (jsonlHasImage(found.jsonlPath) && !m.supportsVision) {
        fail(`主对话含图片输入,但模型 ${opts.model} 不支持视觉(models.json 未标 supportsVision:true)。请改用支持视觉的模型(如 --kimi / --gpt / --codex)后重试。`);
      }
      const originCwd = found.cwd;
      if (!opts.quiet) {
        process.stderr.write(`[gkd] --with-context: 正在把主对话导入 codex thread(约 1-2s)…\n`);
      }
      let importedThreadId;
      try {
        importedThreadId = await importClaudeSessionToCodex(found.jsonlPath, originCwd, {
          bin: resolveBin(m),
          quiet: opts.quiet,
        });
      } catch (e) {
        // 导入失败不静默降级成 A 档(那会让用户以为继承了上下文其实没有),直接 fail 带诊断。
        fail(`--with-context 导入主对话到 codex 失败:${e.message}`);
      }
      args.push(importedThreadId);
      // parentSessionId 保持 null(与 claude 分支 C 档一致):不把主 Claude 的 session-id 混进
      // codex 的 fork 链字段。C 档 fork 链天然不参与回溯(imported thread 不留 delegations 档),
      // 续本目录上次仍靠 sessionCwd 索引可用。
      stateCwd = originCwd;  // fork 出的委派记到主对话归属目录,与 claude C 档语义一致
    } else if (opts.resumeId) {
      parentSessionId = opts.resumeId;
      args.push(opts.resumeId);
      // 关键:点名续接的 thread 真实 cwd 从原 thread 继承(codex resume 不接受 -C),
      // 若把新记录的 sessionCwd 记成"当前 cwd",会污染索引——之后在当前目录不带 id 续接
      // 会续到这条外部 thread,写模式下改错仓库(见 review 发现)。故从 delegations 反查
      // 原 thread 的归属目录沿用;查不到则保持 cwd(至少不比旧行为差,但发一条告警)。
      const originCwd = findSessionCwdInDelegations(opts.resumeId);
      if (originCwd) {
        stateCwd = originCwd;
      } else if (!opts.quiet) {
        process.stderr.write(`[gkd] ⚠ 点名续 codex 线程 ${opts.resumeId.slice(0, 8)}... 在 gkd 记录里查不到归属目录,本次仍记到当前目录;后续在此目录不带 id 的 --codex --resume 可能续到它,建议续接时显式带 threadId\n`);
      }
    } else {
      // 续本目录上次:从 gkd 自己的 delegations 取本目录最近一条 codex thread_id 显式传,
      // 而不是用 codex 的 `--last`——后者是"codex CLI 全局最近一次",可能是用户在别的目录
      // 或终端里直接跑的 codex,与 gkd 的"续本目录上次委派"语义不符(见 review 发现)。
      const last = findLastDelegation(cwd, "codex");
      if (!last) {
        fail("--resume 找不到本目录上次的 codex 委派线程。若要点名续历史,传 --resume <threadId>;或去掉 --resume 开新委派。");
      }
      parentSessionId = last.sessionId;
      args.push(last.sessionId);
      // 续本目录上次:last 就是本 cwd 的记录,stateCwd 保持 cwd 正确。
    }
  }

  // 模型:--codex-model 覆盖 > 条目 model(缺省 null)> 不传(用本机默认)
  const model = opts.codexModel || m.model;
  if (model) args.push(CODEX_FLAGS.model, model);

  // reasoning effort:统一的 --effort 翻译成 codex 的 model_reasoning_effort。
  // 实测(codex-cli 0.144.3 / gpt-5.6-sol 后端):支持 none/low/medium/high/xhigh/max,唯独不认 minimal。
  // 统一集正好是它的子集(minimal 已从统一集剔除),故全部原样透传——max 不再封顶(它原生支持)。
  // 注:--codex-model 若指向能力更弱的模型,理论上某档可能被后端 400;那属于该模型的能力边界,
  // 交给 codex 自身报错(它的 unsupported_value 信息已足够清晰),不在这里按模型硬编码档位表。
  if (opts.effort) {
    args.push(CODEX_FLAGS.config, `model_reasoning_effort="${opts.effort}"`);
  }

  // 读写边界 → sandbox。统一走 -c sandbox_mode(不用 -s):因为 `codex exec resume` 不接受 -s,
  // 而 -c sandbox_mode 新起/续接都认,是 -s 的底层等价开关。统一走它消除 resume/新起的分叉。
  const sandboxMode = opts.write ? "workspace-write" : "read-only";
  args.push(CODEX_FLAGS.config, `sandbox_mode="${sandboxMode}"`);

  // 工作根目录:codex 的两条硬约束都在这——`codex exec resume` 不接受 -C(cwd 从原 thread 继承),
  // 故仅新起时用 -C 钉到调用 cwd。--skip-git-repo-check 两路都加:非 git/非信任目录下不加会直接
  // "Not inside a trusted directory" 失败(resume 也校验信任目录)。
  if (!resuming) {
    args.push(CODEX_FLAGS.cd, cwd);
  }
  args.push(CODEX_FLAGS.skipGitCheck);

  // review 结构化:不用 codex 的 --output-schema。
  // 原因:codex 的 --output-schema 走 OpenAI strict JSON schema 校验,要求 `required` 覆盖
  // properties 里每个 key;而 gkd 的 review-output.schema.json 故意留可选字段(priority/confidence
  // 分别只在缺陷式/对抗式必填),strict 模式直接 400 invalid_json_schema。
  // 故 codex review 与 claude 侧走同一条路:靠 prompt 模板(--prompt-file 前置拼)要求吐 JSON,
  // 再由 renderReviewResult 启发式提取——它本就为便宜模型的脏 JSON 设计,足够稳。

  args.push(CODEX_FLAGS.json);
  args.push(CODEX_FLAGS.outputLast, outFile);

  // --prompt-file:codex exec 无 --append-system-prompt,把模板内容前置拼进任务文本。
  let taskText = opts.task;
  if (opts.promptFile) {
    taskText = `${loadPromptFile(opts.promptFile)}\n\n---\n\n${taskText}`;
  }
  // codex exec 的任务文本是位置参数,必须放在所有 flag 之后的最后。resume 时它是续接后要发的新指令。
  if (taskText) args.push(taskText);

  return {
    cli: resolveBin(m),     // 条目 bin > GKD_CODEX_BIN > "codex"
    args,
    envOverride: {},        // codex 用本机登录态(~/.codex/auth.json),不注入 BASE_URL/TOKEN
    spawnCwd: null,         // 用 -C 显式指定 cwd(resume 除外),不靠 child cwd
    stateCwd,               // 新委派=调用目录;点名续接=原 thread 归属目录(防索引污染)
    parentSessionId,
    harness: "codex",
    outFile,
    needsProxy: proxyNeeded(m),  // codex 默认 needsProxy:true → 保留用户代理(走公网需要)
  };
}

// 读 --prompt-file 内容,读不到直接 fail。两个 build 分支共用,避免逻辑重复。
function loadPromptFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    fail(`--prompt-file 读取失败 ${path}: ${e.message}`);
  }
}

// 归一化"这个模型是否需要保留用户代理"。needsProxy 是当前字段;兼容早期引入过的 clearProxy
// (clearProxy===false 等价 needsProxy===true)。默认 false = 不需要特殊代理 → childEnv 会清代理。
function proxyNeeded(m) {
  if (typeof m.needsProxy === "boolean") return m.needsProxy;
  if (m.clearProxy === false) return true;   // 兼容旧配置字段
  return false;
}

// ── claude harness(现状):spawn `claude -p --model` 换 BASE_URL ────────
function buildClaudeSpawn(opts, cwd, m) {

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

  const args = [CLI_FLAGS.print, opts.task];
  // 换脑:唯一可靠开关
  args.push(CLI_FLAGS.model, m.model);
  // 排除 user settings(避免主环境配置污染),认证来自继承的 shell env
  args.push(CLI_FLAGS.settingSources, "project");

  // 思考强度:透传原生 --effort。CLI 会写进请求体 output_config.effort 发给网关
  // (实测 gpt/glm/kimi 等非 claude-* 模型名照发)。
  // claude 原生只认 low/medium/high/xhigh/max,不认 codex 独有的 none —— none 就近映射为 low(最低档)。
  if (opts.effort) {
    const claudeEffort = opts.effort === "none" ? "low" : opts.effort;
    args.push(CLI_FLAGS.effort, claudeEffort);
  }

  // --prompt-file:把模板文件内容作为前置系统指令注入(主 token 零经手)。
  // 用于 review 等"角色/立场指令固定"的场景——指令沉在文件里,不靠主 Claude 现拼进任务文本。
  if (opts.promptFile) {
    args.push(CLI_FLAGS.appendSystemPrompt, loadPromptFile(opts.promptFile));
  }

  // 读写权限
  const tools = opts.allowedTools
    ? opts.allowedTools.split(/\s+/)
    : opts.write
      ? ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]
      : ["Read", "Grep", "Glob"];
  args.push(CLI_FLAGS.allowedTools, ...tools);
  args.push(CLI_FLAGS.permissionMode, opts.write ? "acceptEdits" : "default");

  // (--with-context 与 --resume 互斥的校验已上提到 main(),claude/codex 共用一处。)

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
    const foundJsonl = findSessionJsonl(mainSession);
    if (!foundJsonl) {
      fail(`--with-context 找不到主 session ${mainSession.slice(0, 8)}... 的 jsonl 文件(扫遍 ~/.claude/projects/*)。可能 session 还没落盘,或文件被清理了。`);
    }
    const sessionOriginCwd = foundJsonl.cwd;
    // 视觉护栏:主对话含图但选定模型不支持视觉 → 提前 fail(否则子进程含图请求会被端点 400 拒)。
    if (jsonlHasImage(foundJsonl.jsonlPath) && !m.supportsVision) {
      fail(`主对话含图片输入,但模型 ${opts.model} 不支持视觉(models.json 未标 supportsVision:true)。请改用支持视觉的模型(如 --kimi / --gpt / --codex)后重试。`);
    }
    if (sessionOriginCwd !== cwd) {
      process.stderr.write(`[gkd] --with-context: 检测到 cwd 漂移(用户 ${cwd} → 原 session ${sessionOriginCwd}),已 override 子进程 cwd 以定位 session 文件\n`);
    }
    spawnCwd = sessionOriginCwd;
    stateCwd = sessionOriginCwd;  // fork 出的 session 落在主对话归属目录,state/usage 的 sessionCwd 须与之一致
    args.push(CLI_FLAGS.resume, mainSession, CLI_FLAGS.forkSession);
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
    args.push(CLI_FLAGS.resume, sid, CLI_FLAGS.forkSession);
  }
  // A 档:什么都不加

  args.push(CLI_FLAGS.outputFormat, "json");
  return {
    cli: resolveBin(m),   // 条目 bin > GKD_CLAUDE_BIN > "claude"
    args,
    envOverride: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: authToken, ...modelEnv },
    spawnCwd,
    stateCwd,
    parentSessionId,
    harness: "claude",
    outFile: null,
    needsProxy: proxyNeeded(m),  // 默认 false → childEnv 清代理;需要代理的端点在条目里设 needsProxy:true
  };
}

function fail(msg) {
  process.stderr.write(`[gkd] 错误: ${msg}\n`);
  process.exit(1);
}

// 组装子进程 env。override 用于按所选模型注入 BASE_URL/AUTH_TOKEN(不同模型可能走不同端点)。
// needsProxy:这个端点是否需要走用户环境里的代理,默认 false。
//   默认清代理:某些 API 端点走系统/企业代理会被拦截或劫持,清掉代理变量让子进程直连更稳。
//   走公网、确实需要代理才能连通的端点(如 codex)在 config/models.json 的条目里设
//   `"needsProxy": true`,子进程就保留用户的 HTTP(S)_PROXY 等变量(per-model 配置,不在代码里按
//   harness 写死)。codex 默认条目已带 needsProxy:true。
function childEnv(override = {}, needsProxy = false) {
  const env = { ...process.env, ...override };
  if (!needsProxy) {
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                      "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      delete env[k];
    }
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
// async:codex C 档在 buildSpawn 里要 await 一次性 import。
async function main() {
  const models = loadModels();
  const opts = parseArgs(process.argv.slice(2), Object.keys(models));
  const cwd = process.cwd();

  if (opts.help) { printHelp(models); process.exit(0); }
  // --list-vision:吐出支持视觉的模型 key(空格分隔),供命令文件用 `!` 注入,免得主 Claude 自己读 models.json。
  // 基于 loadModels() 合并后的注册表,所以自动注入的 codex 也在内(修了命令文件写死列表会漏 codex 的洞)。
  if (opts.listVision) {
    const vis = Object.entries(models)
      .filter(([, m]) => m.supportsVision && !m.disabled)
      .map(([k]) => `--${k}`);
    process.stdout.write(vis.length ? vis.join(" ") : "(当前无支持视觉的可用模型)");
    process.exit(0);
  }
  if (!opts.model) opts.model = pickDefaultModel(models);

  migrateLegacyState();  // 幂等:首次运行把老 usage.jsonl+sessions.json 合并成 delegations.jsonl

  if (!opts.task && !opts.resume) {
    fail("缺少任务文本。运行 gkd-runtime --help 查看用法。");
  }

  // --with-context 与 --resume 互斥(不论带不带 id):前者续主对话、后者续委派子进程。
  // claude/codex 共用一处校验,且必须在下面的 resume harness 校验/写模式恢复之前——否则同传
  // 两者时可能先报"找不到上次委派"而非互斥错误,对用户毫无指向性。
  if (opts.withContext && opts.resume) {
    fail("--with-context 不能和 --resume 同时使用:要么续委派线程(--resume [<id>]),要么从主对话 fork(--with-context),二选一");
  }

  // 当前所选模型的 harness(缺省 claude)。resume 续接必须按它过滤上次委派记录:
  // claude 和 codex 的 session 存储/续接机制不同,续错 harness 会硬失败(见 review 发现 A)。
  const selectedHarness = models[opts.model]?.harness || "claude";

  // --resume 且不点名(续本目录上次)时,先校验上次委派的 harness 与当前所选一致。
  // 不一致就 fail 并给出可操作提示,而不是让 buildClaudeSpawn 拿 codex thread_id 去扫
  // ~/.claude/projects 报"找不到 jsonl"(那个报错对用户毫无指向性)。
  if (opts.resume && !opts.resumeId) {
    const last = findLastDelegation(cwd);  // 不过滤,先看本目录最新一条到底是谁
    if (last && last.harness !== selectedHarness) {
      fail(`本目录上次委派是 ${last.harness} harness,但当前要用 ${selectedHarness} 续接——两者 session 机制不同,不能混续。` +
           `请用 ${last.harness === "codex" ? "--codex" : "Claude 系模型"} 续接上次,或开一条新委派(不加 --resume)。`);
    }
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
      // 按 harness 过滤取本目录上次(harness 一致性已在上面校验过,这里过滤是为跨 harness 交错
      // 委派时取到正确的那条 write 模式,而非最新但异 harness 的一条)。
      const last = findLastDelegation(cwd, selectedHarness);
      if (last?.write) {
        opts.write = true;
        if (!opts.quiet) process.stderr.write(`[gkd] 续会话:从上次继承写模式\n`);
      }
    }
  }

  const { cli, args: childArgs, envOverride, spawnCwd, stateCwd, parentSessionId, harness, outFile, needsProxy } = await buildSpawn(opts, cwd, models);

  const startMs = Date.now();
  const child = spawn(cli, childArgs, {
    // 是否保留代理由模型条目的 needsProxy 决定(默认清代理),见 childEnv 注释。
    env: childEnv(envOverride, needsProxy),
    stdio: ["ignore", "pipe", "pipe"],
    cwd: spawnCwd || undefined,  // null/undefined = 继承父进程 cwd(默认行为)
  });

  // stdout/stderr 累加设上限:子进程输出失控(死循环打印/二进制流)时无限拼接会 OOM。
  // 达上限即杀子进程并记明确失败——不静默截断 stdout(claude 单体 JSON 被截会变成误导性的
  // "解析失败",看着像模型坏了实则是我们截的)。stderr 保留尾部供诊断。
  const MAX_STDOUT = 32 * 1024 * 1024;  // 32 MiB
  const MAX_STDERR = 4 * 1024 * 1024;   // 4 MiB
  // 子进程总时限:模型无响应/网络卡死时,没有兜底 main 会永远等 close,gkd 整体僵死。
  // 显式判空(而非 ||):Number("0")=0 是 falsy 会被 || 吞掉;约定 <=0 = 禁用超时(不设 killTimer),
  // 供已知会超 30 分钟的长任务显式关兜底。非法值(NaN)回落默认。
  const envTimeout = Number(process.env.GKD_TIMEOUT_MS);
  const TIMEOUT_MS = Number.isFinite(envTimeout) ? envTimeout : 30 * 60 * 1000;  // 默认 30 分钟
  const KILL_GRACE_MS = 5000;  // SIGTERM 后宽限,再 SIGKILL

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;         // 按字节累计(非 .length 的 UTF-16 码元),用于对齐 MiB 上限语义
  let abortReason = null;      // 非 null = 我们主动杀的(timeout/overflow),close 时据此判失败
  let killTimer = null;
  let graceTimer = null;

  // SIGTERM → 宽限 → SIGKILL。reason 记下来供 close 归一成失败结果。
  function abort(reason) {
    if (abortReason) return;   // 已在中止流程中,不重复
    abortReason = reason;
    try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
    graceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, KILL_GRACE_MS);
  }

  if (TIMEOUT_MS > 0) {
    const timeoutLabel = TIMEOUT_MS >= 60000 ? `${Math.round(TIMEOUT_MS / 60000)} 分钟` : `${Math.round(TIMEOUT_MS / 1000)} 秒`;
    killTimer = setTimeout(() => abort(`子进程超时(>${timeoutLabel}无完成),已终止`), TIMEOUT_MS);
  }

  child.stdout.on("data", (d) => {
    if (abortReason) return;   // 已在中止流程中:停止收集,别在 SIGKILL 落地前的宽限窗口里继续膨胀
    stdoutBytes += d.length;   // d 是 Buffer,.length 即字节数
    stdout += d;
    if (stdoutBytes > MAX_STDOUT) abort(`子进程 stdout 超过 ${Math.round(MAX_STDOUT / 1048576)}MiB 上限,已终止`);
  });
  child.stderr.on("data", (d) => {
    if (abortReason) return;
    stderr += d;
    // 只保尾部,不因日志刷屏 OOM。按字符裁剪(诊断用,精度无所谓),4MiB 字符量级足够。
    if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR);
  });

  // finishOnce:timeout/overflow/close/error 可能交叉触发,收尾逻辑(清 timer、清临时文件、
  // 落 delegation、输出、退出)必须且只跑一次。
  let finished = false;
  function clearTimers() {
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  }

  child.on("error", (e) => {
    if (finished) return;
    finished = true;
    clearTimers();
    // 启动失败时 parseCodexOutput 不会跑,outFile 若已建则残留,这里兜底清。
    if (outFile) { try { unlinkSync(outFile); } catch { /* 可能还没建 */ } }
    fail(`无法启动 ${harness} 子进程(${cli}): ${e.message}`);
  });

  child.on("close", (code) => {
    if (finished) return;
    finished = true;
    clearTimers();
    // 两个 harness 归一成同一形状:{ result, sessionId, isError, usage, modelUsed }。
    // usage = { "<model名>": { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } },
    // 与 delegations.jsonl / gkd-stats 期望的 camelCase shape 一致。
    let norm = harness === "codex"
      ? parseCodexOutput(stdout, stderr, outFile, code, { modelOverride: opts.codexModel, quiet: opts.quiet })
      : parseClaudeOutput(stdout, stderr, code);

    // 我们主动杀的(超时/输出超限):判失败,但别丢弃子进程已完整产出的结果。
    // 竞态——killTimer 到点的同一刻子进程恰好已把完整 JSON 写完并正常退出,parse 能拿到成功
    // result;此时只标 isError(让 delegation 记 ok:false)、把 abort 原因追加到 result 尾部,
    // 产出仍可达,不让用户白烧 token。只有 parse 本就失败/无 result 时才整体替换成原因串。
    if (abortReason) {
      norm = norm.result && !norm.isError
        ? { ...norm, result: `${norm.result}\n\n[gkd] ${abortReason}`, isError: true }
        : { ...norm, result: abortReason, isError: true };
    }

    // 只追加一条 delegation 行:其 sessionCwd 字段兼任「续本目录上次」的索引(取代旧 sessions.json)。
    appendDelegation({
      ts: new Date().toISOString(),
      sessionId: norm.sessionId,  // 供 findSessionMode 反查 mode / findLastDelegation 续本目录上次
      // task = 委派原始任务摘要,供模糊检索。resume 行的 opts.task 是补充指令(非原始意图),
      // 写 null 保持语义纯净——该 session 的原始任务已记在它 spawn 那行。
      task: opts.resume ? null : makeTaskPreview(opts.task),
      parentSessionId,  // B 档 fork 自哪个 session(A/C 档为 null);串起 fork 链,检索时可回溯到最新节点
      modelKey: opts.model,
      model: norm.modelUsed,
      harness,           // "claude"(缺省)/"codex";老行无此字段,读取方视为 claude
      mode: opts.withContext ? "with-context" : opts.resume ? "resume" : "clean",
      write: opts.write,
      cwd,                 // 调用时的当前目录
      sessionCwd: stateCwd, // session 真实归属目录(跨目录续时 ≠ cwd),兼任续本目录上次的索引键
      ok: !norm.isError,
      durationMs: Date.now() - startMs,
      usage: norm.usage,
    });

    if (opts.json) {
      // 结构化输出,供命令/workflow 消费
      process.stdout.write(JSON.stringify({
        ok: !norm.isError,
        model: norm.modelUsed,
        sessionId: norm.sessionId,
        result: norm.result,
      }, null, 2) + "\n");
    } else {
      // 人类可读:结果 + 一行元信息(--quiet 时压制,供 brainstorm 等下游脚本干净消费 stdout)
      // --render review:把子进程 result(应为 JSON)渲染成干净报告;提取/校验失败则原文降级。
      const humanOut = opts.render === "review" ? renderReviewResult(norm.result) : norm.result;
      process.stdout.write(humanOut + "\n");
      if (!opts.quiet) {
        const tag = norm.isError ? "❌ 失败" : "✅";
        process.stderr.write(`\n[gkd] ${tag} | harness: ${harness} | 实际模型: ${norm.modelUsed.join(",") || "?"} | session: ${norm.sessionId || "?"}\n`);
      }
    }
    process.exit(norm.isError ? 1 : 0);
  });
}

// ── claude 输出解析:stdout 是单个 JSON 对象 ───────────────────────────
function parseClaudeOutput(stdout, stderr, code) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // 不 fail():子进程已跑完(可能烧了 token),此处直接退出会让 close 回调里的 appendDelegation
    // 落不了盘,session/cost 记录丢失、续接链断环。改为返回 isError 的归一结果,让调用方统一
    // 落一行(ok:false)再输出+退出。sessionId 为 null——非 JSON 输出里拿不到,该次无法被续接。
    return {
      result: `子进程输出非 JSON(exit ${code}):\n${stdout.slice(0, 500)}\n${stderr.slice(0, 300)}`,
      sessionId: null,
      isError: true,
      usage: {},
      modelUsed: [],
    };
  }
  return {
    result: parsed.result ?? "",
    sessionId: parsed.session_id,
    isError: !!parsed.is_error,
    usage: parsed.modelUsage ?? {},
    modelUsed: parsed.modelUsage ? Object.keys(parsed.modelUsage) : [],
  };
}

// ── codex 输出解析:result 在 -o 文件,session_id/usage 在 stdout 的 JSONL 事件流 ──
// 事件形态(实测 codex-cli 0.136.0):
//   {"type":"thread.started","thread_id":"<uuid>"}                          ← session id
//   {"type":"item.completed","item":{"type":"agent_message","text":...}}    ← 最终消息(也写进 -o)
//   {"type":"item.completed","item":{"type":"error","message":...}}         ← 报错
//   {"type":"turn.completed","usage":{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}
function parseCodexOutput(stdout, stderr, outFile, code, { modelOverride = null, quiet = false } = {}) {
  let sessionId = null;
  let rawUsage = null;
  let turnCompleted = false;
  let turnFailed = false;
  let turnFailMsg = "";     // turn.failed 事件里的错误消息(若有)
  let lastAgentMsg = "";
  let lastErrorItem = "";   // item.type==="error" 的消息(多为 warning,但真失败时是唯一线索)
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }  // 非 JSON 行(告警等)跳过
    if (ev.type === "thread.started" && ev.thread_id) sessionId = ev.thread_id;
    else if (ev.type === "turn.completed") { turnCompleted = true; if (ev.usage) rawUsage = ev.usage; }
    else if (ev.type === "turn.failed") { turnFailed = true; turnFailMsg = ev.error?.message || ev.message || ""; }
    else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
      lastAgentMsg = ev.item.text;
    }
    else if (ev.type === "item.completed" && ev.item?.type === "error" && typeof ev.item.message === "string") {
      lastErrorItem = ev.item.message;
    }
    // 注意:item.type==="error" 不作为失败信号——codex 把 config deprecation 之类的
    // warning 也塞成 error item(实测 `[features].codex_hooks` deprecated),退出码仍为 0、
    // turn 照常 completed。真失败看退出码 / turn.failed / 拿不到结果。
  }

  // result:优先读 -o 文件(codex 保证最终消息在此);读不到回落 stdout 里最后的 agent_message。
  let result = "";
  if (outFile) {
    try { result = readFileSync(outFile, "utf8").trim(); } catch { /* 回落 */ }
    try { unlinkSync(outFile); } catch { /* 临时文件,清理失败无妨 */ }
  }
  if (!result) result = lastAgentMsg;

  // is_error 判定。成功的必要条件:退出码 0、无 turn.failed、且拿到 sessionId + turn.completed。
  // 为何把 sessionId/turn.completed 列为硬条件(而非"有结果就算成功"):codex CLI 升级若改了
  // 事件字段名(如 thread_id → 别的),我们会解析不到 sessionId,但 -o 文件仍可能有内容——
  // 那样会静默记 ok=true + sessionId=null,续接链断裂、stats 缺 usage 却毫无征兆(见 review 发现)。
  // 宁可在 schema 漂移时明确报失败 + 诊断,让问题浮出来,也不要静默半成功。
  // schemaBroken 已覆盖"code0 且缺 sessionId/turn.completed"的全部情形;而 code≠0 / turn.failed
  // 单独列出。原先还有个 (!turnCompleted && !result) 是死分支——!turnCompleted 时要么 schemaBroken
  // 已 true(code0),要么前两项已 true(code≠0/failed),恒被覆盖,故删去。
  const schemaBroken = code === 0 && !turnFailed && (!sessionId || !turnCompleted);
  const isError = code !== 0 || turnFailed || schemaBroken;

  // 失败但没拿到有效结果时,把诊断线索塞进 result,别让用户看到空白 ❌(见 review 发现 B)。
  // codex 的启动/认证/参数错误常只写 stderr(如未登录、版本不支持 -c sandbox_mode、sandbox 拒绝);
  // 优先级:turn.failed 消息 > error item 消息 > schema 漂移提示 > stderr 尾部。都截断防刷屏。
  if (isError && !result) {
    let diag = turnFailMsg || lastErrorItem;
    if (!diag && schemaBroken) {
      diag = `codex 事件流缺少 ${!sessionId ? "thread.started/thread_id" : "turn.completed"}——可能 codex CLI 版本升级改了事件格式,gkd 的解析(parseCodexOutput)需同步更新。`;
    }
    diag = diag || stderr.trim() || `codex 子进程退出码 ${code},无输出`;
    result = `[gkd] codex 委派失败(exit ${code}):\n${diag.slice(0, 1500)}`;
  } else if (isError && schemaBroken && !quiet) {
    // 有结果但 schema 漂移:结果照给,但 stderr 明确警示,别让 sessionId=null 静默进 delegations。
    process.stderr.write(`[gkd] ⚠ codex 事件流缺少 ${!sessionId ? "sessionId" : "turn.completed"},本次判为失败(结果仍返回);疑似 codex CLI 事件格式变更,parseCodexOutput 需更新\n`);
  }

  // 实际模型名:--codex-model 显式指定则用它,否则标 "codex"(事件流不反解模型名)。
  // 模型身份与 usage 是否存在解耦:即便没拿到 usage 也返回模型名,usage 单独为空对象。
  const modelName = modelOverride || "codex";
  const usage = rawUsage ? {
    [modelName]: {
      inputTokens: Number(rawUsage.input_tokens ?? 0),
      outputTokens: Number(rawUsage.output_tokens ?? 0),
      cacheReadInputTokens: Number(rawUsage.cached_input_tokens ?? 0),
      cacheCreationInputTokens: 0,  // codex 不区分 cache creation
    },
  } : {};

  return { result, sessionId, isError, usage, modelUsed: [modelName] };
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
  main().catch((e) => fail(e?.stack || e?.message || String(e)));
}

export { extractReviewJson, validateReviewShape, renderReview, renderReviewResult };
