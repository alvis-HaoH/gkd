---
description: 把任务委派给便宜模型(默认 GLM)。默认只读;--write 可改文件;--glm/--kimi/--deepseek 选模型;--with-context 带主对话历史。
argument-hint: '[--<model>] [--with-context] <任务(含文件路径)>'
allowed-tools: Bash(node:*)
---

参考 `gkd-delegate` skill 的委派纪律。**铁律:不要自己 Read 文件内容再转发,只传文件路径,让子进程自己读。**

把用户的委派请求转发给底座脚本(原样保留任务文本和 flag):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" $ARGUMENTS`

把子进程返回的结果呈现给用户。注意 stderr 末尾的 `[gkd]` 行确认了实际使用的模型——若显示 `❌ 失败`,把 result 里的 API Error 原文告知用户。只读模式下,由你判断结果是否采纳、如何落盘。
