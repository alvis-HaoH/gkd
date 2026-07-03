---
description: 接着委派任务继续(续子进程线程)。默认续本目录上次;也可凭模糊描述点名续任意历史/跨目录 session。读/写模式自动继承——不需要重传 --write。
argument-hint: '[--<model>] <补充指令(可多行)>'
allowed-tools: Bash(node:*)
---

续委派线程(B 档),让委派模型接着上次的上下文继续干。**用户几乎不会给 sessionId——他只会说"接着刚才"或模糊描述"上次那个改配置的"。把这句话对应到哪个 session 是你(主 Claude)的活**,三种情况:

- **续本目录上次**(最常见):用户只说"接着刚才/上次继续" → 不带 id,`--resume` 让 runtime 取本目录最近一次续上。
- **模糊描述某次历史委派**("上次那个改配置的"/"让 kimi review 的那次"/"别的项目里写文档那个") → 走**检索 SOP**(下方)把描述翻成 sessionId,再 `--resume <id>` 续(可跨目录,runtime 自动定位归属目录并在那里运行)。
- **用户直接粘了 UUID** → 直接 `--resume <id>`。

**mode 自动继承**:上次 `do`(写)就继续写,上次 `ask`(读)就继续读(从委派记录恢复)。想把读会话升级到写,用 `/gkd:do --resume [<sessionId>] <补充>`(显式 `--write` 永远胜过继承)。

原始参数:

```
$ARGUMENTS
```

## 怎么做

1. **拣 flags**:`--<modelKey>`、`--json`、`--quiet`。**不要**手动加 `--write`(由继承决定)。

2. **定位要续哪个 session**(三种情况见开头):续本目录上次 → 不带 id;模糊描述 → 走检索 SOP(下一节)拿 id;用户直接粘 UUID → 直接用。**注意**:别因补充指令里恰好有类 UUID 串(trace id/GUID)就误拣成 `--resume <id>`,拿不准就当普通续——runtime 侧有 UUID 正则闸门兜底。

3. **跑**(补充指令第一个非 id/flag token 起,保留换行):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-runtime.mjs" --resume <可选 sessionId> <拣出的 flags> "$(cat <<'__GKD_TASK_EOF__'
<补充指令原文,保留换行>
__GKD_TASK_EOF__
)"
```

点名续时 `--resume` 紧跟 sessionId(如 `--resume 550e8400-e29b-41d4-a716-446655440000`);续上次则只写 `--resume`。单引号 heredoc 终止符 + 外层 `"$(...)"` 包成单个 argv 参数(同 ask/do)。

4. **运行模式**:**默认 `run_in_background: true`**(续上次线程,规模通常不小)。只有确信本次补充 < 30 秒才前台,且必须 `timeout: 600000`。

## 检索 SOP:模糊描述 → sessionId

用户模糊描述某次历史委派("续上次那个改配置的")时,**别自己 Read/grep delegations.jsonl**(每行含大量 token 噪音,直接读会污染上下文)。用内部检索脚本 `gkd-find-session.mjs`——它已内建投影(剥噪音)、关键词/目录/时间过滤、追 fork 链到最新节点、限量:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gkd-find-session.mjs" <关键词...> [--all-cwd] [--days N] [--limit N] [--model <key>] [--last]
```

- **关键词**:对任务摘要做子串匹配(多个 = 任一命中)。用户说"改配置"就传 `配置 config models`。
- **默认只看当前目录**、时间倒序(最新在前);跨目录/别的项目找加 `--all-cwd`;要更早的加 `--days N`;按模型筛加 `--model glm`(用户说"上次 kimi 看的那个");用户就说"接着刚才/上次"没别的线索时,`--last` 直接拿当前目录最新一条。
- 输出每条已是**该 fork 链的最新节点**(累积了全部续接上下文),`id:` 那行可直接拿去 `--resume <id>`。`[续接]` 标记表示它是 fork 出来的节点,任务摘要取自该链发起行。

**决策**:
- **唯一高置信候选** → 直接用它的 id 续,一句话告诉用户续的是哪个("续的是今天那条改 models.json 的 glm 链,最新到 14:50")。
- **多个候选** → 把脚本输出的 2-5 条(时间/模型/读写/任务摘要)列给用户认,别瞎猜。
- **脚本返回空** → 按提示放宽(去关键词 / `--all-cwd` / `--days`);仍无 → 告诉用户没检索到,可能没委派过或日志被清,引导发起新委派。

> ⚠️ `delegations.jsonl` 的 `task` 含**原始任务文本**,属本地敏感数据,别外传/贴到公开处。

## 输出处理

- 后台:报 task_id 给用户,收到 `<task-notification>` 后 Read `.output` 汇报 result。
- stderr 出现 `[gkd] 续会话:从上次继承写模式` / `[gkd] 点名续会话:...` 表示这次继承/恢复了模式。
- **点名续 id 是从那个 session fork 出新分支**(不是原地续写):反复续同一个旧 id 会各自开一条平行分叉。想链式往下续,续完后用新打印的 session id、或回到该目录直接 `/gkd:resume`。
- **跨目录点名续接后,新 session 记账到它的归属目录(而非你当前目录)**:所以随后在当前目录敲**不带 id** 的 `/gkd:resume` 不会顺着刚才那次跨目录续接,而是续当前目录自己的上次委派。想接着刚才那条,请再次点名 id 或用模糊描述检索(这是刻意设计——跨目录续本就是显式点名行为,不做隐式链式)。
- runtime 报"找不到 session ... 的 jsonl" = id 错了/文件被清理/是别的机器的 session;报"找不到上次的委派线程" = 本目录还没委派过,引导用户改用 `/gkd:ask` 或 `/gkd:do` 发起新委派。
- `❌ 失败` 时把 result 里的 API 错误原文告知用户。
