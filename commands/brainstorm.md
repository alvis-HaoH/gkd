---
description: 多模型并行对同一问题各给独立意见(发散式 brainstorming),主 Claude 综合分歧、共识、独到见解。各模型彼此看不到对方答案,避免回声室效应。
argument-hint: '[--models a,b,c] [--with-context] <问题(可多行)>'
allowed-tools: Bash(node:*), AskUserQuestion
---

把多模型并行的独立意见交回综合。**这是发散式形态——每个模型在干净独立的上下文里答题,彼此不可见**,故意避开 sycophancy / 回声室效应。

原始参数:

```
$ARGUMENTS
```

## 怎么做

1. **拣 flags**:`--models a,b,c`、`--with-context`、`--json`、`--quiet`。

2. **`--with-context` 默认不带**:brainstorm 的卖点是独立性,带主对话历史会污染独立性 + N 倍成本。只有用户显式要求、或问题强回指主对话(评估"上面的"那个方案)时才考虑。不确定时用 `AskUserQuestion` 问一次(带历史 / 干净独立答题)。

3. **跑**(问题文本第一个非 flag token 起,保留换行,**永远 `run_in_background: true`**——N 模型并行,最慢那个常超 2 分钟):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-brainstorm.mjs" <拣出的 flags> "$(cat <<'__GKD_QUESTION_EOF__'
<问题原文,保留换行>
__GKD_QUESTION_EOF__
)"
```

单引号 heredoc 终止符 + 外层 `"$(...)"` 包成单个 argv 参数。报 task_id 给用户,收到 `<task-notification>` 后 Read `.output` 拿 stdout(`===== <model> =====` 分块)。

## 综合给用户

**别把 N 份完整答案原样贴出来**(那样白用 brainstorm)。你的价值是提炼:用自己的话讲清每个模型的核心主张,**明确指出共识(哪点稳)、分歧(谁说什么、差在哪)、独到见解(只有某个模型提到但有道理的点——这是多模型的核心价值)**,最后给一份明确判断,不骑墙。始终标明观点来自哪个模型,别假装是自己想的,也别"修正"某个模型的视角差异(那些差异正是想要的)。

末尾一行汇报:`参与: <实际参与的模型>;失败: (若有则列出哪个为什么)`。`===== <model> (FAILED) =====` 块表示该模型失败,综合时跳过但**务必告诉用户哪些没参与**,以免他以为全员都说没问题。
