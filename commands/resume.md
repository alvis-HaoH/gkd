---
description: 接着上次本目录的委派任务继续(续子进程线程)。读/写模式自动从上次会话继承——不需要重传 --write。
argument-hint: '[--<model>] <补充指令(可多行)>'
allowed-tools: Bash(node:*)
---

参考 `gkd-delegate` skill。续上次本目录的委派线程(B 档),让委派模型接着上次的上下文继续干。
**mode 由 runtime 从 `~/.claude/gkd/sessions.json` 自动继承**——上次是 `do`(写)就继续写,上次是 `ask`(读)就继续读。

> 想把读模式的会话**升级**到写模式?直接用 `/gkd:do --resume <补充指令>`(显式传 --write 永远胜过继承)。

原始参数(可能多行,可能含特殊字符):

```
$ARGUMENTS
```

## 步骤(目标:**一次** Bash 调用)

### 1. 拣 flags

`--<modelKey>`、`--json`、`--quiet`、`--model <值>`、`--allowed-tools "<值>"`。
**不要**手动加 `--write` 或 `--resume`——前者由 state 决定,后者由本命令自动加。

### 2. 解析补充指令

第一个非 flag token 起到结尾(保留换行)就是"补充指令"。

### 3. 选运行模式:**默认 Bash 后台**

resume 续上次线程,任务规模通常不会比上次小——同样默认后台。Bash 前台默认 `timeout: 120000`(2 分钟),超时即杀子进程,丢进度。

| 情况 | 怎么跑 |
|---|---|
| **默认** | Bash 调用传 `run_in_background: true` |
| 仅当确信本次补充 < 30 秒(回答一个一行追问) | 前台,且必须 `timeout: 600000` |

不确定时**选后台**。

### 4. 调用 runtime

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" --resume <拣出的 flags> "$(cat <<'__GKD_TASK_EOF__'
<把补充指令原文粘进来,保留所有换行>
__GKD_TASK_EOF__
)"
```

Bash 工具参数:`run_in_background: true`(默认)或 `timeout: 600000`(确信轻量时)。

要点同 `/gkd:ask` / `/gkd:do`:heredoc 单引号终止符 + `"$(...)"` 包成单一 argv 参数。

### ⚠️ 不要这样写

```bash
# ❌ 多行 $ARGUMENTS 会被 shell 当作多条命令拆开
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" --resume $ARGUMENTS
```

## 输出处理

**后台模式(默认)**:
1. Bash 调用立刻返回 task_id 和 `.output` 文件路径。把 task_id 直接报给用户:"GKD 续会话已在后台启动(task: `<id>`),跑完会通知你。" **不要** TaskOutput 阻塞等待。
2. 收到 `<task-notification>` 后,用 Read 读 task 的 `.output` 文件,把 result 汇报给用户。
3. stderr 可能出现 `[gkd] 续会话:从上次继承写模式`——表示这次自动继承了 do 模式。
4. 若 runtime 报"找不到上次的委派线程",说明本目录还没委派过——引导用户改用 `/gkd:ask` 或 `/gkd:do` 发起新委派。
5. stderr 末尾 `❌ 失败` 时,把 result 里的 API 错误原文告知用户。

**前台模式(轻量追问)**:Bash 返回时 stdout 已就绪,跳过 1、2 直接照 3-5 走。
