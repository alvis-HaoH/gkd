#!/usr/bin/env node
// gkd-find-session —— 主 Claude 的内部检索工具(不是用户命令,类比 runtime 里的 findSessionCwd)。
// 用户模糊描述"续上次那个改配置的",主 Claude 调它把描述翻成候选 session,再挑 id 交给
// gkd-runtime.mjs --resume <id>。
//
// 为什么是脚本而非让主 Claude 手拼 jq/grep:
//   ① delegations.jsonl 每行 ~650 字符,一半是 usage/model token 噪音——投影掉,别灌进上下文;
//   ② "追 fork 链到最新节点"用命令行拼很别扭,脚本几行搞定;
//   ③ 零外部依赖(纯 node 读),不看 jq 脸色,任何机器一致。
//
// 用法:
//   node gkd-find-session.mjs [关键词...] [--cwd <目录>] [--all-cwd] [--days N] [--limit N] [--model <key>] [--last] [--json]
//   关键词:对 task 做大小写不敏感子串匹配(多个关键词 = 任一命中,OR)
//   --cwd <目录>   只看该 sessionCwd(默认当前进程 cwd);--all-cwd 则不限目录
//   --days N       只看最近 N 天(默认不限)
//   --limit N      最多输出 N 条候选(默认 10,按时间倒序=最新在前)
//   --model <key>  只看该 modelKey(glm/kimi/gpt...)
//   --last         当前目录最新一条(= --limit 1 且强制当前目录,配合 --resume 快速续本目录上次)
//   --json         结构化输出(供程序消费);默认人类可读表

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".claude", "gkd");
const DELEGATIONS_FILE = join(STATE_DIR, "delegations.jsonl");
const LEGACY_USAGE_FILE = join(STATE_DIR, "usage.jsonl");
// 优先新文件;runtime 还没迁移过则回落老 usage.jsonl(与 gkd-stats 同策略)
const FILE = existsSync(DELEGATIONS_FILE) ? DELEGATIONS_FILE : LEGACY_USAGE_FILE;

function parseArgs(argv) {
  const o = { keywords: [], cwd: process.cwd(), allCwd: false, days: null, limit: 10, model: null, last: false, json: false };
  // 取带值 flag 的下一个 argv,缺失则报用法退出(否则 Number(undefined)=NaN → 空输出、o.cwd=undefined → 全过滤掉)
  const need = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      process.stderr.write(`gkd-find-session: ${flag} 需要一个参数值\n`);
      process.exit(1);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") o.cwd = need(i++, "--cwd");
    else if (a === "--all-cwd") o.allCwd = true;
    else if (a === "--days") { o.days = Number(need(i++, "--days")); if (Number.isNaN(o.days)) { process.stderr.write("gkd-find-session: --days 需要数字\n"); process.exit(1); } }
    else if (a === "--limit") { o.limit = Number(need(i++, "--limit")); if (Number.isNaN(o.limit)) { process.stderr.write("gkd-find-session: --limit 需要数字\n"); process.exit(1); } }
    else if (a === "--model") o.model = need(i++, "--model");   // 按 modelKey 筛(glm/kimi/gpt...)
    else if (a === "--last") o.last = true;           // 只取当前目录最新一条(= --limit 1 且强制当前目录)
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else o.keywords.push(a);
  }
  if (o.last) { o.limit = 1; o.allCwd = false; }  // --last:当前目录最近一条
  return o;
}

function loadRows() {
  if (!existsSync(FILE)) return [];
  let text;
  try { text = readFileSync(FILE, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 损坏行跳过 */ }
  }
  return rows;
}

