// gkd-codex-import —— 把一个 Claude 对话 jsonl 导入成 codex thread,供 --with-context(C 档)用。
//
// 为什么需要它:codex 读不了 Claude 的 ~/.claude/projects/*.jsonl。但 codex CLI 自带一个
// JSON-RPC 接口 `externalAgentConfig/import`(通过 `codex app-server` 子命令暴露),能把一个
// Claude jsonl 导入成 codex 自己的 thread。导入后 `codex exec resume <thread_id>` 就能续接、
// 且完整看到那段历史。整个导入是一次性操作(spawn → 握手 → import → 等完成 → 读 ledger → 关),
// 约 1-2s,不是常驻进程。
//
// 为什么不 import codex 官方插件的 lib:它路径里钉死版本号(.../codex/1.0.5/scripts/lib/),
// 升级即断,且不保证用户装了 codex 插件。gkd 是独立开源项目,故这里移植一份最小自包含的
// JSON-RPC 客户端(只用 node 内置模块),只保留 direct-spawn + import 这条路径,砍掉官方实现里的
// broker / windows-shell / socket 分支。
//
// 关键实证(codex-cli 0.136.0):`externalAgentConfig/import` 的 RPC 返回是 {}、
// `import/completed` 通知的 payload 也是 {} —— thread_id 两处都不带。唯一来源是 ledger 文件
// ~/.codex/external_agent_session_imports.json,按 source_path(realpath)+content_sha256 匹配。

import { spawn } from "node:child_process";
import readline from "node:readline";
import crypto from "node:crypto";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const INITIALIZE_TIMEOUT_MS = 15000; // 起进程 + 握手
const IMPORT_TIMEOUT_MS = 120000;    // 等 import/completed(大对话可能久一点)

// codex home:尊重 CODEX_HOME,缺省 ~/.codex。ledger 落在其下。
function ledgerPath() {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(home, "external_agent_session_imports.json");
}

function readLedgerRecords() {
  const p = ledgerPath();
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(j?.records) ? j.records : [];
  } catch {
    return [];
  }
}

function sha256File(path) {
  return crypto.createHash("sha256").update(readFileSync(path)).digest("hex");
}

// import 的 params 形状(照搬官方 externalAgentSessionMigration,实测有效)。
function buildImportParams(jsonlPath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${jsonlPath.split("/").pop()}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: jsonlPath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: [],
        },
      },
    ],
  };
}

// 最小 JSON-RPC over stdio 客户端(codex app-server)。
class AppServer {
  constructor(bin, cwd) {
    this.bin = bin;
    this.cwd = cwd;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.notificationHandler = null;
    this.proc = null;
    this.rl = null;
    this.exited = false;
    this.startupError = null;  // spawn 'error'(bin 不存在/不可执行/cwd 失效)先于任何 pending 到达时暂存
  }

