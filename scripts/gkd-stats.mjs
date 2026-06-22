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

// 节省估算的基准模型——LiteLLM 里现行 Opus 4 系列价格。
const OPUS_BASELINE_KEY = "claude-opus-4-7";

// LiteLLM 字段名 → 我们累加的 token 档位
const PRICE_FIELDS = {
  input: "input_cost_per_token",
  output: "output_cost_per_token",
  cache_read: "cache_read_input_token_cost",
  cache_creation: "cache_creation_input_token_cost",
};

// 子进程返回的 modelUsage 字段名
const TOKEN_FIELDS = {
  input: "input_tokens",
  output: "output_tokens",
  cache_read: "cache_read_input_tokens",
  cache_creation: "cache_creation_input_tokens",
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

// ── models.json 读取 ──────────────────────────────────────────────────
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
function aggregate(entries, prices, models) {
  const byModel = new Map();
  const all = { calls: 0, ok: 0, fail: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, durations: [] };
  let actualCostUsd = 0;
  let opusCostUsd = 0;
  let priceMissing = 0;

  for (const e of entries) {
    all.calls++;
    if (e.ok) all.ok++; else all.fail++;
    if (Number.isFinite(e.durationMs)) all.durations.push(e.durationMs);

    const key = e.modelKey || "(unknown)";
    if (!byModel.has(key)) {
      byModel.set(key, { calls: 0, ok: 0, fail: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, costUsd: 0, priceable: 0 });
    }
    const slot = byModel.get(key);
    slot.calls++;
    if (e.ok) slot.ok++; else slot.fail++;

    const pricingKey = models[key]?.pricingKey;
    const priced = priceCall(e.usage, pricingKey, prices);
    if (priced) {
      slot.priceable++;
      slot.costUsd += priced.cost;
      actualCostUsd += priced.cost;
      for (const b of Object.keys(slot.tokens)) {
        slot.tokens[b] += priced.tokens[b];
        all.tokens[b] += priced.tokens[b];
      }
      // opus 基准:同 token 量按 OPUS_BASELINE_KEY 算
      const opus = priceCall(e.usage, OPUS_BASELINE_KEY, prices);
      if (opus) opusCostUsd += opus.cost;
    } else {
      priceMissing++;
      // 无价时仍累加 token,只是不进 cost
      for (const m of Object.values(e.usage || {})) {
        if (!m) continue;
        for (const [bucket, field] of Object.entries(TOKEN_FIELDS)) {
          slot.tokens[bucket] += Number(m[field] ?? 0);
          all.tokens[bucket] += Number(m[field] ?? 0);
        }
      }
    }
  }
  return { all, byModel, actualCostUsd, opusCostUsd, priceMissing };
}

// ── 输出辅助 ──────────────────────────────────────────────────────────
function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}
function fmtUsd(n) { return "$" + n.toFixed(n < 1 ? 4 : 2); }
function p50(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function fmtAge(ms) {
  if (ms < 60_000) return "刚刚";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  return `${Math.floor(hrs / 24)} 天前`;
}

// ── 人类可读输出 ──────────────────────────────────────────────────────
function renderHuman({ days, all, byModel, actualCostUsd, opusCostUsd, priceMissing, priceMeta }) {
  const lines = [];
  lines.push(`GKD 委派统计 (最近 ${days} 天)`);
  if (priceMeta.source === "missing") {
    lines.push(`⚠ 价格表不可用,只显示 token 数`);
  } else {
    const tag = priceMeta.source === "fresh" ? "刚拉取" :
                priceMeta.source === "cache" ? `cache · ${fmtAge(priceMeta.ageMs)}更新` :
                `cache 已过期 · ${fmtAge(priceMeta.ageMs)}更新`;
    lines.push(`价格源: LiteLLM JSON (${tag})`);
  }
  lines.push("");

  if (all.calls === 0) {
    lines.push("还没有委派记录。先用 /gkd 委派几次再来看 :)");
    return lines.join("\n");
  }

  lines.push("总览");
  lines.push(`  调用 ${all.calls} 次  ✓${all.ok}  ✗${all.fail}   p50 耗时 ${(p50(all.durations) / 1000).toFixed(1)}s`);
  lines.push(`  input ${fmtTok(all.tokens.input)}  output ${fmtTok(all.tokens.output)}  cache_read ${fmtTok(all.tokens.cache_read)}  cache_creation ${fmtTok(all.tokens.cache_creation)}`);
  lines.push("");

  lines.push("按模型");
  for (const [key, s] of byModel) {
    const costStr = priceMeta.source === "missing" || s.priceable === 0
      ? "(无价格)"
      : "est " + fmtUsd(s.costUsd);
    lines.push(`  ${key.padEnd(7)} ${String(s.calls).padStart(3)} 次  ✓${String(s.ok).padStart(2)}  in ${fmtTok(s.tokens.input).padStart(5)}  out ${fmtTok(s.tokens.output).padStart(5)}  cr ${fmtTok(s.tokens.cache_read).padStart(5)}  cw ${fmtTok(s.tokens.cache_creation).padStart(5)}  ${costStr}`);
  }
  lines.push("");

  if (priceMeta.source !== "missing" && opusCostUsd > 0) {
    const saved = opusCostUsd - actualCostUsd;
    const pct = saved > 0 ? (saved / opusCostUsd * 100).toFixed(0) : "0";
    lines.push("成本估算 (按 LiteLLM 公开价)");
    lines.push(`  实际:        ~${fmtUsd(actualCostUsd)}`);
    lines.push(`  如果用 opus: ~${fmtUsd(opusCostUsd)}`);
    lines.push(`  节省:        ~${fmtUsd(saved)} (${pct}%)`);
    if (priceMissing > 0) {
      lines.push(`  注:有 ${priceMissing} 次调用缺 pricingKey 或 LiteLLM 没收录,未计入实际成本`);
    }
    lines.push(`  注:friday 网关实际计费可能不同;Opus 基准取 ${OPUS_BASELINE_KEY}`);
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
