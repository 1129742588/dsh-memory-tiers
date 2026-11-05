# 缓存优化方案：环境块前置 + 固定 dsh 端口

> 目标：把「每轮固定 757 字失效」降到 **63 字**（只剩端口行），把「重启后整块失效」降到 0。
> 两处改动互相独立，可以分开上线。结论先给：**改动一零风险、立竿见影；改动二动的是 dsh 启动配置，需要备份与回滚路径。**

---

## 一、现状：两个失效源

当前 runtime-context 的拼接顺序（`CONTEXT_ORDERS` 取自 dsh 源码）：

```
persona            90    ← 由插件注册，稳定
working_directory  100
sandbox_policy     110
approval_policy    115
subagent           120
team_identity      125
harness_source     200
web_surface        210   ← 环境段结束，共 757 字
memory-tiers       95    ← 由插件注册，每轮尾部 +75 字
```

`CONTEXT_ORDERS` 是 dsh 的固定分配表（`dsh-system-prompt` 包内）：

```js
const CONTEXT_ORDERS = {
  WORKING_DIRECTORY: 100, SANDBOX_POLICY: 110, APPROVAL_POLICY: 115,
  SUBAGENT_DELEGATION: 120, TEAM_IDENTITY: 125,
  HARNESS_SOURCE: 200, WEB_SURFACE: 210
}
```

问题在于记忆块 order=95 排在 100 之前，它每轮增长 75 字，导致其后 757 字环境段连带失效：

```
每轮 miss = 757（环境段）+ 75（新增内容）≈ 832 字 ≈ 640 token
```

而环境段 77 轮里只变过 3 次，全部由 dsh 重启造成（Web GUI 端口 10318 → 8814 → 10396）。

---

## 二、改动一：把记忆块移到环境段之后

### 2.1 改哪一行

`core/index.mjs:1011-1012`：

```diff
- svc.context({ name: 'memory-tiers-persona', order: 90, text: personaFn, interpolate: false })
- svc.context({ name: 'memory-tiers', order: 95, text: (asm) => buildInjectedBlock(asm), interpolate: false })
+ svc.context({ name: 'memory-tiers-persona', order: 90, text: personaFn, interpolate: false })
+ svc.context({ name: 'memory-tiers', order: memoryOrder(svc), text: (asm) => buildInjectedBlock(asm), interpolate: false })
```

### 2.2 order 取多少：插在「稳定段」与「易变段」之间

环境段不是一整块，按 dsh 的 `CONTEXT_ORDERS` 分开，实测各段字数与变化频率（c5a9b502，70 个快照）：

| 段 | order | 字数 | 版本数 | 怎么变 |
|---|---|---|---|---|
| working_directory | 100 | 96 | 1 | 会话内固定 |
| sandbox_policy | 110 | 266 | 1 | 改策略才变 |
| approval_policy | 115 | 153 | 1 | 改策略才变 |
| harness_source | 200 | 110 | 1 | 升级 dsh 才变 |
| **web_surface** | **210** | **63** | **4** | **每次重启（端口号）** |

**625 字全程不动，只有 63 字的端口行在变。**

所以记忆块插在 `HARNESS_SOURCE(200)` 和 `WEB_SURFACE(210)` 之间，order = **205**：

```
working_directory 100  ┐
sandbox_policy    110  │
approval_policy   115  ├─ 625 字，稳定，命中
harness_source    200  ┘
memory            205  ← 只有尾部 75 字在变
web_surface       210  ← 只有重启时变 63 字
```

不写死 205，跟着 dsh 的分配表取中点：

```js
const memoryOrder = (svc) => {
  try {
    if (typeof svc.getContextOrder === 'function') {
      const a = svc.getContextOrder('HARNESS_SOURCE') // 200
      const b = svc.getContextOrder('WEB_SURFACE')    // 210
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
        return a + Math.floor((b - a) / 2)            // 205
      }
    }
  } catch {}
  return 205 // 兜底
}
```

