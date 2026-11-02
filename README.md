# dsh-memory-tiers · 六层记忆 + 历史压缩

> **v0.6.0**（2026-11-01）。架构细节、实测数据、踩过的坑全在 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
> 本文只讲「它干什么」和「怎么用」。
>
> 架构文档按主题分了 A–D 四个区，开头有**变更索引**（哪个版本改了什么、在第几节）。
> 改代码前先看那里，别只看本文——本文为了好读，省略了大量约束和实测数据。

## 它做三件事

1. **自动记忆**：订阅 `session/event`，每轮结束把你说的话、我调的工具写进记忆（L1），
   满了自动摘要沉淀到 L2/L3 和深层 DL1/DL2/DL3。
2. **注入上下文**：每轮把 L3（长期摘要）+ L2（最近沉淀）+ L1（刚发生的，默认开）
   作为一条 user 快照**追加**在末尾注入，内容不变就不刷新。
   追加在末尾，所以前面历史的 prompt cache 不受影响。
3. **接管历史压缩**：每轮结束把 dsh 自带的会话历史全部压成一条 20 字占位（默认一条不留），
   **零 LLM 调用**，被压掉的内容先归档进记忆。上下文因此保持恒定，不随轮数增长。

## 文件清单

| 文件 | 作用 |
|---|---|
| `index.mjs` | dsh 插件入口：注册工具、订阅事件、注入上下文、调度压缩 |
| `memory5.mjs` | 六层记忆核心：分层、热度、摘要、路由、检索、遗忘 |
| `compaction.mjs` | 历史压缩：把 dsh 的 surface 压成占位，原文归档进记忆 |
| `silicon.mjs` | 模型层：embed / 摘要 / 判关系（无 key 时语义检索关闭，只走关键词） |
| `client.mjs` | 设置页前端（React section，挂 dsh「设置 → 记忆」） |
| `settings.mjs` | 设置页后端：`/dsh-memory/api/*`，读写 config.json（字段白名单） |
| `dshllm.mjs` | 借 dsh 自己的通道调**当前会话模型**（融合/摘要可跟它走，不用自己的 key） |
| `reindex.mjs` | 换 embed 模型后重建向量库（`--dry` 可先体检） |
| `cordis.patch.yml` | 告诉 dsh 怎么把插件插进配置树 |
| `package.json` | 包信息，`dsh.bundle.patch` 是关键字段 |
| `ARCHITECTURE.md` | 完整架构、实测数据、已知问题清单（**权威文档**） |

## 安装

```bash
# 方式一：链接本地目录（改代码立刻生效，开发时用）
cd ~/.dsh/profiles/desktop
pnpm add "link:/path/to/dsh-memory-tiers"

# 方式二：装打包好的 tgz（分发用）
cd ~/.dsh/profiles/desktop
pnpm add /path/to/dsh-memory-tiers-0.3.0.tgz
```

然后把 `dsh-memory-tiers` 加进该 profile `package.json` 的 `dsh.profile.bundles`，**重启 dsh**。

配置文件在 `<数据目录>/config.json`，首次启动自动生成。

### 数据目录（可指定，便于备份迁移）

默认 `~/.dsh/storages/memory-v5`。想换地方，用环境变量（支持 `~`）：

```bash
export MEMORY_TIERS_DIR="~/my-memory"    # 或 D:/backup/memory
```

或在插件配置里传 `dir`。**改不了 config.json 里的路径**——那个文件就在目录内部。

整个目录是自包含的：`store.json` + `vectors-part-*.json` + `archive/` + `graveyard/` +
`config.json`。**拷走整个目录，换个 agent、换个机器，改一下 `MEMORY_TIERS_DIR` 就能接着用。**

## 打包

```bash
npm pack --pack-destination ./dist
```

产物 `dist/dsh-memory-tiers-<版本>.tgz`，只含 `package.json` 里 `files` 列出的运行时文件
（测试、模拟脚本、数据集都不打进去）。**新增文件记得同步 `files`**，
漏了会在安装后才炸（`ERR_MODULE_NOT_FOUND`）——`compaction.mjs` 就差点栽在这。

---

## 以下是 v1 时代的设计笔记（**历史存档，勿照着改**）

> ⚠️ 这一整段描述的是早期原型，和当前实现差异很大（层名、参数、检索方式都变了）。
> 留着只作背景。**要改代码请以 `ARCHITECTURE.md` 为准**。


## 第一步：先看它跑起来（不用装 dsh）

```bash
cd dsh-memory-tiers
node test.mjs
```

你会看到完整的生命周期：5 条记忆先全落在 L1 → 时间快进 4 天 → 3 条升 L2、2 条沉到 `archive/*.md` → 搜"验证"能翻出旧账 → 搜"环境"把冷存那条拉回来（回温）。最后打印出"每轮注入的提示词"长什么样。

