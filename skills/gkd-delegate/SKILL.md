---
name: gkd-delegate
description: 当你想进行委派subagent、dynamic workflow时考虑使用，可以将委派的claude code大脑换成其他模型，以节省成本or引入其他模型的视角。
---

# GKD 委派

派一个**以指定模型为大脑**的 Claude Code 子进程。它有完整工具循环(Read/Edit/Bash 等),在自己的上下文里读文件→思考→改→跑→迭代,只把结果回传。两个目的:**省 token**(重活在子进程发生,主 Claude 只付"指令 + 结果")和**发挥模型长处**(把任务交给最合适的那个)。

## 委派的目的

把重活的 token 开销留在子进程,而不是主 Claude 的上下文。主 Claude 给方向(任务 + 路径 + 模型),子进程干读写跑的实活。何时该先读一眼再下指令、何时直接给路径委派,你自己判断——准绳只有一条:别把本该子进程承担的开销搬回主上下文。

## 何时委派

产出量大、上下文可控、可降级的活适合委派(写样板、批量同构改写、格式/语言转换、读长文档做摘要、代码/视觉审查、边界清晰的逻辑实现)。跨整仓的精细决策、关键安全/认证逻辑、上下文巨大但产出极小、边界模糊容易跑偏的任务不适合——这些自己判断,别套清单。

## 选哪个模型

可用模型在 `${CLAUDE_PLUGIN_ROOT}/config/models.json`(每条有 `description`/`capabilities`/`avoid_for`/`pricingKey`),跨模型的权衡偏好在 `${CLAUDE_PLUGIN_ROOT}/config/model-routing.md`。**能力数据看 models.json,多个候选怎么取舍看 model-routing.md。** 用户显式指定的模型永远优先;没指定时默认能省则省,贵模型只在值得时用;拿不准就不传,让 runtime 用默认。

**harness 维度**:多数条目是"换模型、harness 仍是 Claude Code";若本机装了 codex CLI,注册表会自动多出 `--codex`(`harness:"codex"`),它是**换整个 harness**——GPT 在 codex 自家工具循环里干活。选它的判据是"要 harness 差异/独立第二意见/GPT 原生 agentic",不是省钱(走订阅额度、不计入成本)。限制:不支持 `--with-context`、写模式默认关网络。详见 model-routing.md。

## 怎么用

GKD 同时覆盖 Claude Code 原生的 subagent 和 dynamic workflow 形态——一次 GKD 调用 = 一个独立子 agent(任意模型,主 token 隔离),workflow 里对 N 个 item 各调一次即批量。日常通过 slash 命令触发:

| 命令 | 权限 | 用途 |
|---|---|---|
| `/gkd:ask` | 只读(Read/Grep/Glob/Bash(git:*)) | 问/分析/审/咨询 |
| `/gkd:do` | 读写(+Edit/Write/Bash) | 改文件/落盘/执行 |
| `/gkd:resume` | 自动从上次会话继承 | 续委派线程:默认续本目录上次,也可凭模糊描述点名续任意历史/跨目录 session |
| `/gkd:review` | 只读 | 代码审查(常规/对抗两种立场) |
| `/gkd:brainstorm` | 只读 | 多模型并行发散 |
| `/gkd:workflow` | 视任务而定 | N 个 item 批量委派 |
| `/gkd:stats` | — | 委派用量与省钱估算 |

直接调底座:`node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" [--<modelKey>] [选项] "<任务>"`,完整选项见 `--help` 或脚本顶部注释。关键开关:`--write`(允许改文件)、`--resume [<id>]`(续线程,自动继承上次 mode;带 UUID 则点名续任意历史/跨目录 session)、`--with-context`(fork 主对话历史)、`--prompt-file`(注入前置指令)、`--json`(结构化输出)。

## 运行模式与输出

**默认 Bash 后台**(`run_in_background: true`):委派常涉及装库/批量改/多次 LLM 调用,Bash 前台默认 2 分钟超时会杀子进程、丢进度。只在确信 < 30 秒时才前台,且必须传 `timeout: 600000`,绝不用默认。后台启动后立刻报 task_id 给用户、还控制权,收到 `<task-notification>` 再 Read task `.output` 汇报。

stdout = 结果文本;stderr = 元信息(实际模型、session-id、成功/失败)。只读模式下由你判断是否采纳。`❌ 失败` 时把 result 里的错误原文如实告知用户。

> 各 slash 命令文件已把这套规则写进自己的步骤,执行时跟命令文件走即可。本 skill 是给"主 Claude 不经 slash、自发决定委派"时看的纲领。
