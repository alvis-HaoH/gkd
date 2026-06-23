---
description: 委派便宜模型**改文件/落盘/执行**。隐含 --write(子进程获得 Edit/Write/Bash 全权)。主 Claude 会智能补 --with-context、选模型。
argument-hint: '[--<model>] [--with-context] <任务(可多行)>'
allowed-tools: Bash(node:*), AskUserQuestion
---

把任务委派给便宜模型,**写模式**——子进程获得 Read/Grep/Glob/Edit/Write/Bash 全权,可改文件、可执行命令。
参考 `gkd-delegate` skill 的委派纪律。**铁律:不要自己 Read 文件内容再转发,只传文件路径,让子进程自己读。**

原始参数(可能多行,可能含 `"`/`'`/`*`/`$` 等特殊字符):

```
$ARGUMENTS
```

## 步骤(目标:**一次** Bash 调用完成委派)

### 1. 拣 flags

从原始参数里识别合法 flags(以 `--` 开头):
- `--<modelKey>`:`--glm`/`--kimi`/`--gpt` 等(列表见 `${CLAUDE_PLUGIN_ROOT}/config/models.json`)
- `--with-context`、`--resume`、`--json`、`--quiet`
- `--model <值>`、`--allowed-tools "<值>"`

**`--write` 由 do 命令自动加,不需要也不要让用户重复传。**

### 2. 智能补 flags(基于任务内容)

**`--with-context` 的决策**(把当前主对话历史 fork 给子进程):

| 信号 | 行动 |
|---|---|
| 用户显式传了 `--with-context`,或自然语言要求"带上上文/历史" | **加** |
| 任务含回指词(这个/那个/上面/刚才/你说的/前面提到的/这次/这份/这段),或引用主对话里有但任务文本没说清的实体名 → 自洽性不明 | **加** |
| 任务完全自洽(独立路径 + 完整指令,无任何指代主对话) | **不加** |
| 介于两者之间,看不清是否需要 | **`AskUserQuestion` 反问用户** —— 选项:① 带上对话历史(--with-context) / ② 干净委派(不带) |

**`--<model>` 的决策**:
- 用户明确指定 → 用之
- 用户自然语言提名("用 GPT 改"/"让 kimi 试试")→ 抓出对应 modelKey
- 都没说 → **不传**,让 runtime 用默认(不要自己挑)

### 3. 解析任务

第一个**非 flag** token 起、到 `$ARGUMENTS` 结尾的全部内容(**保留所有原始换行**)即"任务"。

### 4. 选运行模式:**默认 Bash 后台**

`/gkd:do` 常常委派装库/批量改/几十次 LLM 调用——Bash 工具前台默认 `timeout: 120000`(2 分钟),超时即杀子进程,已装的依赖、已处理的数据**全丢**。所以:

| 情况 | 怎么跑 |
|---|---|
| **默认 / 任务规模不清** | Bash 调用传 `run_in_background: true` |
| 任务可能 > 1 分钟(装库 / 几万行 / 多次 LLM / 跨多文件批量) | **铁定后台** |
| **仅当**确信 < 30 秒(改单文件一两行 / 改一处 typo) | 前台,且必须传 `timeout: 600000`(永远不要用默认的 120000) |

不确定时**选后台**——后台对快任务的代价只是多一次完成通知;前台对慢任务的代价是丢进度 + 主 Claude 卡死。

### 5. 调用 runtime(单次 Bash 调用)

任务通过 heredoc 注入成单个 argv 参数,**避免多行被 shell 拆成多条命令**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" \
  --write \
  <拣出 + 智能补的 flags> \
  "$(cat <<'__GKD_TASK_EOF__'
<把任务原文逐字粘进来,保留所有换行,不要重排/总结/翻译>
__GKD_TASK_EOF__
)"
```

Bash 工具参数:`run_in_background: true`(默认)或 `timeout: 600000`(确信轻量时)。

要点:
- heredoc 终止符**单引号包裹**(`'__GKD_TASK_EOF__'`)→ 体内全 literal,不展开任何 `$`/反引号/`\`。
- 外层 `"$(...)"` 让整段成为**一个** argv 参数,保留换行。
- 任务原文若碰巧含 `__GKD_TASK_EOF__` 字面串,换不冲突的终止符即可。

### ⚠️ 不要这样写

```bash
# ❌ 多行 $ARGUMENTS 会被 shell 当作多条命令拆开
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" --write $ARGUMENTS
```

## 输出处理

**后台模式(默认)**:
1. Bash 调用立刻返回 task_id 和 `.output` 文件路径。把 task_id 直接报给用户:"GKD 委派已在后台启动(task: `<id>`),跑完会通知你。" **不要** TaskOutput 阻塞等待——立刻还控制权。
2. 收到 `<task-notification>` 后,用 Read 读 task 的 `.output` 文件(里面是 runtime 的 stdout + stderr)。
3. 把 result 部分汇报给用户。stderr 末尾 `[gkd]` 行确认实际模型——若 `❌ 失败`,把 result 里的 API 错误原文告知用户。
4. 子进程已经直接落盘,你**不需要**再去 Read 它写过的文件(那就回到了铁律陷阱)。

**前台模式(轻量任务)**:Bash 返回时 stdout 已就绪,直接照后台第 3 步走,跳过 1、2。