dsh 将来在 200–210 之间加槽位也不会撞：取的是中点。


### 2.3 人格段为什么不跟着挪

人格段每轮一字不变，属于「稳定内容」。缓存从头连续匹配，越靠前越值钱，所以保持 order=90，让它排在环境段之前。

验收项 4.3「人格段必须在记忆块之前」仍然满足（90 < 205）。

### 2.4 旧宿主的 section 分支不动

`core/index.mjs:1016-1017` 的 20000/20100 是给没有 `context()` 的老宿主用的，与缓存无关，保持原样。

### 2.5 三种插入点的取舍

同一次实测（c5a9b502，77 轮）算出的普通轮 miss：

| | 记忆块 order | 每轮 miss | token | 200 轮/天 | 重启一次损失 |
|---|---|---|---|---|---|
| 现状（块在最前） | 95 | 2,343 字 | 766 | 468,600 字 | 0（本来每轮都在丢） |
| **易变段之后** | **205** | **1,718 字** | **579** | **343,600 字** | **63 字** |
| 全部之后 | 220 | 1,655 字 | 558 | 331,000 字 | 11,569 字 |

平衡点：**每天重启 1.1 次**。

- 一天重启 ≥ 2 次 → 选 205；
- 一天重启 ≤ 1 次，或已经固定了端口 → 选 220（把 205 改成 220 即可，一个数字）。

开发期间经常重启 dsh，205 是更稳的默认；等端口固定方案上线并验证通过，再改成 220。

### 2.5.1 但最大的一项不在这里

上面 1,718 字里，**`skill-catalog` 占 1,576 字（92%）**。它排在用户消息之后，而用户消息每轮都变，所以它每轮都位置漂移、每轮全 miss，尽管内容一个字都没改。

这是当前 miss 的最大单项，比环境段 688 字还多一倍：

| 项 | 字符 | 占普通轮 miss |
|---|---|---|
| skill-catalog | 1,576 | 67%（现状口径） |
| 稳定环境段 | 625 | 27% |
| 记忆块新增 | 75 | 3% |
| 端口行 | 63 | 3% |

它改不了 —— 顺序由 dsh 的 pre-step 决定（`dsh-tool-skill` 把目录 append 在 `decision.messages` 末尾）。插件侧只能等 dsh 把目录提到用户消息之前，或者塞进 runtime-context。

**三个方案叠加后的终点**：`75 + 4 = 79 字 ≈ 27 token/轮`，是现在的 1/28。

### 2.6 验证方法

1. 开新会话，连发 5 轮短消息（每轮几十字，不触发工具）。
2. 取 session id 跑：

```bash
node scratch/token-report.mjs <session-id> --all
```

3. 判读：
   - 普通轮未缓存 token 应从 **~766 掉到 560–600**（省的就是 625 字稳定环境段）；
   - 约每 4–5 轮会出现一轮比平时多约 90 token 的，那是 time-context（262 字时间戳）；
   - 重启后的第一轮也应在 600 以内（不再整块失效）；
   - `cacheRead` 逐轮单调增长；
   - 日志出现 `INJECT_ORDER runtime-context-before-user` 说明 hoist 仍生效。
4. 顺手验证人格段位置：导出快照看 `## 你是` 是否仍在 `## L1` 之前。

### 2.7 风险

| 风险 | 评估 |
|---|---|
| 其他插件注册了 200–210 之间的 context | 会与 205 撞位，按名字排序。可接受，但若出现异常改用 206 |
| dsh 升级改了 `CONTEXT_ORDERS` | 用 `getContextOrder` 取中点，自动跟随；API 消失则回落 205 |
| L1/L2/L3 内部顺序 | 不受影响，块内部结构完全没动 |

**结论：这一改只动一个整数，不碰记忆逻辑、不碰检索、不碰压缩。**

---

## 三、改动二：配置页增加「固定 dsh 端口」

