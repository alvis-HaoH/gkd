---
description: 把批量委派编排成 dynamic workflow——N 个 item 各派一个委派模型子进程并行处理。适合 50 个文件各转一次、N 个模块各审一次等同构批量。
argument-hint: '[--<model>] [--write] <整体任务 + items 来源描述>'
disable-model-invocation: true
allowed-tools: Glob, Grep, Bash(node:*), Bash(git:*), Workflow
---

把用户的批量委派需求编排成 dynamic workflow,每个 item 一个换脑子进程并行处理。
批量委派的意义就是别让主上下文承担 N 个文件的开销:你拿到要处理的路径列表、编排好,读写实活交给子进程自己。

原始参数:`$ARGUMENTS`

## 怎么做

1. **识别 items 来源 + 任务模板**:从用户描述里找出 items(glob、目录、git diff 列表、明确列表)和"对每个 item 做什么"。描述含糊就用 `AskUserQuestion` 问清。用 Glob/Bash(git:*) 拿路径列表(item 数 ≤ 200 通常 OK,过多问用户是否分批)。

2. **选模型(默认从简)**:
   - 用户显式传 `--<modelKey>` → 全批锁定该模型。
   - **同构批量**(N 个文件相同改动)→ 默认统一一个便宜的能胜任模型最简单稳妥,不必逐 item 折腾。
   - **item 明显异构**(部分含图片、部分高难、部分普通改写)才按 item 分模型,按 `config/model-routing.md` + `config/models.json` 判断,别在脚本里写死模型名。
   - **worker/verifier 角色分工**:若任务是"改 + 验"两步,让 worker(便宜模型干活)和 verifier(另一模型把关/换视角)走不同模型是有价值的。

3. **写 workflow 脚本**。注意 Workflow 脚本运行时**没有 `bash()` hook,也不能直接跑 shell**;`agent()` 的 model 参数又只认 Claude 系标识符,**换不了第三方模型脑**。所以换脑只能这样链接:`agent()` 起一个**轻量启动器子代理**(用便宜的 `haiku`,活只是跑一条命令拿回 JSON),让它用 Bash 工具调 `gkd-runtime.mjs`——**真正换脑发生在 runtime spawn 的子进程那层**(便宜模型在那里干活、token 隔离)。

   核心 stage 形如(`pickModel` 按上面策略算 runtime 的 `--<modelKey>`,不是写死;`--write` 用户传了才加):

   ```js
   const results = await pipeline(
     items,
     item => agent(
       `用 Bash 工具执行这条命令,把它的 stdout 原样作为你的最终输出返回,不要加任何解释:\n` +
       `node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" ${pickModel(item)} --json "<任务模板里的 {{item}} 替换成实际路径>"`,
       { model: 'haiku', label: `gkd:${item}` }
     ).then(out => JSON.parse(out))
   )
   ```

   启动器用 haiku或sonnet 是因为它只是中转(spawn + 回传),不该烧贵模型;干实活的模型在 runtime 子进程里。并发度用 Workflow tool 默认,不用手设。

4. **汇报**:总数/成功/失败,失败 item 连错误原文列出。成功产出已落盘(--write)或在 result 里,不必全贴。

## 何时用 workflow

N≥5 且任务同构才有编排收益;N=1、2 直接 `/gkd:ask`/`/gkd:do` 调两次更简单。workflow 的价值是**批量并行 + 每个子进程 token 完全隔离**(以及需要时按 item 或按 worker/verifier 角色分模型)。
