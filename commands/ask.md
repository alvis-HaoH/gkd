---
description: 委派模型回答/分析/审/咨询。**只读不改文件**(Read/Grep/Glob + Bash(git:*))。主 Claude 会智能补 --with-context、选模型。
argument-hint: '[--<model>] [--with-context] <任务(可多行)>'
allowed-tools: Bash(node:*), AskUserQuestion
---

把任务委派给指定模型,**只读模式**——子进程不能改文件、不能跑除 `git:*` 外的 Bash。
**委派的目的是把重活的 token 留在子进程,别搬回主上下文**——给方向和路径,实活交给子进程。

原始参数(可能多行,含特殊字符):

```
$ARGUMENTS
```

## 怎么做

1. **拣 flags**:识别 `--<modelKey>`(见 `${CLAUDE_PLUGIN_ROOT}/config/models.json`)、`--with-context`、`--resume`、`--json`、`--quiet`。**忽略 `--write`**——ask 只读,用户若需要修改就提醒他改用 `/gkd:do`。

2. **选模型**:用户显式指定或自然语言提名("用 GPT 看看")就用之;没说就**不传**,让 runtime 用默认。本机装了 codex CLI 时 `--codex` 可用(走 codex harness、GPT 原生工具循环,不是又一个便宜模型;选它的判据见 `config/model-routing.md`)。**codex 也支持 `--with-context`**,首次会把当前对话导入成 codex thread(约 1-2s)。注意:codex 会把主对话历史外发给 OpenAI(跨厂商),与 Claude 系不同;主对话含敏感内容时,命中"codex + --with-context"宜用 `AskUserQuestion` 跟用户确认一次。

3. **`--with-context` 自己判断**:任务若回指了主对话里才有、任务文本没写清的信息(指代某个之前讨论的方案/实体),就加 `--with-context` 把主对话 fork 给子进程;任务完全自洽就不加;**拿不准就用 `AskUserQuestion` 问用户**(选项:带上对话历史 / 干净委派)。

4. **跑**(任务文本第一个非 flag token 起,保留所有换行):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" \
  <拣出+补的 flags> \
  --allowed-tools "Read Grep Glob Bash(git:*)" \
  "$(cat <<'__GKD_TASK_EOF__'
<把任务原文逐字粘进来,保留换行,不重排/总结/翻译>
__GKD_TASK_EOF__
)"
```

单引号 heredoc 终止符 + 外层 `"$(...)"` 让多行任务成为**单个 argv 参数**(裸用 `$ARGUMENTS` 会被 shell 拆成多条命令,别这么写)。

5. **运行模式**:**默认 `run_in_background: true`**。Bash 前台默认 2 分钟超时会杀子进程丢进度,而读长文档/全仓审常超时。只有确信 < 30 秒(简单单点问答)才前台,且必须传 `timeout: 600000`,绝不用默认。不确定就后台。

## 输出处理

- 后台:Bash 立刻返回 task_id,报给用户("已在后台启动,task: `<id>`,跑完会通知")并**立刻还控制权,不要 TaskOutput 阻塞**。收到 `<task-notification>` 后 Read 那个 `.output` 文件,把 result 汇报给用户。
- 前台:stdout 直接就绪,直接汇报。
- stderr 末尾 `[gkd]` 行确认实际模型;`❌ 失败` 时把 result 里的 API 错误原文如实告知用户。
- ask 只读,**由你判断结果是否采纳、如何落盘。
