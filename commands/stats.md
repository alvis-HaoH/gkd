---
description: 展示 GKD 委派的 token 用量与节省估算。默认最近 7 天,--days N 可调。
argument-hint: '[--days N] [--json] [--refresh-prices]'
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

把下面这块内容**原样**输出给用户(包含末尾的提示框),什么都别加、别改、别评论。

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-stats.mjs" $ARGUMENTS && printf '\n> 💡 \x60/gkd:stats\x60 会过一次模型(把上面整段当 prompt 复读 → 算一次 input + output)。想零模型成本直接看数,配一次 alias 后在输入框敲 \x60!gkd-stats\x60 即可:\n> \x60\x60\x60sh\n> alias gkd-stats="%s/bin/gkd-stats"\n> \x60\x60\x60\n' "${CLAUDE_PLUGIN_ROOT}"`
