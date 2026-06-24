#!/usr/bin/env node
// gkd-stats —— 读 ~/.claude/gkd/usage.jsonl,聚合 token 用量,
// 用 LiteLLM 公开价格估算"实际花费"vs"如果都用 opus 的花费",输出节省情况。
//
// 用法:
//   node gkd-stats.mjs                    # 默认最近 7 天,人类可读
//   node gkd-stats.mjs --days 1
//   node gkd-stats.mjs --json
//   node gkd-stats.mjs --refresh-prices   # 强制重拉 LiteLLM 价格表

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(homedir(), ".claude", "gkd");
const USAGE_FILE = join(STATE_DIR, "usage.jsonl");
const PRICE_CACHE = join(STATE_DIR, "litellm_prices.json");
const MODELS_FILE = join(__dirname, "..", "config", "models.json");

// LiteLLM 维护的开源价格 JSON,ccusage 也在用。
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 成本对照基准——当前主 Claude 跑的 Opus 版本。改这里就能切基准。
const OPUS_BASELINE_KEY = "claude-opus-4-8";

// LiteLLM 字段名 → 我们累加的 token 档位
const PRICE_FIELDS = {
  input: "input_cost_per_token",
  output: "output_cost_per_token",
  cache_read: "cache_read_input_token_cost",
  cache_creation: "cache_creation_input_token_cost",
};

// 子进程返回的 modelUsage 字段名(camelCase,见 ~/.claude/gkd/usage.jsonl)
const TOKEN_FIELDS = {
  input: "inputTokens",
  output: "outputTokens",
  cache_read: "cacheReadInputTokens",
  cache_creation: "cacheCreationInputTokens",
};

// ── 参数解析 ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { days: 7, json: false, refreshPrices: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") opts.days = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "--refresh-prices") opts.refreshPrices = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) {
    process.stderr.write(`[gkd:stats] --days 必须是正数\n`);
    process.exit(1);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`gkd-stats —— GKD 委派 token 用量与节省估算

用法:
  node gkd-stats.mjs [--days N] [--json] [--refresh-prices]

选项:
  --days N           统计最近 N 天(默认 7)
  --json             机器可读输出
  --refresh-prices   强制重新拉 LiteLLM 价格表(忽略 7 天 cache)
  --help, -h         打印此帮助

价格源: ${LITELLM_URL}
`);
}

// ── 价格表:fetch + cache ──────────────────────────────────────────────
async function loadPrices(forceRefresh) {
  if (!forceRefresh && existsSync(PRICE_CACHE)) {
    const age = Date.now() - statSync(PRICE_CACHE).mtimeMs;
    if (age < PRICE_CACHE_TTL_MS) {
      try {
        return { prices: JSON.parse(readFileSync(PRICE_CACHE, "utf8")), source: "cache", ageMs: age };
      } catch {}
    }
  }
  try {
    const res = await fetch(LITELLM_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = JSON.parse(text);  // 验合法再落盘
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(PRICE_CACHE, text);
    return { prices: parsed, source: "fresh", ageMs: 0 };
  } catch (e) {
    if (existsSync(PRICE_CACHE)) {
      process.stderr.write(`[gkd:stats] LiteLLM fetch 失败 (${e.message}),沿用过期 cache\n`);
      const age = Date.now() - statSync(PRICE_CACHE).mtimeMs;
      try {
        return { prices: JSON.parse(readFileSync(PRICE_CACHE, "utf8")), source: "stale", ageMs: age };
      } catch {}
    }
    process.stderr.write(`[gkd:stats] LiteLLM fetch 失败且无 cache: ${e.message}\n`);
    return { prices: null, source: "missing", ageMs: 0 };
  }
}

// ── 读 usage.jsonl ────────────────────────────────────────────────────
function loadUsage(daysAgo) {
  if (!existsSync(USAGE_FILE)) return [];
  const cutoffMs = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  const lines = readFileSync(USAGE_FILE, "utf8").split("\n");
  const entries = [];
  let bad = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (new Date(e.ts).getTime() >= cutoffMs) entries.push(e);
    } catch {
      bad++;
    }
  }
  if (bad > 0) process.stderr.write(`[gkd:stats] 跳过了 ${bad} 行无法解析的日志\n`);
  return entries;
}

