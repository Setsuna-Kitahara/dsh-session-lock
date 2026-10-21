# dsh-session-lock

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的会话上一把锁：**锁住的会话，任何归档路径都动不了它。**

> DSH's sidebar **archive** hides a session from the list while keeping its data on disk.
> This plugin adds a lock button to every sidebar row; a locked session is refused by every
> archive path — the ⋮ menu, another plugin, or a maintenance script calling
> `workspaces.archiveSession`. The host half also exposes an `archive-inactive` route that
> bulk-archives stale sessions while **always** skipping the locked ones.

MIT · 零运行时依赖 · 需要 DSH `>= 0.1.5-rc.1`

---

## 为什么需要它

DSH 侧栏的「归档」是一个**隐藏但不删数据**的动作：点一下，会话就从列表里消失了。

- 手滑点错菜单，正在跟的会话就不见了；
- 批量整理脚本、维护任务、别的插件走 `workspaces.archiveSession` 批量归档时，分不清哪些是你还要用的；
- 归档是**不可逆的 UI 操作**（数据还在 `$DSH_HOME/sessions/` 里，但要找回来得手动翻目录）。

`dsh-session-lock` 把这些会话挑出来锁上：锁在宿主里，和浏览器无关；锁定之后所有归档路径都会被拒绝，并且告诉你原因。

## 特性

| 特性 | 说明 |
| --- | --- |
| 侧栏锁按钮 | 每个会话行一个 20×20 的锁图标：空心锁 = 未锁，琥珀色实心锁 = 已锁，同时该行左侧有一条琥珀色细边 |
| 全路径拦截 | 侧栏 ⋮ 菜单、其它插件、脚本调用的 `workspaces.archiveSession` 都会被拦下，弹提示说明原因，会话不会被隐藏 |
| 宿主持久化 | 锁清单在 `$DSH_HOME/plugin-data/dsh-session-lock/locks.json`，换浏览器、清缓存、重启 dsh 都在 |
| 批量归档不活跃会话 | 宿主路由 `POST /plugins/dsh-session-lock/archive-inactive`，供每日维护任务调用；**上锁的会话永远被跳过** |
| 零运行时依赖 | 浏览器半边是纯 DOM + 一个 `fetch`，不 require 任何宿主内部包，宿主内部包改名不会影响它 |
| 只读安全 | 除锁清单外不写任何东西；归档走进程内官方注册表，不直接改 `storages/workspace.json` |

## 安装

需要 DSH `>= 0.1.5-rc.1`；`<profile>` 是你的 profile 名（多数人是 `web`）。

### 方式一：插件市场

如果你装了插件市场 `dshmarket`，直接在市场里搜 `dsh-session-lock` 安装即可（它会把包名写进 `dsh.profile.bundles`）。

### 方式二：命令行

```sh
# 1. 装依赖（dsh plugin 会把参数原样转发给 profile 目录里的 pnpm）
dsh plugin --profile web add dsh-session-lock

# 2. 把 "dsh-session-lock" 追加到 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 列表里
#    （bundles 决定哪些包会被挂载；只装依赖不写这一段，插件不会加载）

# 3. 重启 dsh（宿主半边不参与热加载）：托管在 systemd 上就是
#    systemctl restart dsh-web，其它部署方式重启你启动 dsh 的那个进程
systemctl restart dsh-web
```

### 方式三：本地源码

```sh
git clone https://github.com/Setsuna-Kitahara/dsh-session-lock
dsh plugin --profile web add link:/path/to/dsh-session-lock
# 同样要把 "dsh-session-lock" 加进 dsh.profile.bundles，然后重启 dsh-web
```

### 卸载

```sh
dsh plugin --profile web remove dsh-session-lock
# 从 dsh.profile.bundles 里删掉那一行，重启 dsh-web
```

锁清单文件会留下，不需要时手动删 `$DSH_HOME/plugin-data/dsh-session-lock/locks.json`。