  // 把所有未决请求拒掉,避免调用方挂死。exit / spawn error 共用。
  rejectAllPending(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async start() {
    this.proc = spawn(this.bin, ["app-server"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // spawn 失败(bin 路径不存在、不可执行、cwd 已删)会同步发 'error' 事件而非 'exit'。
    // 不监听则冒成 uncaughtException 直接 crash 整个 runtime,绕过 importClaudeSessionToCodex
    // 的 try/catch 和 runtime 的友好 fail()。这里把它转成对 pending 请求的 reject。
    this.proc.on("error", (e) => {
      this.exited = true;
      const err = new Error(`无法启动 codex app-server(${this.bin}): ${e.message}`);
      this.startupError = err;
      this.rejectAllPending(err);
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d) => (this.stderr += d));
    this.proc.on("exit", () => {
      this.exited = true;
      this.rejectAllPending(new Error(`codex app-server 意外退出${this.stderr ? `:\n${this.stderr.slice(-600)}` : ""}`));
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
  }

  handleLine(line) {
    const s = line.trim();
    if (!s) return;
    let m;
    try { m = JSON.parse(s); } catch { return; } // 非 JSON 行忽略
    // 服务端请求(有 id 且有 method):一律回 unsupported,别让服务端等我们、也别卡自己。
    if (m.id !== undefined && m.method) {
      this.send({ id: m.id, error: { code: -32601, message: "unsupported" } });
      return;
    }
    // response(有 id 无 method):按 id 分派到 pending。
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) {
        const err = new Error(m.error.message || `codex app-server 请求失败`);
        err.rpcCode = m.error.code;
        p.reject(err);
      } else {
        p.resolve(m.result ?? {});
      }
      return;
    }
    // 通知(有 method 无 id)。
    if (m.method && this.notificationHandler) this.notificationHandler(m);
  }

  send(msg) {
    if (this.exited || !this.proc?.stdin?.writable) {
      throw new Error("codex app-server stdin 不可写(进程可能已退出)");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  kill() {
    try { this.rl?.close(); } catch { /* ignore */ }
    if (this.proc && !this.proc.killed) {
      try { this.proc.stdin.end(); } catch { /* ignore */ }
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }
}

// 给 Promise 套超时:超时 reject(不取消底层动作,取消由调用方 kill 进程负责)。
function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时(${Math.round(ms / 1000)}s)`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// 主入口:把 jsonlPath 导入成 codex thread,返回 imported_thread_id。
// cwd 是导入 thread 的工作目录(应传主对话归属目录,让后续 resume 的 cwd 与历史一致)。
// 失败一律 throw(带分级诊断),绝不静默降级——调用方据此 fail,不能让用户误以为继承了上下文。
export async function importClaudeSessionToCodex(jsonlPath, cwd, { bin = "codex", quiet = false } = {}) {
  // 前置:jsonl 必须存在且可读。
  let realJsonl;
  try {
    realJsonl = realpathSync(jsonlPath);
  } catch {
    throw new Error(`找不到主对话 jsonl 文件:${jsonlPath}(可能 session 还没落盘或被清理)`);
  }

  // import 前记录 ledger 已有记录数:导入后只在「新增记录」里匹配,防并发/同 jsonl 多次导入串行。
  const baselineCount = readLedgerRecords().length;
  const wantSha = sha256File(realJsonl);

  const server = new AppServer(bin, cwd);
  try {
    // 起进程 + 握手(分阶段超时)。
    await withTimeout((async () => {
      await server.start();
      await server.request("initialize", {
        clientInfo: { title: "GKD", name: "gkd", version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      server.notify("initialized", {});
    })(), INITIALIZE_TIMEOUT_MS, "codex app-server 启动/握手");

    // import + 等 completed 通知。
    // 关键:completed 是个 Promise,resolve 于成功通知、reject 于失败通知——不能只等成功通知,
    // 否则 codex 若把导入失败作为通知(如 .../import/failed)发出而非 RPC error,这里会一直干等
    // 到 IMPORT_TIMEOUT_MS(120s)才超时,用户面对 2 分钟卡死。识别失败通知立即 reject。
    let resolveCompleted, rejectCompleted;
    const completed = new Promise((res, rej) => { resolveCompleted = res; rejectCompleted = rej; });
    void completed.catch(() => {});  // 防止 race 未选中它时留下 unhandled rejection
    server.notificationHandler = (m) => {
      if (m.method === IMPORT_COMPLETED) { resolveCompleted(); return; }
      // codex 未公开这套通知的失败形态,故按启发式兜底:方法名含 import 且含 fail/error 的通知
      // 视为导入失败,带上 params 里的消息(若有)。宁可对失败敏感,也不要 120s 干等。
      if (/import/i.test(m.method || "") && /(fail|error)/i.test(m.method || "")) {
        const msg = m.params?.message || m.params?.error?.message || m.method;
        rejectCompleted(new Error(`codex 导入失败通知:${msg}`));
      }
    };
    try {
      await server.request("externalAgentConfig/import", buildImportParams(realJsonl, cwd));
    } catch (e) {
      if (e.rpcCode === -32601) {
        throw new Error(
          "当前 codex 版本不支持 Claude 会话导入接口(externalAgentConfig/import)。" +
          "退路:去掉 --with-context 走 A 档(干净委派)或 --resume(续 codex thread);" +
          "或升级 codex:npm install -g @openai/codex@latest。"
        );
      }
      throw new Error(`codex 导入请求失败:${e.message}`);
    }
    try {
      await withTimeout(completed, IMPORT_TIMEOUT_MS, "等待 codex 完成导入");
    } catch (e) {
      // 超时(非失败通知)时补一句:codex 可能仍在后台导入,这条 thread 之后可能落进 ledger。
      if (/超时/.test(e.message)) {
        throw new Error(`${e.message}。codex 可能仍在后台导入,若稍后重试同一对话,注意可能已有一条本次的孤儿记录。`);
      }
      throw e;
    }

    // 读 ledger 拿 thread_id:只看 baseline 之后的新增记录,按 source_path + content_sha256 匹配。
    // 已知窄限:若两个进程「几乎同时」导入同一个主对话 jsonl(source 与 sha 全同),二者的新增
    // 记录无法区分,可能串到对方的 thread。根治需把 jsonl 拷成唯一 source,但实测 codex 只接受
    // ~/.claude/projects/ 下的路径(/tmp 拷贝被拒:"external agent session was not detected"),
    // 在 projects 目录造临时文件 + 负责清理带来的污染/复杂度,大于这个极窄并发场景的收益,故不做。
    // 单进程、或不同对话的并发,均不受影响。
    const records = readLedgerRecords();
    if (records.length === 0) {
      throw new Error(`codex 报告导入完成,但 ledger(${ledgerPath()})为空或不可读——疑似 codex 版本变更,gkd 需同步更新。`);
    }
    const fresh = records.slice(baselineCount);
    const pool = fresh.length ? fresh : records; // 极端情况(ledger 被压缩/轮转)回落全量
    const match = pool
      .filter((r) => r?.source_path === realJsonl && r?.content_sha256 === wantSha && typeof r?.imported_thread_id === "string")
      .at(-1);
    if (!match) {
      throw new Error(
        `codex 完成了导入但 ledger 里找不到本次记录(source=${realJsonl.split("/").pop()})。` +
        `疑似 codex 版本变更了 ledger 格式,gkd 的 parseCodexImport 需同步更新。` +
        (server.stderr ? `\ncodex stderr 尾部:\n${server.stderr.slice(-600)}` : "")
      );
    }
    return match.imported_thread_id;
  } finally {
    server.kill(); // 所有出口都保证结束 app-server 进程,不泄漏。
  }
}