**这一步是你理解它的最快方式**，比读文档快十倍。

## 第二步：装进 dsh（已在你机器上做好了）

> **重要事实（我实测过）**：桌面版 dsh 的 `desktop` profile 被 Electron 应用独占，命令行装不进去 —— 会报
> `error: profile "desktop" is managed exclusively by the Electron application`。
> 所以插件装在了独立的 `web` profile 里，用 `dsh web` 启动的那个实例。

装的时候需要 pnpm（dsh 的插件管理就是转发给 pnpm），我已经装好了（`pnpm 12.15.0`）。

```bash
# 已经执行过的两条，你不用再跑
npm i -g pnpm
cd dsh-memory-tiers && npx -y @deepseek-ai/dsh plugin --profile web add ./
```

装完之后 `~/.dsh/profiles/web/package.json` 里会多出 `"dsh-memory-tiers": "link:...你的目录"`。
**因为是 link，所以你改了 `memory.mjs` 重启就生效，不用重装。**

## 第三步：启动并验证

```bash
npx -y @deepseek-ai/dsh web
```

浏览器会打开 `http://127.0.0.1:3080/?token=...`（token 每次不同，别用旧的）。

验证插件真的活着，看这个文件：

```bash
cat ~/.dsh/storages/memory-tiers/status.json
```

```json
{
  "loadedAt": "2026-10-26T09:02:17.193Z",
  "tools": 6,
  "promptInjected": true,   ← 这两个是重点
  "dir": "C:\\Users\\Anxiple\\.dsh\\storages\\memory-tiers"
}
```

`tools: 6` 说明六个工具都注册上了，`promptInjected: true` 说明记忆已经接进系统提示词。
然后在对话框里输 `/memory`：

```
三层记忆：L1=0 · L2=0 · L3=0（钉住 0）
数据目录：C:\Users\Anxiple\.dsh\storages\memory-tiers
```

数据实际存在 `~/.dsh/storages/memory-tiers/`：`store.json` 是状态表，`archive/` 是冷存正文，都可以直接用编辑器打开看。

---

## 踩过的坑（你以后一定会遇到）

| 报错 / 现象 | 真正原因 | 解法 |
|---|---|---|
| `函数 'memory_xxx'：schema 必须是 'type: "object"' 的 JSON 模式，获得 'type: null'` | 工具参数用了 `{ id: {...} }` 简写，只有官方 `defineTool` 能把它编译成 schema；而插件目录 import 不到 `@deepseek-ai/dsh-tools`，静默回退成裸对象，dsh 判成 null | 手写 `{ type:'object', properties:{...}, required:[...] }`，不要依赖 defineTool |
| `cannot get property "systemPrompt" without inject` | Cordis 里访问任何 `ctx.xxx` 前都必须在 `inject` 里声明过 | 用 `ctx.inject(['systemPrompt'], cb)` 包起来，别直接读 `ctx.systemPrompt` |
| 插件加载了但模型完全看不到记忆 | `section()` 的签名是 `{ name, order, text }`，不是 `{ id, content }`，写错会被 try/catch 悄悄吞掉 | 现在写错了会直接抛错，不会再静默失败 |
| `profile "desktop" is managed exclusively by the Electron application` | 桌面版独占 profile | 换 `web` profile，或用桌面端的插件市场（只收 npm 包） |
| `pnpm: command not found` | dsh 的 `plugin` 命令只是把参数转给 pnpm | `npm i -g pnpm` |


## 想调什么，改哪里

**优先用设置页**：dsh → 设置 → 记忆（v0.4.0 起有界面，v0.6.0 又改版过）。
改完**重启 dsh** 生效。它和直接改 `config.json` 写的是同一个文件。

真正常动的是三层容量，它们直接决定每轮往上下文里塞多少字：

| 参数 | 默认 | 含义 |
|---|---|---|
| `memoryCfg.hotMaxChars` | 2000 | L1 容量，同时也是注入量（**没有独立上限**） |
| `memoryCfg.consolidateMaxChars` | 2500 | L2 容量：重要原话留住，不重要的沉去 DL1 遗忘 |
| `memoryCfg.longMaxChars` | 4000 | L3 容量：摘要视图，信息密度最高，可以放宽 |
| `refreshMinMs` | 1800000 | **L3 视图的重算间隔**（30 分钟）。只节流 L3——它排最前，一变后面缓存全断；L1/L2 随写随带 |

> **L1 / L2 / L3 恒定全部注入**，没有"是否注入"的开关，可调的只有各自容量。
> **深层（DL1/DL2/DL3）不进上下文**，只在检索时命中，这是省 token 的关键。
> dsh 自带的会话历史默认**一条不留**（由 L1 接管），也不再需要调。
> 其余参数见 `ARCHITECTURE.md` 第 5 节（关键参数）。