## 使用

1. 刷新一次浏览器页面（客户端半边会随 `dsh-client-modules` 一起加载）。
2. 侧栏每个会话行最左边出现一个锁按钮，点它就是锁定／解锁，**整个按钮都能点**（图标在按钮正中间，不会把点击吃掉）。
3. 锁定后试着从 ⋮ 菜单归档它：会被拦下，并弹出一条「该会话已锁定，未被归档」。
4. 批量归档不活跃会话（可选）：

```bash
curl -sS -X POST http://127.0.0.1:3080/plugins/dsh-session-lock/archive-inactive \
  -H 'x-dsh-session-lock: 1' -H 'content-type: application/json' \
  -d '{"days":3,"dryRun":true}'
```

先 `"dryRun":true` 看候选列表，确认无误再去掉 `dryRun` 真归档。

## HTTP 接口

所有路由都在 `/plugins/dsh-session-lock/` 下，都要求 `x-dsh-session-lock: 1` 请求头
（这是一个跨站表单发不出来的非简单头），并拒绝显式的 `sec-fetch-site: cross-site`。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/locks` | GET | `{ ok, locked: string[], records }` —— 当前锁清单 |
| `/set` | POST | `{ sessionId, locked, note? }` —— 上锁／解锁一个会话 |
| `/unlock-all` | POST | 清空全部锁 |
| `/health` | GET | `{ ok, count, path }` —— 锁清单路径与条数 |
| `/archive-inactive` | POST | `{ days?: 3, dryRun?: false, sessionIds?: string[] }` —— 归档不活跃且未上锁的会话 |

`archive-inactive` 的判定与豁免：

- **口径**：会话目录里 `session.*.jsonl(.zstd)` 的**最新 mtime** 早于 `now - days*24h`，即视为不活跃。默认 3 天，上限 3650 天。
- **豁免顺序**：已上锁 → 已归档 → 未到期 → 正在运行（`ctx.sessions.get(id)` 命中）→ 不在 `sessionIds` 白名单里（给了白名单时）。
- **fail-closed**：锁清单直接读盘、不用内存缓存，**读不出来就整次拒绝**（503），一个都不归档——宁可不归档，也不归档一个用户锁住的会话。
- 走 `ctx.workspaceRegistry.archiveSession()`，即官方进程内写路径；不要绕过它去改 `$DSH_HOME/storages/workspace.json`（那是运行中进程内存状态的镜像，外部改写会被下一次写回覆盖）。
- 单次最多归档 500 个；返回 `{ ok, dryRun, days, cutoff, scanned, candidates, archived, failed, truncated, skipped{locked,live,alreadyArchived,recent} }`。
- **刻意不做回环（loopback）围栏**：本插件常见部署是 nginx 反代域名访问的，socket 对端是本地代理、`Host` 是公网域名，回环围栏会把正常用法直接挡掉。防护靠上面那个自定义请求头。

## 工作原理

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 宿主 | `lib/index.js` | 锁账本（临时文件 + rename 原子整文件写）+ 五条 HTTP 路由（含 `archive-inactive`） |
| 浏览器 | `lib/client.js` | 包装 `workspaces.archiveSession`、给侧栏会话行注入锁按钮、提示条 |
| 自测 | `test/*.test.mjs` | 用假的 cordis ctx / DOM 驱动真代码，离线跑，不碰任何真实 DSH 状态 |

几个实现上的点，读代码前先知道会省事：

- **浏览器半边从会话行的 React fiber 上读会话 id**。侧栏不把会话 id 写进 DOM，fiber 上 row 组件的 props 是唯一稳定的句柄；读不到就不装饰该行——宁可少画一个按钮，也不猜错会话。
- **拦截器包裹的是 `workspaces.archiveSession` 这个方法引用，并每 3 秒重新断言一次**：同级插件（以及本插件自己的 HMR 重载）可能替换掉它。
- **按钮的重绘是幂等的**：侧栏扫描挂在 `MutationObserver(document.body)` 上，任何 DOM 变更都会触发一轮重绘。因此 `paintButton` 只在图标状态真正变化时才写 `innerHTML`（`.dsh-session-lock-btn>svg { pointer-events:none }` 是第二道保险）。**不要**把它改成无条件 `innerHTML`：那会每帧替换 `<svg>` 子节点，而浏览器在 mousedown 目标被移出 DOM 后不会再派发 `click`，结果是图标区域点不动、只有按钮边缘一圈有反应。

## 设计取舍

诚实地说清楚边界，比事后解释便宜：

- **只拦「归档」，不拦「彻底删除」。** 删除走的是另一条链路（`dsh-archived-chats` 等），本插件不接管。
- **浏览器半边是 fail-open，宿主半边是 fail-closed。** 客户端拦截器读不到锁清单时账本视为空，归档会正常执行——在「拦下一个用户没锁的会话」和「放走一个用户锁了的会话」之间，客户端侧选了后者（读失败会在控制台留 warn 并弹提示条）。而 `archive-inactive` 相反：读不出锁清单就整次拒绝。
- **多标签页不做实时同步。** 客户端在加载时读一次锁清单，之后每次切换锁都会重读；另一个标签页里的改动要等本页下一次切换或刷新才可见。宿主账本始终是唯一事实来源，所以不会写错。
- **宿主半边改动不参与 HMR**（只有客户端半边会），改完要重启 `dsh-web`。

## 开发与测试

```sh
node test/archive-inactive.test.mjs    # 宿主半边：路由、扫描口径、fail-closed
node test/client-decoration.test.mjs   # 浏览器半边：注入、重绘稳定性、点击目标
# 或者
npm test
```

两个测试都是**自足**的：宿主的用临时 `$DSH_HOME` 造假会话目录，客户端的自带一个
~120 行的 DOM stub，都不需要跑着一个 DSH，也不会写你的真实状态。

客户端那个测试专门守着本文档上面提到的那个坑：25 次重绘必须**零** `innerHTML` 写入、
`<svg>` 节点身份必须不变；把 `paintButton` 改回无条件重写，它会立刻失败。

## 常见问题

**点了锁按钮没反应？**
先刷新一次页面（客户端半边是随页面加载的）。若仍无反应，打开浏览器控制台看有没有
`session-lock` 的报错：宿主路由挂了（例如没写进 `dsh.profile.bundles`，或忘了重启 `dsh-web`）时，
`/locks` 会 404。

**锁按钮为什么不是圆形的、为什么这么小？**
它按侧栏行高做的 20×20，图标 14×14，跟 DSH 自带的行动作按钮同尺寸。悬停时会出现底色。

**锁定会话会不会阻止 DSH 自己删数据？**
不会。锁只作用于「归档」这一个动作。

**能用 curl 从别的机器上锁吗？**
接口只要求 `x-dsh-session-lock: 1` 头，能访问到 DSH 的 HTTP 端口就能调用；
反代部署时请自行在反代层做访问控制。

## 更新日志

### 0.1.0

首个公开版本。

- 修复：锁按钮只有边缘一圈能点、鼠标压到锁图标上就失效。原因有两个，都是客户端半边的：
  (1) 重绘循环每帧重写 `innerHTML`，把 mousedown 落点的 `<svg>` 换掉，浏览器随即丢弃这次 `click`；
  (2) 按钮从未被加上 CSS 里定义的那个 class，尺寸/hover/锁定态样式其实一直是死的。
  现在重绘幂等、class 由代码负责、图标对指针透明，并加了回归测试。
- 新增：宿主半边的测试改为自足运行（临时 `$DSH_HOME`），不再依赖真实机器上的会话目录。

## 许可

[MIT](LICENSE) © 2026 Setsuna-Kitahara

DSH 本身由 DeepSeek 维护，本插件是独立的第三方插件，与 DeepSeek 官方无关。