// ── models.json 读取(供 aggregate 取 pricingKey)─────────────────────
function loadModels() {
  try {
    const raw = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
    return raw.models || {};
  } catch {
    return {};
  }
}

// ── 单条调用按 LiteLLM 价表算 USD;返回 null 表示无法估算 ───────────────
function priceCall(usageObj, pricingKey, prices) {
  if (!prices || !pricingKey) return null;
  const row = prices[pricingKey];
  if (!row || row.input_cost_per_token == null) return null;
  // usageObj 形如 { "<model 名>": { input_tokens: ..., output_tokens: ..., ... } }
  // 一次调用可能聚合多个模型,但实际就一项,展平成总 token 计算。
  const tot = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  for (const m of Object.values(usageObj)) {
    if (!m) continue;
    for (const [bucket, field] of Object.entries(TOKEN_FIELDS)) {
      tot[bucket] += Number(m[field] ?? 0);
    }
  }
  const inputUnit = row.input_cost_per_token;
  let cost = 0;
  for (const [bucket, costField] of Object.entries(PRICE_FIELDS)) {
    const unit = row[costField] ?? inputUnit; // 缺失档兜底为 input 价(保守)
    cost += tot[bucket] * unit;
  }
  return { cost, tokens: tot };
}

// ── 总览聚合 ──────────────────────────────────────────────────────────
// 全部按 token × LiteLLM 公开价估算,通用、可复现。
// LiteLLM 没收录的模型(pricingKey 缺/对不上)只展示 token,不计入成本,priceMissing+1。
function aggregate(entries, prices, models) {
  const byModel = new Map();
  const all = { calls: 0, ok: 0, fail: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, durations: [] };
  let actualCostUsd = 0;
  let opusCostUsd = 0;
  let priceMissing = 0;
  let opusMissing = 0;

  for (const e of entries) {
    all.calls++;
    if (e.ok) all.ok++; else all.fail++;
    if (Number.isFinite(e.durationMs)) all.durations.push(e.durationMs);

    const key = e.modelKey || "(unknown)";
    if (!byModel.has(key)) {
      byModel.set(key, {
        calls: 0, ok: 0, fail: 0,
        tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        costUsd: 0, priceable: 0,
        // 展示用真实模型名:优先 models.json 的 model 字段,回退到 usage 记录里的 model,最后回退到 key
        modelName: models[key]?.model || (Array.isArray(e.model) ? e.model[0] : e.model) || key,
      });
    }
    const slot = byModel.get(key);
    if (slot.modelName === key) {
      const resolved = models[key]?.model || (Array.isArray(e.model) ? e.model[0] : e.model);
      if (resolved) slot.modelName = resolved;
    }
    slot.calls++;
    if (e.ok) slot.ok++; else slot.fail++;

    // token 始终累加(无论有无价)
    for (const m of Object.values(e.usage || {})) {
      if (!m) continue;
      for (const [bucket, field] of Object.entries(TOKEN_FIELDS)) {
        const n = Number(m[field] ?? 0);
        slot.tokens[bucket] += n;
        all.tokens[bucket] += n;
      }
    }

    // 实际成本 = LiteLLM 价 × token,模型按 models.json 的 pricingKey 查
    const pricingKey = models[key]?.pricingKey;
    const priced = priceCall(e.usage, pricingKey, prices);
    if (priced) {
      slot.priceable++;
      slot.costUsd += priced.cost;
      actualCostUsd += priced.cost;
    } else {
      priceMissing++;
    }

    // Opus 基准:同 token 量按 OPUS_BASELINE_KEY 估(用于"如果都用 opus"对比)
    const opus = priceCall(e.usage, OPUS_BASELINE_KEY, prices);
    if (opus) opusCostUsd += opus.cost;
    else opusMissing++;
  }
  return { all, byModel, actualCostUsd, opusCostUsd, priceMissing, opusMissing };
}