## 多个程序共用一份记忆

数据目录可以随便指（设置页「数据共享」里改，或环境变量 `MEMORY_TIERS_DIR`）。
dsh 和 astrbot 指向同一个目录就能共享，但**每个程序的「写者标识」必须不一样**：

```
memory/
  store-dsh.json      ← dsh 只写这份
  store-astrbot.json  ← astrbot 只写这份
  config.json         ← 共用配置
```

各写各的文件（不需要锁，谁也不覆盖谁），读的时候合并成一个视图——
检索和上下文注入能看到全部，但分流、遗忘、融合只动自己写的那份。
对方一落盘，你这边下一次检索就能看到。

已知限制：不跨写者去重 / 取代 / 融合（那都要改对方的条目，而对方的分片我们没资格写），
所以两边记了同一件事会各留一条。这不是"懒得做"——跨文件判重会把自己的新摘要删掉、
内容并到对方对象上存不回去，等于凭空丢一条记忆，所以代码里是显式禁掉的。
另外向量也按写者分片，搜别人的记忆主要靠关键词。

## 排错对照表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 重启后没反应，也看不到工具 | `package.json` 的 `dsh.bundle.patch` 丢了，或 `cordis.patch.yml` 里的 `name` 和包名不一致 | 检查这两个字符串是否都是 `dsh-memory-tiers` |
| 日志里出现"未能注入系统提示词" | 你这个 dsh 版本的 `systemPrompt` API 名字不一样 | 告诉我版本号，改 `index.mjs` 里 `injectPrompt()` 那 10 行 |
| 工具能看到但不被调用 | 模型不知道什么时候该用 | 改工具的 `description`，把触发场景写具体 |
| 记了一大堆但想不起来 | 没填 `apiKey` 时语义检索是关的，只有关键词命中 | 填硅基流动 key，再跑 `node reindex.mjs` 补向量 |

## 一句实话

> 这段是 v1 时代的判断，**两条都已不成立**：召回现在是「向量召回 + rerank 精排 + 关键词」
> 三级流水线，蒸馏是真调模型的摘要。留着只是提醒自己别退回去。

现在的实话是**：语义能力依赖你接没接模型**。

- **接了模型**（填了硅基流动 key）：检索走向量 + rerank，入库能判重判矛盾，L1/L2 溢出有真摘要。
- **没接模型**：语义检索直接关闭，检索只走关键词 + 热度——**不造假向量**。
  但融合与摘要仍能工作，它们默认跟着**当前会话模型**走，不用你额外配 key。

所以最小可用配置其实是「什么都不填」；想让检索变准，才需要去填 key。
换过 embed 模型后记得跑一次 `node reindex.mjs`，否则旧条目只能靠关键词命中。

---

# 日常怎么用（装好之后）

**大部分时候你什么都不用做。** 正常聊天就行——插件每轮都会把记忆塞进上下文，模型看到"长期偏好 / 已定的决定 / 硬约束 / 你说记住"这几类信息时会自己调 `memory_write`。

## 四句话就够

| 你想干什么 | 直接说 |
|---|---|
| 让它记住 | 「记住：报告一律用 markdown」 |
| 让它想起来 | 「我之前说过报告用什么格式？」（它会自己调 `memory_recall`） |
| 纠正记错的 | 「那条记错了，删掉重记：是 PDF 不是 markdown」 |
| 看它到底记了什么 | `/memory` |

## 怎么确认它真的在工作（三步）

1. 在会话里说一句「记住：我的项目路径是 D:/lung」
2. **开一个新会话**，问「我的项目路径是什么？」——能答出来就说明跨会话生效了
3. 打开 `~/.dsh/storages/memory-v5/store.json`，能看到那条记录，`layer` 是 `L1`

## 三个不明显的点

- **`/memory recall 关键词`** 是手动检索，冷存里的东西也能搜到，比问模型快。
- **冷存不是删除。** L3 的正文在 `archive/*.md` 里躺着，搜到就自动捞回来并升回 L2，你随时能看能改。
- **重要的东西要钉住。** 说「把那条钉住」，它会调 `memory_pin`，之后无论多久不用都不会被降级——核心偏好和硬性约束值得钉。

## 它什么时候"遗忘"

- 每 6 小时自动结算一次（插件里的定时器），重启 dsh 也会补结算一次。
- L1 三天没人碰 → 重要的升 L2，不重要的沉到 `archive/`。
- L2 三十天没人碰且评分低 → 沉到 `archive/`。

想改这些天数，回去改 `memory.mjs` 顶部的 `DEFAULTS`，重启生效。
