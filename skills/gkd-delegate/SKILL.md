---
name: gkd-delegate
description: 当你想进行委派subagent、dynamic workflow时考虑使用，可以将委派的claude code大脑换成其他模型，以节省成本or引入其他模型的视角。
---

# GKD 委派

派一个**以指定模型为大脑**的 Claude Code 子进程。它有完整工具循环(Read/Edit/Bash 等),
在自己的上下文里读文件→思考→改→跑→迭代,只把结果回传。

两个并列目的:

1. **省 token**:重活在子进程里发生,主 Claude 只付出"指令 + 结果"
2. **发挥模型长处**:不同模型擅长不同事,把任务交给最合适的那一个

## 何时该委派

**适合(产出量大、上下文可控、可降级):**
- 写样板/重复代码(CRUD、配置、测试桩)
- 批量同构改写(N 个文件相同改动)
- 格式/语言转换(JSON↔YAML、批量翻译、注释翻译)
- 读长文档/长代码做摘要、问答、理解
- 代码/视觉审查(需要不同模型的意见时)
- 复杂但边界清晰的逻辑实现
- 做brainstorming时
- 用户明确要求时

**不适合:**
- 跨整个仓库的精细决策、架构判断
- 关键安全/认证逻辑
- 上下文巨大但产出很小(委派开销不抵收益)
- 任务边界模糊(子进程容易跑偏,需要频繁纠偏反而费事)

## 选哪个模型

可用模型在 `${CLAUDE_PLUGIN_ROOT}/config/models.json`。
**直接读这个文件**——每条有以下字段帮你选模型:
- `description`:人类描述,概括特长/价格/适用场景
- `capabilities`:结构化能力标签(如 `coding / vision / reasoning`)
- `avoid_for`:**别用它干这些**——任务命中此项就换一个

判断顺序:**先看 avoid_for 排除,再按 capabilities 匹配,最后用 description 决定边缘情况**。被 `disabled` 的会被 runtime 拒绝调用。

跨模型的**权衡偏好**(默认能省则省、贵模型只在值得时用、特殊能力按需切)写在 `${CLAUDE_PLUGIN_ROOT}/config/model-routing.md`,可由用户自由编辑——能力数据看 models.json,多个候选怎么取舍看 model-routing.md。

也可以运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" --help` 查看格式化的模型清单。

## 三种使用形态

GKD 同时覆盖 Claude Code 原生的"subagent"和"dynamic workflow"形态:

### A. 单任务委派
一次任务、一个模型、一个产出。直接 Bash 调 runtime 或用 slash 命令。
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" --<modelKey> "<任务>"
```

### B. 扮演 subagent
**一次 GKD 调用 = 一个独立的子 agent 实例**——它有自己的工具循环,任务边界内全程独立工作。
相比原生 `Agent` 工具(只能 spawn Claude 系大脑),GKD 的子 agent 可以是任意模型,
且主 token 完全隔离。

### C. 在 dynamic workflow 里批量
对 N 个同构 item 各做一次委派时,在 workflow 脚本的 `pipeline`/`parallel` 里 Bash 调 runtime,
每个 item 一个子进程。加 `--json` 让 runtime 输出结构化结果,便于 workflow 消费。

## 调用方式

### 用户视角(slash 命令)

| 命令 | 权限 | 用途 |
|---|---|---|
| `/gkd:ask <任务>` | **只读**(Read/Grep/Glob/Bash(git:*)) | 问/分析/审/咨询 |
| `/gkd:do <任务>` | **读写**(+Edit/Write/Bash) | 改文件/落盘/执行 |
| `/gkd:resume <补充>` | 自动从上次会话继承 mode | 续线程 |
| `/gkd:review` | 只读 | 代码审查专用 |
| `/gkd:brainstorm` | 只读 | 多模型并行发散 |
| `/gkd:workflow` | 视任务而定 | N 个 item 批量委派 |

ask/do 命令会**让主 Claude 智能补 `--with-context`**(任务自洽性不明就补;不确定就反问用户)。

### 直接调用 runtime

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" [--<modelKey>] [选项] "<任务>"
```

完整选项表运行 `--help` 查看,或读 `scripts/gkd-runtime.mjs` 顶部注释。
关键开关:`--write`(允许改文件)、`--resume`(续上次线程,**自动从 sessions.json 继承上次的 mode**;显式 `--write` 永远胜过继承)、`--with-context`(带主对话历史)、`--json`(结构化输出)。

### 运行模式: **默认 Bash 后台**

主 Claude 调 runtime 时,Bash 工具默认 `timeout: 120000`(2 分钟)。委派任务常涉及装库、批量改、几万行处理、N 次 LLM 调用——**经常超 2 分钟**。前台超时 = 子进程被杀 + 已跑的进度全丢。

**铁律**:

| 情况 | 怎么跑 |
|---|---|
| **默认 / 任务规模不清** | Bash 工具传 `run_in_background: true` |
| 任务可能 > 1 分钟 | **铁定后台** |
| brainstorm(N 个模型并行) | **永远后台** |
| **仅当**确信 < 30 秒(回答一行追问 / 改单文件一两行) | 前台,**必须**传 `timeout: 600000`(永远不要用默认 120000) |

**永远不要**用 Bash 默认 2 分钟超时跑 GKD 委派——杀子进程不可逆,丢进度。

不确定时**选后台**:对快任务的代价仅是多一次完成通知;对慢任务的代价是浪费一切已跑进度 + 主 Claude 卡死。

后台启动后:
1. 立刻把 task_id 报给用户:"GKD 委派已在后台启动(task: `<id>`),跑完会通知你。"
2. **不要** TaskOutput 阻塞等待——还控制权给用户。
3. 收到 `<task-notification>` 后,用 Read 读 task 的 `.output` 文件,把 result 部分汇报给用户。

各 slash 命令文件已把这套规则写进各自的 step 4——执行时跟着命令文件做即可。

## 铁律(技术约束,违反委派失效)

> **只传:任务描述 + 文件路径 + 模型选择。绝不把文件内容整个拼进委派指令。**

一旦主 Claude 把长文件输出进委派指令,重活的 token 已经烧在主上下文里了,委派失去意义。
读文件、写文件、跑命令都由子进程自己完成 —— 它有完整工具链。

- ✅ `gkd-runtime --glm "读 src/api/schema.ts,生成 src/api/crud.ts"`
- ❌ 先 `Read` schema.ts,再把内容粘进委派指令

## 处置结果

- stdout = 最终结果文本;stderr = 元信息(实际模型、session-id、成功/失败)
- 只读模式下:由你判断是否采纳、如何落盘——**不要再 Read 子进程读过的源文件**(那就回到了铁律陷阱)
- 看到 `❌ 失败`:把 stdout 里 result 字段的 API Error 原文如实告知用户