### 3.1 为什么需要

dsh 的 webserver 默认 `port: 0`，由操作系统随机分配。端口号会写进 runtime-context 的环境段：

```
Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:10396"
```

每次重启换一个端口 → 环境段变化 → 前缀从那一行断开 → 整段缓存失效一次。固定端口后，这一行永远不变。

### 3.2 dsh 的配置点

`@deepseek-ai/dsh-web-app/cordis.patch.yml` 里：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

用户在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加一条按 id 覆盖的 patch 即可（该文件是官方指定的用户 patch 层，语义是深合并 config）：

```yaml
- id: webserver
  config:
    port: 10396
```

命令行 `--port` 优先级更高，但桌面版的启动参数不好改，走 patch 更稳。

### 3.3 插件侧设计

#### 新增两个配置项（`core/settings.mjs` 的 SCHEMA）

放在新分组 `缓存` 下，页面自动渲染（现有实现按 `group` 分块 + `showIf` 联动）：

```js
{
  group: '缓存', path: 'cache.fixedPort.enabled', type: 'boolean', default: false,
  label: '固定 dsh 端口',
  hint: 'dsh 默认每次启动随机选端口，端口号写进环境段，重启后前缀缓存要重付一遍。开启后由插件写入 profile 配置。改完需重启 dsh 生效。',
},
{
  group: '缓存', path: 'cache.fixedPort.port', type: 'number', default: 10396,
  min: 1024, max: 65535, step: 1,
  label: '端口号', showIf: { path: 'cache.fixedPort.enabled', eq: true },
  hint: '选一个不常用的高端口。保存前会先检查占用；被占用时拒绝写入并提示换一个。',
},
{
  group: '缓存', path: 'cache.fixedPort.profileDir', type: 'dir', default: '',
  label: 'profile 目录（留空自动探测）', wide: true,
  showIf: { path: 'cache.fixedPort.enabled', eq: true },
  hint: '默认自动找 bundle 里含 @deepseek-ai/dsh-web-app 的 profile，通常是 <DSH_HOME>/profiles/desktop。',
},
```

#### 保存时的动作（`core/settings.mjs` 的写配置路径）

```
① 端口可用性检查：node:net 起一个临时 server listen(port)，EADDRINUSE 则报错拒绝保存
② 定位 profile：用户填的 > 自动探测（profiles/*/package.json 的 dsh.profile.bundles 含 web-app）
③ 备份：cordis.patch.yml → cordis.patch.yml.bak-port-<timestamp>
④ 幂等写入：先删除旧的标记块，再在文件末尾追加新块
⑤ 回读校验：确认块存在、port 值正确、文件行数只增不减
⑥ 任何一步失败 → 还原备份、把错误抛给页面
```

写入的块长这样（带标记，便于反复覆盖与一键还原）：

```yaml
# >>> dsh-memory-tiers: fixed-web-port（自动生成，勿手改）
- id: webserver
  config:
    port: 10396
# <<< dsh-memory-tiers: fixed-web-port
```

关闭开关时只做 ④ 的删除部分，把块摘掉，恢复 dsh 的随机端口行为。

#### 页面回显

设置页的「现在怎么样（只读）」区块加一行：

```
固定端口    未启用 / 已写入 10396（重启后生效） / 写入失败：端口被占用
```

### 3.4 为什么不能"保存即生效"

端口在 dsh 启动时绑定，插件运行在 dsh 进程内，无法改自己所在进程的监听端口。所以这个开关的性质是「**写配置，等下次启动**」。

页面必须明确标注「需重启 dsh」，否则用户会以为没生效。

### 3.5 风险与回滚

#### 唯一的真实故障：端口被占用

dsh 的 `webserver` 行监听失败时会**拒绝该行初始化**（dsh 文档原文：*"A listen failure (for example EADDRINUSE) rejects plugin initialization with the bind diagnostic"*）。后果不是进程崩溃，而是 web 服务没起来 —— 桌面版表现为窗口打不开界面。用户很容易误判成「dsh 坏了」。

