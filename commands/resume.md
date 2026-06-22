---
description: 接着上一个委派任务继续(续子进程线程)。继承的是子进程自己的历史,不烧主 token。
argument-hint: '[--<model>][--write] <补充指令>'
allowed-tools: Bash(node:*)
---

参考 `gkd-delegate` skill。续上上次本目录的委派线程(B 档),让便宜模型接着上次的上下文继续干。

转发补充指令给底座(自动带 --resume):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" --resume $ARGUMENTS`

把结果呈现给用户。若提示"找不到上次的委派线程",说明本目录还没委派过,改用 `/gkd` 发起新委派。
