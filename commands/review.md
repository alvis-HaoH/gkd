---
description: 委派模型对本地 git 改动做代码审查。只读不改文件。--adversarial 切对抗式设计审查;可用 --<modelKey> 指定模型
argument-hint: '[--<model>] [--adversarial] [--base <ref>] [--scope auto|working-tree|branch] [--wait|--background] [<额外关注点>]'
allowed-tools: Read, Bash(node:*), Bash(git:*), AskUserQuestion
---

让委派模型审查本地 git 改动。**review-only:绝不修改文件、不给 patch、不暗示要改**。
你只负责**调度**:定范围 → 选模式 → 委派 → 把子进程的审查输出**逐字**返回用户。审查指令本身在 prompt 模板里,由 runtime 注入子进程——你不用拼审查步骤。

这个命令是把审查工作委派出去:你做调度(定范围、选模式、回传),读 diff 和审代码是子进程的活——别让整个 diff 占满主上下文。

原始参数:`$ARGUMENTS`

## 1. 选 prompt 模板

- 默认 `${CLAUDE_PLUGIN_ROOT}/prompts/review-defects.md`(常规缺陷审查:bug/逻辑/边界/安全)
- 用户传 `--adversarial`、或自然语言要求"挑战设计/质疑实现方式/对抗审" → `${CLAUDE_PLUGIN_ROOT}/prompts/review-adversarial.md`(对抗式设计审查)
- 拿不准用户想要哪种就用 `AskUserQuestion` 问用户**(选项:常规缺陷审查 / 对抗式设计审查)

## 2. 定范围(scope)

- `--scope working-tree`:审未提交改动(已跟踪 + untracked)
- `--scope branch`:审 `<base>...HEAD` 整支(默认 base=`origin/main`,无远程则 `main`,`--base <ref>` 可指定)
- 不传时 `auto`:`git status --short --untracked-files=all` 非空 → working-tree,否则 → branch

## 3. 选执行模式

- 参数含 `--wait` → 前台(必须 `timeout: 600000`);含 `--background` → 后台;极小改动(1-2 文件、<50 行)推荐前台,其余(含估不清)推荐后台——审查易超 2 分钟,前台被杀代价大。拿捏不准时则估范围(`git diff --shortstat` 等)后用 `AskUserQuestion` 问一次(`Wait for results` / `Run in background`,推荐项放首位)

## 4. 委派给 runtime

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" \
  <用户的 --<modelKey>(若有,否则不传走默认)> \
  --allowed-tools "Read Grep Glob Bash(git:*)" \
  --prompt-file "<上面选定的模板路径>" \
  --render review \
  "$(cat <<'__GKD_TASK_EOF__'
审查范围 <scope,如 working-tree 或 branch(base=origin/main)>。
<若用户给了额外关注点,粘在这里:重点关注 ...>
用 git 看改动(git status、git diff / git diff --cached、或 git diff <base>...HEAD,untracked 文件逐个读),然后按你的审查准则给意见。
__GKD_TASK_EOF__
)"
```

审查的立场/关注面/发现标准已在 `--prompt-file` 注入的模板里,任务文本只交代范围和额外关注点。`--render review` 让 runtime 把子进程返回的结构化 JSON 渲染成干净报告(模板已要求子进程只吐 JSON,过程独白被挡在输出之外)。前台传 `timeout: 600000`;后台用 `run_in_background: true`,报 task_id 给用户,收到 `<task-notification>` 后 Read `.output`。

## 输出处理

**stdout 契约:runtime 的 stdout 就是给用户的最终产物,你是纯管道——逐字返回,不概括、不重写、不清洗、不根据它自行重建一份审查报告。** 无论 stdout 是渲染好的干净报告(`## 审查报告` + 分条发现 + 总判定),还是 `[gkd] ⚠` 开头的降级提示(模型没吐合法 JSON 时的原文兜底),都照此逐字回传模型的最终判断，中间过程无需逐字返回。

- 元信息在 stderr,可省略,**除非 `❌ 失败`**——那时把错误原文如实告知用户。
- 用户 review 后说"帮我修",那时再用 `/gkd:do`;`/gkd:review` 本身永不修改。
