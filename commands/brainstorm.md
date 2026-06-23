---
description: 多模型并行对同一问题各给独立意见(发散式 brainstorming),主 Claude 综合分歧、共识、独到见解。各模型彼此看不到对方答案,避免回声室效应。
argument-hint: '[--models a,b,c] [--with-context] <问题(可多行)>'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

调 brainstorm 脚本,把多模型并行的独立意见交回综合。
参考 `gkd-delegate` skill。**这是发散式形态(每个模型干净独立答题,彼此不可见)**——
要"互相批评/对抗式"请引导用户用未来的 `/gkd:debate`。

原始参数(可能多行,可能含 `"`/`'`/`*`/`$` 等特殊字符):

```
$ARGUMENTS
```

## 步骤(目标:**一次** Bash 调用)

### 1. 拣 flags

从原始参数里识别合法 flags:`--models a,b,c`、`--with-context`、`--json`、`--quiet`。

### 2. `--with-context` 的决策(跟 ask/do 不同!)

brainstorm 的设计哲学是"**模型在干净独立的上下文里答题**",带主对话历史会:
- **污染独立性**(主对话里的倾向会影响所有 N 个模型,丢"独立第二意见"价值)
- **N 倍成本**(N 个子进程各加载一遍主对话历史)

所以决策树跟 ask/do **不一样**——默认偏向**不带**:

| 信号 | 行动 |
|---|---|
| 用户显式传 `--with-context`,或自然语言要求"带上上文/历史" | **加** |
| 任务含强回指词(评估"上面的"那个方案 / 看看"刚才"那个想法 / "你说的"那个) → 用户**很可能**忘了 `--with-context` | **`AskUserQuestion` 反问** —— 选项:① 带上对话历史(N×成本但模型懂指代) / ② 干净独立答题(默认/推荐,brainstorm 卖点是独立性) |
| 任务自洽,或弱回指 | **不加**(不反问,默认行为) |

### 3. 解析问题文本

第一个非 flag token 起、到 `$ARGUMENTS` 结尾的全部内容(**保留原始换行**)即"问题"。

### 4. 选运行模式:**铁定 Bash 后台**

brainstorm 是 N 个模型并行各跑一次,即便单个模型快,**最慢那个也常常 > 2 分钟**(尤其涉及 `--with-context` 时多个子进程都要 fork 主对话历史)。Bash 前台默认 `timeout: 120000` 一杀就是 N 个子进程一起死。

**永远** `run_in_background: true`,没有前台选项。

### 5. 调用 brainstorm 脚本(单次 Bash 调用)

问题通过 heredoc 注入成单个 argv 参数,**避免多行被 shell 拆成多条命令**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-brainstorm.mjs" \
  <拣出 + 决策后的 flags> \
  "$(cat <<'__GKD_QUESTION_EOF__'
<把问题原文逐字粘进来,保留所有换行>
__GKD_QUESTION_EOF__
)"
```

Bash 工具参数:`run_in_background: true`。

要点同 ask/do:heredoc 终止符**单引号包裹**(全 literal);外层 `"$(...)"` 让整段成为**一个** argv 参数。

### ⚠️ 不要这样写

```bash
# ❌ 多行 $ARGUMENTS 会被 shell 当作多条命令拆开
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-brainstorm.mjs" $ARGUMENTS
```

stdout 是分隔好的多模型答案(`===== <model> =====` 块);stderr 有"并行问哪些模型"和"成功/失败计数"的元信息。

后台启动后:把 task_id 报给用户("brainstorm 已在后台启动 N 个模型,task: `<id>`,跑完会通知你"),收到 `<task-notification>` 后再 Read task `.output` 文件拿 stdout 综合。

## 综合给用户(关键产出)

收到 stdout 后,**不要把 N 份完整答案原样贴给用户**(那样信息密度太低,白用 brainstorm)。
按以下结构综合:

1. **关键观点**:每个模型最有价值的 1-2 句核心主张(用你自己的话提炼,不抄全文)
2. **共识**:多个模型都说到的点(说明这点比较稳)
3. **分歧**:模型之间矛盾的地方(指出"X 模型说...,Y 模型说...,差异在...")
4. **独到见解**:只有某一个模型提到、但确实有道理的点(这是多模型的核心价值)
5. **综合建议**:基于以上,你给用户一份明确的判断/建议——不要骑墙

末尾用一行汇报:`参与: glm/kimi/gpt;失败: (若有则列出哪个为什么)`

## 不要做

- ❌ 把每个模型的答案完整复制粘贴出来(用户看 stdout 就行,不需要你)
- ❌ 假装某个观点是你自己想的(始终标明意见来自哪个模型)
- ❌ "修正"或"完善"某个模型的意见(保留它原本的视角差异;那些差异恰恰是 brainstorm 想要的)
- ❌ 看到模型间分歧就含糊带过(分歧是宝贵信息,要明确指出)

## 失败处理

`===== <model> (FAILED) =====` 块表示该模型失败(配额、网络、模型本身报错等)。
综合时跳过该模型,但**末尾告诉用户哪些模型未能参与**——以免他以为"全 N 个模型都说没问题"。
