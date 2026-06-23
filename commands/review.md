---
description: 委派一个便宜模型对本地 git 改动做代码审查。只读不改文件。可用 --<modelKey> 指定模型
argument-hint: '[--<model>][--base <ref>] [--scope auto|working-tree|branch] [--wait|--background] [<额外关注点>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

让一个便宜模型审查本地 git 改动。**这是 review-only:绝不修改文件,不给 patch,不暗示要改**。
你的工作是探测范围 → 估算大小 → 选执行模式 → 委派给 runtime → 把子进程的审查输出**逐字**返回用户。

参考 `delegate` skill 的委派纪律:**绝不主动 Read 改动文件的内容**——让子进程自己读。
你只需要 `git status` 和 `git diff --shortstat` 这种**元信息**来估算范围和大小。

原始参数:
`$ARGUMENTS`

## 范围识别(scope)

- `--scope working-tree`(默认推断之一):审查未提交的改动(已跟踪 + untracked)
- `--scope branch`:审查 `<base>...HEAD` 的整支分支改动
- `--scope auto`(不传 scope 时的默认):
  - `git status --short --untracked-files=all` 非空 → working-tree
  - 否则 → branch(默认 base = `origin/main`,无远程则 `main`)
- `--base <ref>` 显式指定 branch scope 的对比基准

## 估算大小并选执行模式

代码审查动辄读多个文件 + 长 diff,前台默认 `timeout: 120000`(2 分钟)经常被杀,丢中途已读过的内容。**默认偏后台**。

- 参数包含 `--wait` → 直接前台(必须 `timeout: 600000`),不问
- 参数包含 `--background` → 直接后台,不问
- 否则估算:
  - working-tree:`git status --short --untracked-files=all` + `git diff --shortstat` + `git diff --shortstat --cached`
  - branch:`git diff --shortstat <base>...HEAD`
  - untracked 目录也算可审查工作,即便 diff --shortstat 为空
  - **极小**(1-2 个文件、< 50 行 diff、无目录级改动)→ 推荐 `Wait for results`
  - 其他情况(包括估算不清)→ 推荐 `Run in background`
  - 拿不准时倾向"后台跑审查",前台被杀代价大于多一次完成通知
- 用 `AskUserQuestion` 一次,两个选项,推荐项放首位并后缀 `(Recommended)`:
  - `Wait for results`
  - `Run in background`

## 委派给 runtime

构造审查指令(子进程将在自己的上下文里跑 git 看代码):

```
你正在做代码审查,严格 review-only:绝不修改任何文件,不输出 patch,不暗示要改动。

步骤:
1. 用 Bash 跑 `git status --short --untracked-files=all` 看改动清单
2. 基于范围 <scope>:
   - working-tree:`git diff` 看未暂存改动,`git diff --cached` 看已暂存改动,逐个 untracked 文件 Read
   - branch:`git diff <base>...HEAD` 看整支改动
3. 审查每处改动:bug、逻辑错、边界条件、坏味、不一致、设计风险、安全隐患
4. 报告格式:按"严重 → 轻微"分级,每条说明文件:行号、问题、为什么是问题
5. 附加关注点:<focus(可选,来自用户额外参数)>

只输出审查意见,不要任何"我可以帮你修复"之类的话。
```

把这条指令交给 runtime,带上 `Bash(git:*)` 的工具权限(让子进程能跑 git):

**前台(--wait):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" \
  <用户传的 --<modelKey>(若有,否则不传由 runtime 默认)> \
  --allowed-tools "Read Grep Glob Bash(git:*)" \
  "<上面的审查指令>"
```
Bash 工具参数:`timeout: 600000`(永远不要用默认的 120000——审查容易超 2 分钟)。

**后台(--background):**
用 Bash 工具的 `run_in_background: true` 启动同一条命令。立刻把返回的 task_id 报给用户:
"GKD 审查已在后台启动(task: `<id>`),跑完会通知你。"
**不要** TaskOutput 阻塞等待。收到 `<task-notification>` 后,用 Read 读 task 的 `.output` 文件拿 runtime stdout。

## 输出处理

- 把 runtime 的 stdout(审查报告)**逐字**返回用户。不概括、不重写、不加评论。
- 元信息(实际模型、session-id、成功/失败)在 stderr,可省略不展示,**除非显示 `❌ 失败`**——这时把 stdout 的 result 错误原文如实告知用户。
- 若用户在 review 后说"帮我修一下",那时再调 `/gkd:do` 委派修复;`/gkd:review` 本身永远不修改。

## 跟 codex:review 的差异(供你判断何时用哪个)

- `/codex:review` 用 GPT,有内置结构化 review payload
- `/gkd:review` 用 GKD 注册表里的任意模型(GLM/GPT/Gemini...),输出是自然语言审查文本——**优势是模型可选**,可以按需调度便宜或不同视角的模型来审
