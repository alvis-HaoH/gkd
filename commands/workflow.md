---
description: 把一个批量委派任务编排成 dynamic workflow——对 N 个 item 各派一个委派模型子进程并行处理,每个 item 可用不同模型。适合 50 个文件各转一次、N 个模块各审一次等同构批量场景。
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

3. **为每个子任务智能选模型(这是 `/gkd:workflow` 的核心优势,务必用足)**:

   GKD workflow 相比"会话级 env 换脑(`CLAUDE_CODE_SUBAGENT_MODEL`,一刀切全员同一模型)"最大的差异化优势是:**workflow 脚本可以为每个 item / 每类子任务挑不同模型**。不要无脑给全部 item 套同一个模型——先判断任务画像,把活派给最合适、最省的那个模型。

   **怎么选**:读 `config/model-routing.md`(跨模型的权衡偏好)+ `config/models.json`(每个模型的 `capabilities`/`avoid_for`/`description`/`pricingKey`)。**不要在脚本里写死具体模型名**——模型清单由用户的 models.json 决定(开源用户可能用任意模型),按"硬约束排除 → 能力匹配 → 能省则省"的逻辑动态判断,具体规则以 model-routing.md 为准。

   **模型来源优先级**:用户显式传的 `--<modelKey>` 覆盖一切(用户要求全用某模型,就别自作主张分流);用户没指定时,**由你按 model-routing.md 的偏好为每个 item 选**;实在无差别的同构批量,可统一用最便宜的能胜任模型。**默认只读**;用户传 `--write` 时才允许子进程改文件。

   workflow 脚本的核心 stage 形如(modelFlag 是你按 item 画像 + routing 策略算出来的,不是写死的;下面用占位示意):

   ```js
   // 用户显式指定则全程锁定;否则按 item 画像 + model-routing.md 偏好挑模型。
   // 注意:--<modelKey> 用 models.json 里实际存在的 key,别假设叫 glm/kimi。
   const pickModel = (item) => {
     if (用户显式传了 --<modelKey>) return `--${用户的modelKey}`;
     return `--${你按 routing 策略为该 item 选定的 modelKey}`;
   };
   const results = await pipeline(
     items,
     item => bash(
       `node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" ` +
       `${pickModel(item)} ${用户传 --write 时加上} --json ` +
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
- `/gkd:workflow <批量任务>`:**N 次** 委派,每个 item 一个产出,并行,**且每个 item 可用不同模型**
若 N=1 或 N=2,直接用 `/gkd:ask`/`/gkd:do` 顺序调两次更简单。N≥5 且任务同构时,`/gkd:workflow` 才有编排收益。

**为什么用 workflow 而不是会话级 env 换脑**:`CLAUDE_CODE_SUBAGENT_MODEL` env 能让原生 subagent/team/workflow 整会话换脑,但**一刀切**——全员同一模型,且 token 不隔离。`/gkd:workflow` 的护城河正是**按子任务挑模型 + 每个子进程 token 完全隔离 + 各自的读写边界/上下文档位**:视觉 item、普通 coding、高难任务可在同一批里分别走最合适的模型(具体哪个模型按 `config/models.json` + `config/model-routing.md` 判断)。批量任务异构、或想精打细算每个 item 的模型成本时,workflow 不可替代。
