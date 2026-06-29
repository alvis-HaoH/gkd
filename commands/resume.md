---
description: 接着上次本目录的委派任务继续(续子进程线程)。读/写模式自动从上次会话继承——不需要重传 --write。
argument-hint: '[--<model>] <补充指令(可多行)>'
allowed-tools: Bash(node:*)
---

续上次本目录的委派线程(B 档),让委派模型接着上次的上下文继续干。
**mode 由 runtime 从 `~/.claude/gkd/sessions.json` 自动继承**——上次 `do`(写)就继续写,上次 `ask`(读)就继续读。想把读会话升级到写,直接用 `/gkd:do --resume <补充>`(显式 `--write` 永远胜过继承)。

原始参数:

```
$ARGUMENTS
```

## 怎么做

1. **拣 flags**:`--<modelKey>`、`--json`、`--quiet`。**不要**手动加 `--write`(由 state 决定)或 `--resume`(本命令自动加)。
2. **跑**(补充指令第一个非 flag token 起,保留换行):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" --resume <拣出的 flags> "$(cat <<'__GKD_TASK_EOF__'
<补充指令原文,保留换行>
__GKD_TASK_EOF__
)"
```

单引号 heredoc 终止符 + 外层 `"$(...)"` 包成单个 argv 参数(同 ask/do)。

3. **运行模式**:**默认 `run_in_background: true`**(续上次线程,规模通常不小)。只有确信本次补充 < 30 秒才前台,且必须 `timeout: 600000`。

## 输出处理

- 后台:报 task_id 给用户,收到 `<task-notification>` 后 Read `.output` 汇报 result。
- stderr 出现 `[gkd] 续会话:从上次继承写模式` 表示这次自动继承了 do 模式。
- runtime 报"找不到上次的委派线程" = 本目录还没委派过,引导用户改用 `/gkd:ask` 或 `/gkd:do` 发起新委派。
- `❌ 失败` 时把 result 里的 API 错误原文告知用户。
