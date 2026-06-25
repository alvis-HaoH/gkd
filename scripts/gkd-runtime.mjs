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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

// ── 状态文件(记录上次子进程 session-id,供 --resume 用,按 cwd 区分)──────
const STATE_DIR = join(homedir(), ".claude", "gkd");
const STATE_FILE = join(STATE_DIR, "sessions.json");
const USAGE_FILE = join(STATE_DIR, "usage.jsonl");

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeLastSession(cwd, sessionId, mode) {
  if (!sessionId) return;
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const state = readState();
  state[cwd] = { sessionId, mode: mode === "write" ? "write" : "read", ts: new Date().toISOString() };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// 每次委派的 token 用量追加一行 JSONL,供 /gkd:stats 统计。失败不让 runtime 崩。
function writeUsageLog(entry) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(USAGE_FILE, JSON.stringify(entry) + "\n");
  } catch (e) {
    process.stderr.write(`[gkd] 写 usage 日志失败(忽略): ${e.message}\n`);
  }
}

// ── 参数解析 ──────────────────────────────────────────────────────────
// modelKeys:从 models.json 动态读出的合法模型 key 集合,任意 --<key> 都识别
function parseArgs(argv, modelKeys) {
  const opts = {
    model: null,           // 由 main 在解析后兜底成默认
    write: false,
    resume: false,
    withContext: false,
    allowedTools: null,
    json: false,
    help: false,
    quiet: false,
    task: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--write") opts.write = true;
    else if (a === "--resume") opts.resume = true;
    else if (a === "--with-context") opts.withContext = true;
    else if (a === "--allowed-tools") opts.allowedTools = argv[++i];
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
  --model <name>        同上,可指定不在 models.json 里的别名
  --write               允许子进程改文件(默认只读)
  --resume              续上次本目录的委派线程(B 档)
  --with-context        让子进程加载主对话历史(C 档,需 CLAUDE_CODE_SESSION_ID)
  --allowed-tools "..." 自定义工具列表
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

  // 读写权限
  const tools = opts.allowedTools
    ? opts.allowedTools.split(/\s+/)
    : opts.write
      ? ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]
      : ["Read", "Grep", "Glob"];
  args.push("--allowed-tools", ...tools);
  args.push("--permission-mode", opts.write ? "acceptEdits" : "default");

  // 上下文三档
  let spawnCwd = null;  // 默认 null = 继承父进程 cwd
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
    args.push("--resume", mainSession, "--fork-session");
  } else if (opts.resume) {
    // B 档:续上次本工具的委派线程
    const last = readState()[cwd]?.sessionId;
    if (!last) {
      fail("--resume 找不到上次的委派线程(本目录还没委派过)");
    }
    args.push("--resume", last, "--fork-session");
  }
  // A 档:什么都不加

  args.push("--output-format", "json");
  return {
    args,
    envOverride: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: authToken, ...modelEnv },
    spawnCwd,
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

// ── 主流程 ────────────────────────────────────────────────────────────
function main() {
  const models = loadModels();
  const opts = parseArgs(process.argv.slice(2), Object.keys(models));
  const cwd = process.cwd();

  if (opts.help) { printHelp(models); process.exit(0); }
  if (!opts.model) opts.model = pickDefaultModel(models);

  if (!opts.task && !opts.resume) {
    fail("缺少任务文本。运行 gkd-runtime --help 查看用法。");
  }

  // --resume 时,若用户没显式 --write,则从 state 继承上次会话的 mode。
  // 显式 --write 永远胜过继承(用户的明确意图优先)。
  if (opts.resume && !opts.write) {
    const last = readState()[cwd];
    if (last?.mode === "write") {
      opts.write = true;
      if (!opts.quiet) process.stderr.write(`[gkd] 续会话:从上次继承写模式\n`);
    }
  }

  const { args: claudeArgs, envOverride, spawnCwd } = buildSpawn(opts, cwd, models);
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
    writeLastSession(cwd, parsed.session_id, opts.write ? "write" : "read");
    writeUsageLog({
      ts: new Date().toISOString(),
      modelKey: opts.model,
      model: modelUsed,
      mode: opts.withContext ? "with-context" : opts.resume ? "resume" : "clean",
      write: opts.write,
      cwd,
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
      process.stdout.write(result + "\n");
      if (!opts.quiet) {
        const tag = parsed.is_error ? "❌ 失败" : "✅";
        process.stderr.write(`\n[gkd] ${tag} | 实际模型: ${modelUsed.join(",") || "?"} | session: ${parsed.session_id || "?"}\n`);
      }
    }
    process.exit(parsed.is_error ? 1 : 0);
  });
}

main();
