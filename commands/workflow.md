---
description: 把一个批量委派任务编排成 dynamic workflow——对 N 个 item 各派一个便宜模型子进程并行处理。适合 50 个文件各转一次、N 个模块各审一次等同构批量场景。
argument-hint: '[--<model>] [--write] <整体任务 + items 来源描述>'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Workflow
---

把用户的批量委派需求编排成一个 dynamic workflow。
参考 `delegate` skill 的"形态 C(在 workflow 里批量并行)"和**铁律(绝不主动 Read 文件内容再转发)**。

原始参数:
`$ARGUMENTS`

## 你要做的事

1. **从用户描述中识别两件东西**:
   - **items 来源**:文件 glob、目录、git diff 列表、明确给定的列表等
   - **任务模板**:对每个 item 要让子进程做什么(用变量代入 item)
   若用户描述含糊,用 `AskUserQuestion` 一次性问清楚 items 来源 + 任务模板。

2. **解析出 items**:
   - glob → 用 Glob 工具拿文件路径列表(只拿路径,**不要读内容**)
   - 目录 → 用 Glob 列文件
   - git → 用 `git diff --name-only ...` 拿改动文件列表
   - 明确列表 → 直接用
   item 数应是合理范围(≤ 200 通常 OK,过多需问用户是否分批)。

3. **用 Workflow 工具编排批量委派**:
   每个 item 在 workflow 的 pipeline/parallel 阶段里 Bash 调 runtime,加 `--json`
   让 runtime 输出结构化结果便于消费。模型由用户的 `--<modelKey>` 决定,
   未指定则让 runtime 用默认。**默认只读**;用户传 `--write` 时才允许子进程改文件。

   workflow 脚本的核心 stage 形如:

   ```js
   const results = await pipeline(
     items,
     item => bash(
       `node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" ` +
       `${用户指定的 --<modelKey> 或空} ${用户传 --write 时加上} --json ` +
       `"<把任务模板里的 {{item}} 替换成实际路径>"`,
       { label: `gkd:${item}` }
     ).then(out => JSON.parse(out))
   )
   ```

   并发度由 Workflow tool 默认控制(主仓库通常会给一个合理上限,你不需要手动设)。

4. **结果汇报**:
   workflow 跑完后,简洁汇报给用户:
   - 总数 / 成功数 / 失败数
   - 失败的 item 列出来(连带 result 里的错误原文)
   - 不要把每个成功 item 的完整产出都贴出来——产出已经写到了文件(若 --write)或在 result 里(若只读),用户需要时再单独看

## 铁律

- 不要主动 Read 任何 item 文件的内容——这是批量委派,主 token 一旦读了 N 个文件就毁了。让子进程自己读。
- 用 Glob/Bash(git:*)只拿**路径列表**,不拿内容。
- 不要在 workflow 脚本外另起一遍 Read——所有读文件都该发生在 runtime 子进程里。

## 何时该用 /gkd:workflow vs 单次 /gkd:ask|do

- `/gkd:ask <任务>` / `/gkd:do <任务>`:**单次** 委派,一个产出
- `/gkd:workflow <批量任务>`:**N 次** 同构委派,每个 item 一个产出,并行
若 N=1 或 N=2,直接用 `/gkd:ask`/`/gkd:do` 顺序调两次更简单。N≥5 且任务同构时,`/gkd:workflow` 才有编排收益。
