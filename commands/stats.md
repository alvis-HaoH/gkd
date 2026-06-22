---
description: 展示 GKD 委派的 token 用量与节省估算。默认最近 7 天,--days N 可调。
argument-hint: '[--days N] [--json] [--refresh-prices]'
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

展示 GKD 委派统计。

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-stats.mjs" $ARGUMENTS`

把脚本输出原样呈现给用户。