// 把一条 delegation 投影成只含检索维度的干净对象(剥掉 usage/model 噪音)
function project(e) {
  return {
    ts: e.ts,
    sessionId: e.sessionId,
    parentSessionId: e.parentSessionId ?? null,
    task: e.task ?? null,
    modelKey: e.modelKey ?? null,
    mode: e.mode ?? null,
    write: !!e.write,
    cwd: e.sessionCwd ?? e.cwd ?? null,
    ok: e.ok !== false,
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    process.stdout.write("用法: node gkd-find-session.mjs [关键词...] [--cwd <目录>] [--all-cwd] [--days N] [--limit N] [--model <key>] [--last] [--json]\n");
    process.exit(0);
  }

  const all = loadRows().map(project).filter((r) => r.sessionId);

  const cutoff = o.days ? Date.now() - o.days * 864e5 : null;
  const kws = o.keywords.map((k) => k.toLowerCase());

  // ── 过滤 ──
  let rows = all.filter((r) => {
    if (!o.allCwd && r.cwd !== o.cwd) return false;
    if (o.model && r.modelKey !== o.model) return false;
    if (cutoff && r.ts && new Date(r.ts).getTime() < cutoff) return false;
    if (kws.length) {
      const t = (r.task || "").toLowerCase();
      if (!kws.some((k) => t.includes(k))) return false;
    }
    return true;
  });

  // ── 追 fork 链到最新节点:把每个命中行前进到它这条链的末端 ──
  // 命中的往往是发起行(有 task),但用户要续的是链最新节点。沿 parentSessionId 反向找后继。
  const byParent = new Map();  // parentSessionId → [子行...]
  for (const r of all) if (r.parentSessionId) {
    if (!byParent.has(r.parentSessionId)) byParent.set(r.parentSessionId, []);
    byParent.get(r.parentSessionId).push(r);
  }
  // 追到 fork 链最新节点。除非 --all-cwd,否则不跨目录追:命中链可能 A(X)→B(Y),
  // 在 X 检索却把用户带到 Y 的节点(甚至误入写分支)违背"只看当前目录"预期,故遇到 cwd 切换就停。
  // 目标 = 整棵可达子树里 ts 最新的成功(ok!==false)节点;全失败才回退到最新节点。
  // 逐层贪心不够:A→B(成功)→C(失败) 会停在 C(该层仅剩失败子),但 B 才是可续接的正确终点;
  // 而 B(成功)→C(失败)→D(成功) 又要求继续往下探而非停在 B。故收集全子树再择优。
  function latestDescendant(row) {
    const reachable = [];
    const stack = [row];
    const visited = new Set();
    let guard = 0;
    while (stack.length && guard++ < 10000) {
      const cur = stack.pop();
      if (visited.has(cur.sessionId)) continue;  // 防环(理论上 fork 链无环,兜底)
      visited.add(cur.sessionId);
      reachable.push(cur);
      const kids = byParent.get(cur.sessionId);
      if (!kids) continue;
      for (const k of kids) if (o.allCwd || k.cwd === cur.cwd) stack.push(k);  // 非 --all-cwd 遇 cwd 切换即不再下探
    }
    const newest = (arr) => arr.reduce((a, b) => (new Date(a.ts) >= new Date(b.ts) ? a : b));
    const ok = reachable.filter((r) => r.ok !== false);
    return ok.length ? newest(ok) : newest(reachable);
  }

  // 命中行 → 其链最新节点;按 sessionId 去重(多个命中可能属同一条链)
  const seen = new Map();
  for (const r of rows) {
    const tip = latestDescendant(r);
    // 记下"命中主题"来自哪行(tip 自己 task 可能为 null,保留发起行的 task 作展示)
    if (!seen.has(tip.sessionId)) seen.set(tip.sessionId, { tip, topic: r.task || tip.task });
    else if (!seen.get(tip.sessionId).topic && r.task) seen.get(tip.sessionId).topic = r.task;
  }

  let out = [...seen.values()].map(({ tip, topic }) => ({ ...tip, topic }));
  // 最新在前
  out.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  out = out.slice(0, o.limit);

  if (o.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  if (!out.length) {
    process.stdout.write("(无匹配委派。放宽:去掉关键词 / 加 --all-cwd / 加 --days)\n");
    return;
  }
  process.stdout.write(`匹配 ${out.length} 条(已追到 fork 链最新节点,可直接 --resume <id> 续):\n\n`);
  for (const r of out) {
    const when = r.ts ? r.ts.replace("T", " ").slice(0, 16) : "?";
    const rw = r.write ? "写" : "读";
    const forked = r.parentSessionId ? " [续接]" : "";
    process.stdout.write(`● ${when} | ${r.modelKey || "?"} | ${rw} | ${r.ok ? "✓" : "✗失败"}${forked}\n`);
    process.stdout.write(`  id: ${r.sessionId}\n`);
    process.stdout.write(`  任务: ${r.topic || "(无摘要,续接节点)"}\n`);
    if (o.allCwd) process.stdout.write(`  目录: ${r.cwd}\n`);
    process.stdout.write("\n");
  }
}

main();
