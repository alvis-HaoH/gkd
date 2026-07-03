---
description: 委派模型**改文件/落盘/执行**。隐含 --write(子进程获得 Edit/Write/Bash 全权)。主 Claude 会智能补 --with-context、选模型。
argument-hint: '[--<model>] [--with-context] <任务(可多行)>'
allowed-tools: Bash(node:*), AskUserQuestion
---

把任务委派给指定模型,**写模式**——子进程获得 Read/Grep/Glob/Edit/Write/Bash 全权,可改文件、可执行命令。
**委派的目的是把重活的 token 留在子进程,别搬回主上下文**——给方向和路径,读写实活交给子进程。

原始参数(可能多行,含特殊字符):

```
$ARGUMENTS
```

## 怎么做

1. **拣 flags**:识别 `--<modelKey>`(见 `${CLAUDE_PLUGIN_ROOT}/config/models.json`)、`--with-context`、`--resume`、`--json`、`--quiet`。**`--write` 由命令自动加,不用让用户重复传。**
   - **续历史会话并写**:`/gkd:do --resume [<sessionId>] <补充>` 可续上次(或点名续某次)委派**并给写权限**(即使原会话是只读)。续接语义、sessionId 检索 SOP、UUID 误拣防范、`--with-context` 互斥等规则,统一见 `commands/resume.md`——此处不复述,避免两处漂移。

2. **选模型**:用户显式指定或自然语言提名("用 GPT 改")就用之;没说就**不传**,让 runtime 用默认。

3. **`--with-context` 自己判断**:任务若回指了主对话里才有、任务文本没写清的信息,就加 `--with-context` 把主对话 fork 给子进程;任务完全自洽就不加;**拿不准就用 `AskUserQuestion` 问用户**(选项:带上对话历史 / 干净委派)。

4. **跑**(任务文本第一个非 flag token 起,保留所有换行):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" \
  --write \
  <拣出+补的 flags> \
  "$(cat <<'__GKD_TASK_EOF__'
<把任务原文逐字粘进来,保留换行,不重排/总结/翻译>
__GKD_TASK_EOF__
)"
```

单引号 heredoc 终止符 + 外层 `"$(...)"` 让多行任务成为**单个 argv 参数**(裸用 `$ARGUMENTS` 会被 shell 拆成多条命令,别这么写)。

5. **运行模式**:**默认 `run_in_background: true`**。Bash 前台默认 2 分钟超时会杀子进程丢进度,而装库/批量改/多次 LLM 调用常超时。只有确信 < 30 秒(改单文件一两行)才前台,且必须传 `timeout: 600000`,绝不用默认。不确定就后台。

## 输出处理

- 后台:Bash 立刻返回 task_id,报给用户("已在后台启动,task: `<id>`,跑完会通知")并**立刻还控制权,不要 TaskOutput 阻塞**。收到 `<task-notification>` 后 Read 那个 `.output` 文件,把 result 汇报给用户。
- 前台:stdout 直接就绪,直接汇报。
- stderr 末尾 `[gkd]` 行确认实际模型;`❌ 失败` 时把 result 里的 API 错误原文如实告知用户。