// ── 输出辅助 ──────────────────────────────────────────────────────────
function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
function fmtUsd(n) { return "$" + n.toFixed(n < 1 && n > 0 ? 4 : 2); }
function p50(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function fmtAge(ms) {
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m old`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h old`;
  return `${Math.floor(hrs / 24)}d old`;
}

// ── TUI:ANSI 着色 ─────────────────────────────────────────────────────
// 仅当 stdout 是 TTY 且没有 NO_COLOR 时上色,否则退化为纯文本。
// 设计参照 Claude.ai 暖橙基调:ORANGE 焦点 + dim 辅助 + default + bold,极少用其它色。
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const C = USE_COLOR ? {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
} : new Proxy({}, { get: () => "" });

const c = (style, s) => `${C[style] ?? ""}${s}${C.reset}`;
const c256 = (n, s) => USE_COLOR ? `\x1b[38;5;${n}m${s}\x1b[0m` : String(s);

// 主品牌橙(Anthropic 官方 #D97757,从 anthropic.com 抓的),256-color 173 (#D7875F) 最接近。
// 全屏只用在 hero / 锚条 / saved 锤定音。
const ORANGE = 173;

// 模型固定色——跨色温 muted 组合,彼此辨识但都低饱和,不跟主橙抢戏。
//   glm  → 109 (muted teal #87AFAF 灰青)
//   gpt  → 139 (mauve #AF87AF 淡紫)
//   kimi → 144 (olive #AFAF87 橄榄)
//   兜底 → 244 (warm gray 暖灰)
const MODEL_COLORS = { glm: 109, gpt: 139, kimi: 144 };
const colorOfModel = (key) => MODEL_COLORS[key] ?? 244;

// padEnd/padStart 对带 ANSI escape 的字符串会按 byte 长度算,造成对齐错位。
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visualLen = (s) => s.replace(ANSI_RE, "").length;
const padE = (s, w) => s + " ".repeat(Math.max(0, w - visualLen(s)));
const padS = (s, w) => " ".repeat(Math.max(0, w - visualLen(s))) + s;

const TERM_W = process.stdout.columns || 80;
// 目标布局宽度,锁 76 让 76 col 终端不 wrap;实际终端更宽时也仅留 padding,内容不变。
const LAYOUT_W = Math.min(TERM_W, 76);
const BAR_W = Math.min(28, Math.max(18, LAYOUT_W - 48));

// 唯一一根锚条(成本对比专用):actual 实心 / 剩余空心
function costBar(actual, opus, width = BAR_W) {
  if (opus <= 0) return c("dim", "░".repeat(width));
  const pct = Math.max(0, Math.min(1, actual / opus));
  const filled = Math.round(pct * width);
  return c256(ORANGE, "█".repeat(filled)) + c("dim", "░".repeat(width - filled));
}

// ── 人类可读输出 ──────────────────────────────────────────────────────
function renderHuman({ days, all, byModel, actualCostUsd, opusCostUsd, priceMissing, opusMissing, priceMeta }) {
  const lines = [];

  // ── Title ──────────────────────────────────────────────────────
  let priceTag;
  if (priceMeta.source === "missing") {
    priceTag = "no price table";
  } else {
    const age = priceMeta.source === "fresh" ? "fresh" :
                priceMeta.source === "cache" ? fmtAge(priceMeta.ageMs) :
                `stale ${fmtAge(priceMeta.ageMs)}`;
    priceTag = `${days}d · cache ${age}`;
  }
  const title = `${c("bold", c256(ORANGE, "GKD"))} ${c("bold", "delegation stats")}`;
  const titleW = visualLen(title);
  const tagW = priceTag.length;
  const pad = Math.max(2, LAYOUT_W - titleW - tagW);
  lines.push(`${title}${" ".repeat(pad)}${c("dim", priceTag)}`);
  lines.push(c("dim", "─".repeat(LAYOUT_W)));
  lines.push("");

  if (all.calls === 0) {
    lines.push(c("dim", "  no delegation history yet — try /gkd:ask or /gkd:do first."));
    return lines.join("\n");
  }

  // ── Hero summary line ─────────────────────────────────────────
  // 单行:N calls (· N failed) · saved $X (↓Y%) 或 spent $X。
  // p50 默认隐藏(brainstorm 共识),需要看时用 --json 取。
  let callsPart;
  if (all.fail > 0) {
    callsPart = `${c("bold", String(all.calls))} calls · ${c("dim", all.fail + " failed")}`;
  } else {
    callsPart = `${c("bold", String(all.calls))} calls`;
  }
  let punchPart;
  const hasOpus = priceMeta.source !== "missing" && opusCostUsd > 0 && actualCostUsd > 0;
  if (hasOpus && actualCostUsd < opusCostUsd) {
    const saved = opusCostUsd - actualCostUsd;
    const pct = (saved / opusCostUsd * 100).toFixed(0);
    punchPart = c("bold", c256(ORANGE, `saved ${fmtUsd(saved)} (↓${pct}%)`));
  } else if (actualCostUsd > 0) {
    punchPart = c("bold", c256(ORANGE, `spent ${fmtUsd(actualCostUsd)}`));
  } else {
    punchPart = c("dim", "no cost data");
  }
  lines.push(`  ${callsPart} · ${punchPart}`);
  lines.push("");

  // ── Tokens ───────────────────────────────────────────────────
  // 拆两行避免窄终端 wrap;dim 仅用在 labels,数字本体默认色。
  const inOut = all.tokens.input + all.tokens.output;
  const inPct = inOut > 0 ? Math.round(all.tokens.input / inOut * 100) : 0;
  const outPct = inOut > 0 ? 100 - inPct : 0;
  lines.push("  Tokens");
  lines.push(
    `    ${c("dim", "input")} ${fmtTok(all.tokens.input)} (${inPct}%)` +
    `  ·  ${c("dim", "output")} ${fmtTok(all.tokens.output)} (${outPct}%)`
  );
  lines.push(
    `    ${c("dim", "cache_r")} ${fmtTok(all.tokens.cache_read)}` +
    `  ·  ${c("dim", "cache_w")} ${fmtTok(all.tokens.cache_creation)}`
  );
  lines.push("");

  // ── Models ───────────────────────────────────────────────────
  // 按调用次数降序(用得多的排前),次序按成本降序兜底。
  const modelEntries = [...byModel.entries()].sort((a, b) => b[1].calls - a[1].calls || b[1].costUsd - a[1].costUsd);
  const modelW = Math.max(...modelEntries.map(([k]) => k.length), 5);

  // 动态列宽:每列宽度 = max(header 长度, 各 row 数据 plain 长度)。
  // plain 是去 ANSI 后的可见文本,colored 是上色后给渲染用。padS/padE 都是 visualLen-aware 的。
  // cache_r/w 合并一列以适应窄终端,数据格式 "130.6k/0"。
  const cols = [
    { key: "model",  header: "model",     align: "left"  },
    { key: "calls",  header: "calls",     align: "right" },
    { key: "tokens", header: "tokens",    align: "right" },
    { key: "cache",  header: "cache_r/w", align: "right" },
    { key: "cost",   header: "cost",      align: "right" },
  ];

  const rows = modelEntries.map(([key, s]) => {
    const totalToks = s.tokens.input + s.tokens.output;
    const noPrice = priceMeta.source === "missing" || s.priceable === 0;
    const noCost = noPrice || s.costUsd === 0;
    // calls 列三态
    let callsPlain, callsColor;
    if (s.fail === 0 && s.ok > 0)        { callsPlain = `${s.ok} ok`; callsColor = callsPlain; }
    else if (s.ok === 0 && s.fail > 0)   { callsPlain = `${s.fail} failed`; callsColor = c("dim", callsPlain); }
    else                                 { callsPlain = `${s.ok} ok · ${s.fail} fail`; callsColor = callsPlain; }
    const tokPlain = totalToks > 0 ? fmtTok(totalToks) : "—";
    const crStr = s.tokens.cache_read > 0 ? fmtTok(s.tokens.cache_read) : "—";
    const cwStr = s.tokens.cache_creation > 0 ? fmtTok(s.tokens.cache_creation) : "—";
    const cachePlain = (crStr === "—" && cwStr === "—") ? "—" : `${crStr}/${cwStr}`;
    const costPlain = noCost ? "—" : fmtUsd(s.costUsd);
    const dimDash = (p) => p === "—" ? c("dim", p) : p;
    return {
      model:  { plain: s.modelName, color: c256(colorOfModel(key), c("bold", s.modelName)) },
      calls:  { plain: callsPlain,  color: callsColor },
      tokens: { plain: tokPlain,    color: dimDash(tokPlain) },
      cache:  { plain: cachePlain,  color: dimDash(cachePlain) },
      cost:   { plain: costPlain,   color: noCost ? c("dim", costPlain) : costPlain },
    };
  });

  // 算列宽
  for (const col of cols) {
    col.w = Math.max(col.header.length, ...rows.map(r => r[col.key].plain.length));
  }

  // 列分隔:dim 浅竖线
  const SEP = ` ${c("dim", "│")} `;
  const PAD = "    ";
  const padCell = (text, col) => col.align === "right" ? padS(text, col.w) : padE(text, col.w);

  lines.push("  Models");
  // 表头(全 dim)
  lines.push(PAD + cols.map(col => c("dim", padCell(col.header, col))).join(SEP));
  // 数据行
  for (const r of rows) {
    lines.push(PAD + cols.map(col => padCell(r[col.key].color, col)).join(SEP));
  }
  lines.push("");

  // ── Cost ─────────────────────────────────────────────────────
  if (priceMeta.source === "missing") {
    if (actualCostUsd > 0) {
      lines.push("  Cost");
      lines.push(`    ${c("bold", fmtUsd(actualCostUsd))} actual   ${c("dim", "· price table unavailable, no Opus baseline")}`);
    }
  } else if (opusCostUsd > 0 && actualCostUsd > 0) {
    const saved = opusCostUsd - actualCostUsd;
    const pct = saved > 0 ? Math.round(saved / opusCostUsd * 100) : 0;
    lines.push("  Cost");
    // 唯一一根锚条:actual / opus 比例。"if Opus" 标签 dim,数字本身默认色。
    lines.push(
      "    " +
      c("bold", fmtUsd(actualCostUsd)) + " actual  " +
      costBar(actualCostUsd, opusCostUsd) + "  " +
      `${fmtUsd(opusCostUsd)} ${c("dim", "if Opus")}`
    );
    if (saved > 0) {
      lines.push("    " + c("bold", c256(ORANGE, `saved ${fmtUsd(saved)} · ${pct}% lower`)));
    }
    const notes = [];
    if (priceMissing > 0) notes.push(`${priceMissing} call(s) without LiteLLM pricingKey not counted`);
    if (opusMissing > 0) notes.push(`${opusMissing} call(s) missing ${OPUS_BASELINE_KEY} baseline`);
    notes.push(`baseline ${OPUS_BASELINE_KEY}`);
    notes.push(`public-rate estimate, gateway billing may differ`);
    for (const n of notes) lines.push("    " + c("dim", "· " + n));
  } else if (actualCostUsd > 0) {
    lines.push("  Cost");
    lines.push(`    ${c("bold", fmtUsd(actualCostUsd))} actual   ${c("dim", `· no ${OPUS_BASELINE_KEY} baseline available`)}`);
  }

  return lines.join("\n");
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const priceMeta = await loadPrices(opts.refreshPrices);
  const entries = loadUsage(opts.days);
  const models = loadModels();
  const agg = aggregate(entries, priceMeta.prices, models);

  if (opts.json) {
    const out = {
      days: opts.days,
      priceSource: priceMeta.source,
      priceAgeMs: priceMeta.ageMs,
      total: { calls: agg.all.calls, ok: agg.all.ok, fail: agg.all.fail, tokens: agg.all.tokens, p50DurationMs: p50(agg.all.durations) },
      byModel: Object.fromEntries(agg.byModel),
      cost: priceMeta.source === "missing" ? null : {
        actualUsd: agg.actualCostUsd,
        opusBaselineUsd: agg.opusCostUsd,
        savedUsd: agg.opusCostUsd - agg.actualCostUsd,
        opusBaselineKey: OPUS_BASELINE_KEY,
        priceMissingCalls: agg.priceMissing,
        opusMissingCalls: agg.opusMissing,
      },
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    process.stdout.write(renderHuman({ days: opts.days, ...agg, priceMeta }) + "\n");
  }
}

main().catch((e) => {
  process.stderr.write(`[gkd:stats] 失败: ${e.stack || e.message}\n`);
  process.exit(1);
});