默认的 `port: 0` 永远不会有这个问题，这是固定端口唯一的代价。

#### 不会出问题的地方

| 担心 | 实际情况 |
|---|---|
| 开两个 dsh 抢端口 | **不存在**。桌面版启动即 `requestSingleInstanceLock()`，第二个实例直接 `quit()` 并聚焦已有窗口 |
| 前端连不上 | URL 本来就是每次启动都变，前端每次按新 URL 连；固定后只是「变成同一个」 |
| 会话/插件/记忆库 | 与端口无关，全部走文件系统 |
| 防火墙 | 固定后只弹一次授权，比每换一次端口弹一次更好 |
| 权限 | 1024 以下在 Linux/macOS 需要 root，所以范围限制在 1024–65535 |

#### Windows 特有的坑

Hyper-V / WSL / Docker 会**动态保留大段端口**，落在保留段里的端口 bind 会失败，而且 `listen()` 探测同样会失败（表现为 EACCES 或直接 EADDRINUSE）。所以：

- 不要选 8080、3000、5000 这类常用端口；
- 建议 39000–39999 这种冷门段；
- 探测时同时试 `127.0.0.1` 与 `0.0.0.0`，任一失败即拒绝。

#### 一个行为变化（不是 bug）

浏览器的 localStorage / IndexedDB 按 **origin** 隔离，而 origin 含端口。现在每次重启换端口 = 每次都是「新站点」，UI 状态自动重置；固定端口后，UI 的本地状态（草稿、展开的面板、上次选中的模型等）会跨重启保留。

多数情况这是好事，但如果哪天 UI 出现「重启也没恢复」的怪状态，先清一次站点数据。

#### 缓解与回滚

| 风险 | 缓解 |
|---|---|
| 端口被占用 → web 服务起不来 | 保存前 listen 探测（EACCES/EADDRINUSE 均拒绝）；拒绝时不写文件 |
| 写入后端口才被占（后来装了别的软件） | 页面提供「检查当前端口」按钮；起不来时手动删标记块即可 |
| YAML 写坏 → dsh 起不来 | 只追加/删除固定文本块，不碰其他行；写前备份；写后回读校验 |
| 用户想还原 | 关开关自动摘块；或手动删掉标记块；或 `cp cordis.patch.yml.bak-port-* cordis.patch.yml` |
| 探测不到 profile | 允许手填目录；仍失败则报错，不写任何文件 |

### 3.6 验证方法

1. 页面上开启、填 10396、保存 → 检查 `cordis.patch.yml` 末尾出现标记块。
2. 重启 dsh → 环境段的 `Web GUI URL` 应为 `http://127.0.0.1:10396`。
3. 再重启一次 → 端口不变，环境段一字不变。
4. 跑 `token-report`，重启后的第一轮 miss 应与普通轮相同（不再有整段失效）。

---

## 四、实施顺序

| 步骤 | 改动 | 风险 | 生效方式 |
|---|---|---|---|
| 1 | order 动态取值（`index.mjs:1011-1012`） | 低 | 重载插件 |
| 2 | SCHEMA 两项 + 写 patch 逻辑（`settings.mjs`） | 中 | 重启 dsh |
| 3 | 页面回显与提示（`client.mjs`） | 低 | 热更新 |

建议先做 1，用真实会话验证 757 消失，再做 2/3。这样即使端口方案出问题，缓存收益已经拿到手。

---

## 五、明确不做的事

- 不改 L1/L2/L3 的容量、比例、溢出策略；
- 不改检索逻辑与压缩策略；
- 不改 `moveRuntimeContextFirst`（hoist 已经生效，是本方案的前提）；
- 不碰 dsh 内部的 `CONTEXT_ORDERS`，只读取；
- 不自动重启 dsh。
