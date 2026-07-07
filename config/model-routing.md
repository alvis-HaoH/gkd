# 模型路由策略

> 这是给主 Claude 看的**跨模型选择偏好**,纯自然语言,可自由编辑。
> 每个模型**能干什么**(能力/禁忌/价格)写在 `models.json` 的 `capabilities`/`avoid_for`/`description`/`pricingKey` 字段里——**本文件不重复那些**,只描述"在多个候选里怎么权衡"。
> 委派时(单次 ask/do 或 workflow 批量),主 Claude 应:**先读 models.json 看每个模型的能力,再按本文件的偏好挑最合适的那个**。

## 偏好(不是步骤,是基调)

- **用户显式指定永远优先**:用户传了 `--<modelKey>` 就服从,别自作主张分流或"优化"。
- **默认倾向省钱**:绝大多数委派(coding、改写、分析、批量脏活)选最便宜的能胜任模型即可——这是 GKD 存在的理由。命中某模型 `avoid_for` 的任务排除它。
- **贵模型只在值得时用**:高难推理、brainstorm 发散、交叉 review 等"质量 > 成本"的场景才升级,不要默认用贵的。
- **特殊能力按需切**:需要视觉/图片输入等能力时,切到具备该能力的模型,哪怕它不是最便宜的。
- 拿不准时,不传模型让 runtime 用默认即可,别为了"路由"而路由。

## codex 是另一套 harness,不是又一个便宜模型

本机装了 codex CLI 时,注册表会自动多出 `--codex`(在 models.json 里的条目 `harness:"codex"`)。它和 glm/kimi/gpt **本质不同**:后者是"换模型、harness 仍是 Claude Code";`--codex` 是**换整个 harness**——spawn `codex exec`,GPT 在 OpenAI 自家的工具循环里干活。

- **选它的判据是"要 harness 差异",不是省钱**:codex 走订阅额度、不计入 token 成本估算(stats 只显 token 不算钱)。所以别为省钱选它。
- **什么时候值得用 codex**:① 用户显式提名 codex;② 复杂 agentic 改代码(codex 原生 harness 对 GPT 调优,常强于寄居在 Claude harness 里的 `--gpt`);③ review/brainstorm 想要**真正独立**的第二意见——`--codex` 与 Claude 系模型是不同 harness,独立性强于共享 Claude harness 的 `--gpt`。
- **`--codex` 与 `--gpt` 的区别**:两者背后可能都是 GPT,但 `--gpt` 是 Claude harness 驱动、走你在 models.json 里配的端点、按 pricingKey 计入成本;`--codex` 是 codex harness 驱动、走本机 codex CLI 的登录态、不计成本。要"GPT 的智力"选 `--gpt` 够了;要"GPT 在自家 harness 的完整能力 / 独立视角"才选 `--codex`。
- **限制(选之前知悉)**:codex 不支持 `--with-context`(继承主对话历史);写模式默认关网络(装库类任务会失败);续接(resume)的 cwd 和读写模式从原 thread 继承。细节见各命令文件。
