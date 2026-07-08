#!/usr/bin/env node
// gkd-brainstorm —— 多模型并行 brainstorming(形态 A:单轮独立)
//
// 把同一个问题并行抛给 N 个不同模型,每个模型在自己干净的上下文里独立回答,
// 然后把 N 份意见汇总返回给主 Claude,由主 Claude 综合。
// 设计上不允许模型互相看到对方回答 → 避免 sycophancy / 回声室效应。
//
// 用法:
//   node gkd-brainstorm.mjs [--models a,b,c] [--with-context] [--json] [--help] "<问题>"
//
//   --models a,b,c   只让指定的模型参与(逗号分隔)。不传则使用 config/models.json
//                    里所有 disabled≠true 的模型。
//   --with-context   让每个子进程加载主 Claude 当前对话历史(参考 runtime 的 C 档)
//   --json           输出 [{model, ok, result|error}, ...] 结构化数组
//   --help, -h       打印帮助
//
// 实现:复用 gkd-runtime,每个模型一个子进程,Promise.all 并行,任一失败不影响其他

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(__dirname, "gkd-runtime.mjs");
const MODELS_FILE = join(__dirname, "..", "config", "models.json");

// ── 工具函数 ───────────────────────────────────────────────────────────
function fail(msg) {
  process.stderr.write(`[gkd-brainstorm] 错误: ${msg}\n`);
  process.exit(1);
}

function loadModels() {
  try {
    const raw = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
    if (!raw.models || typeof raw.models !== "object") {
      fail(`${MODELS_FILE} 缺少 models 字段`);
    }
    return raw.models;
  } catch (e) {
    fail(`无法读取 ${MODELS_FILE}: ${e.message}`);
  }
}

// ── 参数解析 ───────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    models: null,           // null=全部未禁用;数组=显式指定子集
    withContext: false,
    json: false,
    help: false,
    question: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--models") opts.models = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--with-context") opts.withContext = true;
    else if (a === "--json") opts.json = true;
    else opts.question.push(a);
  }
  opts.question = opts.question.join(" ").trim();
  return opts;
}

function printHelp(models) {
  const rows = Object.entries(models).map(([k, v]) => {
    const tag = v.disabled ? "❌" : "✅";
    const modelName = v.model || (v.harness === "codex" ? "(codex 默认)" : "?");
    return `  ${tag} ${k.padEnd(12)} ${modelName.padEnd(24)} ${v.disabled ? "(禁用)" : ""}`;
  }).join("\n");
  process.stdout.write(`gkd-brainstorm —— 多模型并行 brainstorming(各自独立回答,主 Claude 综合)

用法:  node gkd-brainstorm.mjs [选项] "<问题>"

可用模型(来自 config/models.json,默认全部未禁用参与):
${rows}

选项:
  --models a,b,c   只让指定模型参与(逗号分隔)
  --with-context   每个子进程加载主对话历史
  --json           结构化输出
  --help, -h       打印此帮助

设计:每个模型在干净独立的上下文里答题,彼此看不到对方回答——
故意避开 LLM 的 sycophancy / 回声室效应。
`);
}

// ── 单个模型的子进程封装 ──────────────────────────────────────────────
function runOne(modelKey, question, withContext) {
  return new Promise((resolve) => {
    const args = [RUNTIME, `--${modelKey}`, "--quiet"];
    if (withContext) args.push("--with-context");
    args.push(question);
    const child = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ model: modelKey, ok: false, error: e.message }));
    child.on("close", (code) => {
      const text = stdout.trim();
      if (code === 0 && text) {
        resolve({ model: modelKey, ok: true, result: text });
      } else {
        // runtime 失败时:错误原文有时在 stdout(API Error)有时在 stderr([gkd] 错误...)
        const err = (text || stderr.trim() || `子进程退出码 ${code}`).slice(0, 800);
        resolve({ model: modelKey, ok: false, error: err });
      }
    });
  });
}

// ── 输出格式化 ─────────────────────────────────────────────────────────
function renderText(results) {
  const blocks = results.map((r) => {
    const header = r.ok ? `===== ${r.model} =====` : `===== ${r.model} (FAILED) =====`;
    const body = r.ok ? r.result : r.error;
    return `${header}\n${body}`;
  });
  return blocks.join("\n\n") + "\n";
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const allModels = loadModels();

  if (opts.help) { printHelp(allModels); process.exit(0); }
  if (!opts.question) fail("缺少问题。运行 --help 查看用法。");

  // 决定参与的模型集
  let participating;
  if (opts.models) {
    participating = opts.models;
    for (const k of participating) {
      if (!allModels[k]) {
        fail(`未知模型 "${k}"。可用: ${Object.keys(allModels).join(", ")}`);
      }
      if (allModels[k].disabled) {
        fail(`模型 "${k}" 已禁用: ${allModels[k].disabledReason || "(未注明)"}`);
      }
    }
  } else {
    participating = Object.entries(allModels)
      .filter(([_, v]) => !v.disabled)
      .map(([k]) => k);
  }
  if (participating.length === 0) fail("没有可用模型(全部 disabled)。");

  process.stderr.write(`[gkd-brainstorm] 并行问 ${participating.length} 个模型: ${participating.join(", ")}\n`);

  // 并行 spawn,任一失败不影响其他
  const results = await Promise.all(
    participating.map((k) => runOne(k, opts.question, opts.withContext))
  );

  // 输出
  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  } else {
    process.stdout.write(renderText(results));
  }

  // 元信息
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  process.stderr.write(`[gkd-brainstorm] 完成: ${okCount} 成功 / ${failCount} 失败\n`);

  process.exit(okCount === 0 ? 1 : 0);
}

main();
