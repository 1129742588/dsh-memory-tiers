# 架构文档（ARCHITECTURE）—— 详细版

> 面向要**理解、维护、移植**本插件的开发者。当前参考实现是 dsh 端（cordis 插件协议），
> 移植目标（astrbot）只需要替换「宿主适配层」（§9），引擎与协议层（§3–§7）应当原样保留。
> 使用方法见根目录 `README.md`，验证方法见 `docs/VERIFY.md`。

---

## 0. 阅读指南：哪些能搬，哪些要换

| 层 | 文件 | 移植到 astrbot |
|---|---|---|
| **引擎（平台无关）** | `core/memory.mjs`（2311 行） | ✅ 原样搬——不 import 任何宿主 API，模型能力全靠依赖注入 |
| **模型抽象** | `core/llm.mjs`（839 行） | ✅ 基本原样——只换 `createSessionCaller` 的实现 |
| **配置 schema** | `core/settings.mjs`（967 行） | ✅ schema/校验/迁移思路照搬，存储介质按 astrbot 配置系统改 |
| **配置页前端** | `core/client.mjs`（461 行） | ⚠️ 重写——注入 dsh web 的方式是平台特定的，UI 结构可复用 |
| **宿主适配层** | `core/index.mjs`（1102 行） | ❌ 重写——九个接线点全部是 dsh 专属（见 §9 映射表） |

一句话：**`memory.mjs + llm.mjs` 是「记忆系统」，`index.mjs` 是「记忆系统在 dsh 上的插法」**。移植 = 保留前者，重写后者。

---

## 1. 系统总览

```
                  ┌────────────────────────────────────────────┐
                  │              dsh 宿主（cordis）              │
                  └──────┬───────────────┬──────────────┬──────┘
                         │ systemPrompt  │ 工具注册      │ 命令
                  ┌──────┴───────────────┴──────────────┴──────┐
                  │            index.mjs（接线层）              │
                  │  ① capture  ② 注入  ③ 压缩  ④ web API      │
                  └──────┬─────────────────────────────────────┘
                         │ toEngineCfg()（51 项配置 → 引擎 cfg）
                  ┌──────┴─────────────────────────────────────┐
                  │           memory.mjs（引擎）                │
                  │  organize 定时器 │ 分流 │ 融合 │ 遗忘 │ 视图 │
                  └───┬──────────┬──────────┬──────────────────┘
                      │          │          │
               ┌──────┴───┐ ┌────┴────┐ ┌───┴──────────┐
               │ llm.mjs  │ │settings │ │ client.mjs   │
               │ 模型四阶段│ │ 配置/校验│ │ 配置页前端    │
               └──────────┘ └─────────┘ └──────────────┘
```

一轮对话的完整生命周期（七步）：

1. **收**：`turn/end` → 抓取本轮问答写入 L1 缓冲 → `WRITE_TURN`
2. **替**：压缩把宿主历史替换成占位 → `COMPACT_OK`（每轮，`keepTurns=0` 时）
3. **分**：L1 字数超 `hotChars` → 分流模型挑拣（★ 摘要 / `+` 留原文）→ `DIGEST[l1]`
4. **合**：新摘要 vs DL3 旧摘要融合（重复合并 / 矛盾作废 / 进展并存 / 新增）→ `FUSE_*` / `SUPERSEDE`
5. **沉**：L2 满 → L2 旧半 + DL1 全量重压（★★/★/☆ 三档摘要）→ `DIGEST[l2]`
6. **忘**：DL1 保持率 < 阈值 → 台账先行删除 → `FORGET_ITEM`；DL3 琐事档摘要衰减淘汰 → `FORGET_SUMMARY`
7. **喂**：每轮请求注入 `<memory_context>`（L3 视图 + L2 原话 + L1 近况）

---

## 2. 文件与规模

```
core/
  index.mjs      1102 行  宿主适配层（唯一 import 宿主 API 的文件）
  memory.mjs     2311 行  引擎（平台无关，可整体移植）
  llm.mjs         839 行  模型四阶段抽象
  settings.mjs    967 行  配置 schema / 校验 / 迁移
  client.mjs      461 行  配置页前端（注入 dsh web）
  cordis.patch.yml  5 行  cordis 补丁：注册 service 到宿主
tools/
  preflight.mjs           34 项装机前检查
  repair-sessions.mjs     会话修复（占位缺 id 的历史数据）
  inspect-session.mjs     会话解码取证
  collect-report.mjs      崩溃取证打包
  seed.mjs                冒烟种子库
test/                     64 项单测（node --test）
```

---

## 3. 数据模型

### 3.1 条目结构（`makeItem`，memory.mjs:185）

```js
{
  id: 'm5_3_5oofj2s0',   // m5_时间戳_序号+4位随机——两进程同毫秒同序号撞率 1/1.7e6
  seq: 42,               // 进程内自增
  text: '原文或摘要正文',
  kind: 'raw',           // raw=原文 | summary=摘要
  channel: 'dialog',     // dialog | action | event | note（分流时模型可改判）
  layer: 'L1',           // 所属层
  speaker: 'user',       // user | bot | tool
  people: ['小王'],      // 涉及的人（speaker 自动并入）
  scene: '',             // 场景标记
  importance: 0.6,       // 0~1 三档：0.85 原则 / 0.6 有结果 / 0.25 闲聊
  directEntry: false,    // 是否未经巩固期直通（影响下沉排序）
  heat: 1,               // 热度（写入=1，之后 touchHeat 衰减/增强）
  lastMentionedAt: ts,   // 上次被提及时间（衰减计算基准）
  repeatStrength: 1,     // 重复强度（写入算 1，融合/回忆按间隔质量累加）
  fusionCount: 0,        // 融合次数（内容重复度）
  recallCount: 0,        // 被回忆次数（检索命中）
  lastFusedAt / lastRecalledAt: ts,
  createdAt: ts,         // 排序与时间戳渲染的唯一依据
  turnId: 'T003',        // 整轮标识（溢出按整轮取，问答不拆）
  origin: 'dsh',         // 写者标识（多写者共库时区分来源）
  supersededBy: null,    // 被作废时指向新条目 id（作废条目保留在库中标注）
  spanFrom / spanTo: ts, // 摘要覆盖的时间跨度（渲染为「11-03~11-04」）
  // —— L2 专属 ——
  consolidatedAt: ts,    // 进入 L2 的时刻（二级整理取「旧半」的排序键）
  // —— 信号 ——
  pinned: false,         // 钉住：溢出永不取走
}
```

**移植要点**：字段序列化进 JSON 落盘，任何版本升级都必须兼容旧字段（`reconcile` 会补默认值）。`id` 生成策略要保留随机尾——两个进程共库时纯计数器必撞。

### 3.2 六层定义与流转

| 层 | 内容 | 谁写 | 谁清 | 注入 |
|---|---|---|---|---|
| L1 即时层 | 原文 | WRITE_TURN | 分流（DIGEST[l1]） | ✅「历史对话」段 |
| L2 巩固层 | 原话（+） | DIGEST[l1] 的 `+` | 二级整理（DIGEST[l2]） | ✅「最近沉淀的」段 |
| L3 长期视图 | DL3 摘要的**视图**（不落盘新数据，只有快照文件） | refreshL3 从 DL3 截取 | 容量淘汰 | ✅「一直记得的」段 |
| DL1 流水账 | 原文（带向量） | L1 分流的「其余」 | 遗忘曲线 + 容量清理 | ❌（仅检索） |
| DL2 长久原文库 | 原文（摘要引用而来，重要） | DIGEST 的「引用」 | 随其摘要淘汰连带清理 | ❌（仅检索） |
| DL3 长久摘要库 | 摘要（三档 importance） | 分流/二级整理/工具写入 | 仅琐事档淘汰；重要档只靠融合作废 | ✅（经 L3 视图） |

**一个重要的设计约束**：分流标记（★/+）是**一次性的**，不随条目存储——L2/DL1 里的永远是纯原文。二级整理时模型对原文**独立重判**（可能升格成摘要、也可能判琐事），不被上一阶段结论锁死。

### 3.3 文件格式

```jsonc
// L1.json / L2.json / DL1.json / DL2.json / DL3.json（统一格式）
{ "version": 2, "at": 1793715676840, "items": [ /* 条目数组 */ ] }

// L1.tmp/<writer>.jsonl —— 写入缓冲（append-only，一行一个 JSON 条目）
//   organize 时被 claim（读走+删除）→ mergeTemps 并入 L1 → 崩溃最多重放一次
// vectors/deep-part-*.json          —— 嵌入向量（cosine 预筛用）
// graveyard/forgotten.jsonl         —— 遗忘台账：先写台账后删数据，永不静默丢失
// signals/applied.json              —— attend/pin/forget 用户信号的已处理记录
// organize.state.json               —— 上次 organize 结果（状态页数据源）
// L3.json                           —— L3 视图快照（内容没变就不重写，保前缀缓存）
// *.lock                            —— organize 互斥锁（跨进程）
```

---

## 4. 引擎内部（memory.mjs）

`createMemory({ dir, writer, cfg, embed, log, now })` 返回闭包——所有状态收在闭包里，对外只暴露 `writeTurn / search / list / organize / buildBlock / attend / forget / stats / start / stop` 等。

### 4.1 存取三件套

- `loadDb()`：启动时把五个层文件读进内存对象 `db = { L1:[], L2:[], ... }`
- `saveDb(db, { skip })`：**changed 才写**（turn 后每轮都调 organize，无条件重写五文件会把「每轮尝试整理」变成「每轮全量重写」并打断前缀缓存）；`skip` 数组可跳过指定层（DL3 变化时跳过它，避免额外 IO）
- `mergeTemps(db)`：把 `L1.tmp/<writer>.jsonl` 的缓冲条目并入 L1，然后删除 tmp 文件（claim 语义）
- `reconcile(db)`：对账——信号删了摘要后，DL2 孤儿原文同轮归位到 DL1

### 4.2 organize 流水线（memory.mjs:1844）

`organize({ force })` 全程持文件锁（跨进程互斥）+ `checkTimeout` 心跳（卡死被接管）：

```
mergeTemps        并入写缓冲
applySignals      处理 attend/pin/forget 信号（删摘要要再对账）
organizeL1        L1 溢出分流（← 4.3）
organizeL2        L2 满二级整理（← 4.4），仅在模型可用时执行
forgetDL1         遗忘曲线删除（保持率 < forgetThreshold）
enforceDL1Cap     DL1 容量上限（越旧越先清到 80%）
forgetDL3         DL3 琐事档淘汰（只动 ☆ 档；独占的 DL2 原文连带清理）
checkLock         不是我的钥匙就不许写
saveDb            changed 才落盘；先存数据 → 记 applied → 删 tmp 源文件
refreshL3         L3 快照（内容变 / 过期 / 到 refreshMin 才重写）
```

超时：`maxOrganizeMs` 内每步之间 `checkTimeout(started)`，超时抛出并由锁机制兜底。

### 4.3 L1 分流（`organizeL1`，:1508）

```
触发：chars(L1) > hotMaxChars 或条数 > hotMaxItems（1.2.0 起纯字数，无安静期）
取批：pickTurnBatch —— 按整轮从旧到新，取到剩余 ≤ cap/2；
      钉住的轮次不计入「剩余」（否则钉住项占额度会把其余轮次全搬空）；
      单轮特别大时允许整层取空（作者确认）。
分类：refineImportance —— CLASSIFY 模型补 channel/importance（三档 0.85/0.6/0.25）
分流：digest(phase='l1') —— 分流模型一次调用（summaryChunk 分块），输出见 §5
降级：无模型 → DIGEST_NO_MODEL（原文下沉 DL1，带 pendingDigest）；
      调用失败 → DIGEST_FALLBACK（整批回 L2）；无标记 → DIGEST_EMPTY（→ DL1）
```

### 4.4 L2 二级整理（`organizeL2`，:1527）

触发 `chars(L2) > consolidateMaxChars`；取「L2 旧半（按 consolidatedAt）+ DL1 全部」送三档重压。
产出的 `+` 限量 `l2KeepMax` 条回 L2 排队尾（防抖）。DL1 送压后由 `dl1MaxChars` 与遗忘曲线接管剩余。

### 4.5 融合四判

新摘要进 DL3 前：embed（向量）→ 对 DL3 全量算 cosine → **预筛**（≥ `fusionPrefilter` 0.82 的候选）→ 融合模型判关系：

| 判定 | 日志 | 动作 |
|---|---|---|
| 重复 | `FUSE_DUP` | 合并到旧条目，`fusionCount++` |
| 矛盾 | `SUPERSEDE` | 旧条目 `supersededBy` 指向新条（保留在库、注入时过滤） |
| 进展 | `FUSE_UPDATE` | 两者并存（时间线关系） |
| 新增 | （默认） | 直接插入 |

判关系失败**不猜**：两条并存并留痕。`fusionPrefilter` 调低更容易发现矛盾（多花模型调用）。

### 4.6 遗忘三件套

- `forgetDL1`：保持率 = `memoryStrength`（heat 半衰期模型，`heatHalfLife=10` 天基准、`repeatStrength` 拉长半衰期、`heatIdleFactor` 空闲回落）。低于 `forgetThreshold` → **先写台账** → 删
- `enforceDL1Cap`：`dl1MaxChars` 上限，越旧越先清到 80%（`DL1_TRIM`）
- `forgetDL3`：只淘汰琐事档（importance < 0.45），1 天保护期后按 0.55 系数衰减；淘汰摘要时**独占的 DL2 原文连带清理**（被多个摘要共享的原文保留）

### 4.7 注入块构建（`buildBlock`，:1977）——**移植最容易做错的地方**

```js
parts = []
一直记得的      ← L3 视图（DL3 按热度截取 longChars 字，快照复用字节）
最近沉淀的      ← L2 原话（consolidatedAt 升序，consolidateMaxChars 预算）
这是按时间排序的历史对话 ← L1 全部条目（无装箱、不分端、createdAt 升序）
（即时层还有 N 条未显示）  ← 仅当真有截断时
```

**铁律（每一条都是实测事故换来的，详见 §11）**：

1. **单一时间轴 + 纯尾部追加**。任何「新内容插到序列中段」的变化（降序、分端拼接、装箱滑动）都会把模型侧前缀缓存整个打断——实测未命中从 600 回弹到 5300。
2. **不要按 origin 分 mine/other 子段拼接**——一端的新行会把另一端的行整体顶后。
3. **不要给 L1 设注入配额**——配额是「行渲染」口径（每行带时间戳前缀膨胀约 30%），与分流的 text 口径必然错位；水位超配额时截断窗口会滑动。L1 大小由分流机制保证（分流后 ≤ cap/2），注入层全量即可。
4. L3 快照**内容没变就不重写**（连 mtime 都要稳），`viewRefreshMin` 只兜底。
5. 头部三段固定：`<memory_context>` + 使用规则 + 说明语；正文空则整块不注入。

块尾提示：`（当前会话的对话历史已由记忆替代；需要原话细节请调用 memory_search）`——只在真的有记忆内容时出现（压缩守卫依赖这一点：记忆块非空才允许压缩历史）。

---

## 5. 模型层（llm.mjs）

四个阶段，**每个阶段独立 source**（`session` 蹭会话模型 / `api` 走独立凭据）：

| 阶段 | 用途 | 输出解析 |
|---|---|---|
| `summary`（分流） | L1/L2 挑拣 + 摘要 + 保留 | `parseSummaryOutput(out, n, phase)`——按阶段区分标记语法与 importance |
| `chat`（融合） | CLASSIFY 分类打分 + 判关系 | JSON 解析（`stripFence` 去 markdown 围栏） |
| `embed` | 语义检索 + 融合预筛 | 向量数组 |
| `rerank` | 检索精排 | 重排索引 |

关键约定：

- **失败一律返回 null / 空数组，绝不抛**——引擎拿到 null 走降级路径（`DIGEST_NO_MODEL`/`FALLBACK`），永不让模型故障变成数据故障。
- `createSessionCaller(getCtx)`：`session` source 的实现——从宿主拿当前会话模型调用；第一次拿不到冷却 30 秒（`SESSION_UNAVAILABLE` 属正常）。
- `noThink`：分流/融合调用关闭思考模式（省时省 token）。
- `summaryChunk`：大批量分块（默认 60 条/块），防止一次调用超长。
- 解析器**带阶段参数**：first pass 只认 `★/+`（★ 恒 0.9），second pass 认 `★★/★/☆/+`（0.9/0.6/0.3）。两条路径不得互相污染——这是修复「first-pass 过滤线 0.9 与 `·` 档约定互斥」事故后定下的结构。

---

## 6. 配置系统（settings.mjs）

- **SCHEMA 是唯一真相源**：51 项，8 组（存储/抓取/注入/六层容量/整理节奏/模型/工作模式/历史替代），每项 path/label/hint/type/default/min/max。
- `coerce`：类型强制 + min/max 校验；越界字段**拒绝但其它字段照存**（`changed` 只回变化的键）。
- 未知字段：**保留并进 `ignored`**（升级不留暗坑），绝静默丢弃。
- v1 → v2 迁移：平面配置名映射（`V1_MEMORY_MAP`）+ 时间单位自动换算（`quietMs` → 分钟）。
- 「配了不生效」是测试专门防的缺陷：每个 schema 项必须真的有人读（preflight 有对应检查）。
- 配置损坏（JSON 解析失败）：`config.json.broken-<时间戳>` 备份后重建默认配置（`CONFIG_BROKEN`）。

---

## 7. 宿主适配层（index.mjs）与九个接线点

启动九步（`step()` 逐项降级，任一失败记 `BOOT_FAIL` 继续装其余）：

| 步骤 | 做什么 | astrbot 对应物 |
|---|---|---|
| config | 读/迁移/校验配置 | astrbot 配置系统 |
| model | `createLlm`（四阶段 caller） | astrbot LLM provider |
| memory | `createMemory`（引擎实例） | ✅ 原样 |
| tools | 注册 5 个 `memory_*` 工具 | astrbot 工具/函数调用注册 |
| capture | 订阅 `turn/end` 抓取 | astrbot 消息钩子 |
| systemPrompt | `context()` 挂记忆块（INJECT_ON context） | astrbot 的 system prompt 注入点 |
| inject:webServer | 配置页 web API 挂载 | astrbot 面板路由 |
| commands | 注册 `/memory` 命令 | astrbot 指令系统 |
| timers | organize 定时器 + 卸载清理 | 定时任务 |

**turn 事件里做的事（每轮）**：`WRITE_TURN`（capture）→ 交叉校验（关注入却全替 → 警告）→ `COMPACT_OK`（历史替换占位，**必须带 `data.id`**）→ organize（定时器到点或轮末触发）。

**web API**（配置页数据源）：`GET /api/config|status|running`、`POST /api/config|organize`、`GET /api/log`。

**注入方式**：记忆块作为独立的 `runtime-context` 消息进请求（宿主动态拼接）——注意 `deriveMessages()` **不含**注入块，调试「原样请求」只能靠 session 落盘数据或未来宿主提供的请求快照。

---

## 8. 日志事件参考（audit 全表）

| 类别 | 事件 |
|---|---|
| 启动 | `BOOT_OK` `BOOT_FAIL` `BOOT_MISSING` `BOOT_DEGRADED` `BOOT_DONE` |
| 配置 | `CONFIG_CREATED` `CONFIG_MIGRATED` `CONFIG_MIGRATE_FAIL` `CONFIG_BROKEN` `CONFIG_FILLED` `CONFIG_INVALID` `CONFIG_SAVED` `CONFIG_WRITE_FAIL` |
| 抓取 | `WRITE_TURN` `WRITE_TURN_FAIL` `WRITE_TURN_SKIP` `BUFFER_TRUNCATED` `CAPTURE_ON` `CAPTURE_OFF` |
| 注入 | `INJECT_ON` `INJECT_OFF` `INJECT_FAIL` `COMPACT_OK` `COMPACT_SKIP` |
| 整理 | `ORGANIZE ok` `CLASSIFY n/n` `DIGEST[l1]` `DIGEST[l2]` `DIGEST_NO_MODEL` `DIGEST_FALLBACK` `DIGEST_EMPTY` |
| 融合 | `FUSE_DUP` `FUSE_UPDATE` `SUPERSEDE` |
| 遗忘 | `FORGET_ITEM` `FORGET_SUMMARY` `DL1_TRIM` |
| 其它 | `LAYER_WARN` `RELOCATE_LEGACY` `SEMANTIC_FAIL` `WORK_MODE` `SHUTDOWN` |

grep 口径示例：`grep -E 'DIGEST\[|FUSE_|SUPERSEDE|FORGET|COMPACT_OK' ~/.dsh/memory-tiers/log.txt`。

---

## 9. 2026-11-03 实战问题记录（移植前必读）

这一天从验证 → 修复 → 发布 → 实测，踩的坑全部记录在案。**每一条都对移植有直接启示**。

### 9.1 会话校验失败（占位缺 `data.id`）——【数据修复】

- **现象**：dsh 重启后打开旧会话报 `... lacks an identified message`，会话无法加载。
- **根因**：1.0.0 的压缩占位落盘时缺 `data.id`，宿主升级校验后拒绝加载。
- **处理**：写 `tools/repair-sessions.mjs`——解码 `.zstd` 会话文件 → 26 条坏事件补 id（每文件先备份 `.bak-<时间戳>`）→ 幂等（重跑 0 条）。文档化在 `docs/SESSION-REPAIR.md`。
- **移植启示**：宿主对会话数据的校验会随版本收紧；占位/替换物落盘时**必须带稳定 id**，否则升级日就是断档日。

### 9.2 前缀缓存四连修（未命中 5300 → 1700 → 600 → 1700 → 稳态 500-800）——【核心教训】

| 轮次 | 现象 | 根因 | 修复 |
|---|---|---|---|
| ① | 未命中恒定 **5300**（两轮无增长） | L1 注入视图按 createdAt **降序**——每条新消息插队到段首，整块每轮失效 | 改**升序**（尾部追加） |
| ② | 回弹 **1700** | 注入配额是「行渲染」口径（每行带时间戳前缀膨胀约 30%），与分流的 text 口径错位——L1 水位必然阶段性超配额 → 装箱截断 → 滑动窗口 | 取消配额，自己端全量注入（大小由分流保证） |
| ③ | 再回弹 **1700** | `mine/other` **分端拼接**——自己端（dsh）新行插在另一端（灌库）行之前，另一端整体后移 | **取消分端**：单一时间轴 + 纯尾部追加 |
| ④ | 一度 **600** 后观测到周期性 | 那是 L1/L2 大搬家的分流轮（一次性重置成本）；非分流轮实测「历史对话」段纯尾部追加、39/41 条旧行全部原位 | 正常，无需修 |

- **终态代码**（buildBlock 内）：L1 全量条目（不分 origin）→ `sort(createdAt 升序)` → `map(lineOf)` → 追加段尾。无装箱、无配额、无分端。
- **终态数据**：未命中 500-800 循环波动（= 每轮新增 2 行 + time-context 400 + 输入），不累积。
- **移植启示**：宿主的「历史压缩/替换」与「注入块」都会进请求序列，**任何中段插入都是缓存杀手**。astrbot 侧若也有历史压缩，同样要守「追加式」铁律。

### 9.3 运行中直写 L2 必然失败——【数据写入时序】

- **现象**：dsh 运行中手写 `L2.json` 想凑测试数据，文件被覆盖回空。
- **根因**：引擎的 `db` 是内存态，`saveDb` 会用内存对象全量重写文件；运行中改文件等于对空气写字。
- **处理**：L1 走 `L1.tmp` 缓冲（claim 语义，运行中安全）；L2 只能**关 dsh 后写文件**，或让数据自然产生。实测用 `createMemory({ writer: 'default' })` 的新进程 + `writeTurn` 在运行中灌 L1 缓冲，5 波 53 轮全部成功。
- **移植启示**：给引擎喂测试数据的唯一安全通道是**它自己暴露的写入口**（tmp 缓冲），不要和运行中的内存态抢文件。

### 9.4 `git merge -X theirs` 覆盖事故——【流程教训】

- **现象**：push 后 GitHub 仓库 core/ 变成 0.8.4 旧代码，且混入 0.8.x 旧模块（silicon/dshllm/compaction），用户当场发现。
- **根因**：远端是 0.8.x 历史仓库（非空），`merge -X theirs` 的 **theirs = 被合并方（远端）**——语义理解反了，冲突全取了旧版。npm 的 1.2.0 tarball 也是覆盖后的产物。
- **处理**：首次提交 `07b33c8` 里 1.2.0 内容完好 → `git checkout 07b33c8 -- core/` + 删 0.8.x 插入文件 → 升版 **1.2.1** 重发 + `deprecate 1.2.0` → tag 重打。
- **移植启示**：① 合并历史仓库前先 `git log` 看远端状态，非空仓库慎用 `-X theirs/-X ours`；② 发布前**必须核 `package.json` version**（这次的 version 字段也是错的，靠 npm 报错才发现）。

### 9.5 npm 版本与供应链观察期——【发布流程】

- 误发 0.8.4 后 unpublish 报 403（granular token 无删除权）→ 0.8.4 残留列表（无害，latest 正确）。
- 用户端装到 0.8.2 的真凶：**pnpm `minimumReleaseAge` 供应链策略**——新发布版本未过观察期不进自动安装池。急用时显式指定版本号可绕过。
- **移植启示**：发版后别急着让用户装，预留观察期；紧急修复引导用户「卸载 + 指定版本号」。

### 9.6 配置页显示与实际不符——【诊断方法】

- 用户连续报「模型显示错」「信息区多处对不上」。
- 处理：显示层区分两类病因——① 显示 bug（读错来源/旧缓存）；② 「改了未重载」的**合理状态**，UI 要标「待重载」而不是装作已生效。服务端逐字段 diff（文件值 vs 运行值）是配置页的标准能力。
- **移植启示**：配置页必须同时展示「文件值」与「运行值」并标注差异字段，否则用户永远在猜。

---

## 10. 移植清单：dsh → astrbot

引擎与协议层直接搬，以下是需要替换/适配的接线点：

| dsh 侧（index.mjs） | astrbot 侧要做的 |
|---|---|
| `turn/end` 事件订阅 + capture | 消息钩子（会话结束后取 user/bot 文本） |
| `systemPrompt.context()` 挂记忆块 | astrbot 的 system prompt 注入机制 |
| 压缩接管（历史替换占位，带 `data.id`） | astrbot 自带历史管理——按 `archiveChars` 替换或截断 |
| 工具注册（cordis 工具协议） | astrbot 函数调用注册 |
| `/memory` 命令（宿主命令系统） | astrbot 指令（`/memory list`、`/memory context`） |
| web API + 配置页注入（dsh web） | astrbot 面板配置（或复用 `client.mjs` 的 UI 结构） |
| `cordis.patch.yml` + `dsh.bundle.patch` | astrbot 插件 manifest |
| `createSessionCaller`（宿主会话模型） | astrbot provider 的会话模型调用 |
| 端口 web API（status.json 上报） | astrbot 的插件状态上报方式 |

**不变的承诺**（移植后仍成立）：

- 数据目录格式兼容（共享同一份记忆库 = 跨端共享记忆，0.8.x 时代已验证此协议）
- 分流协议、融合四判、遗忘台账、日志事件表
- 「失败不产生假数据」与「台账先行」两条底线

## 11. 已知限制

- `deriveMessages()` 不含注入块——「原样看请求」需要宿主提供请求快照能力（open-issues）
- time-context（时间戳）每轮必变，是未命中 600 的固定底噪（宿主行为，插件管不了）
- 分流轮（L1/L2 大搬家 + L3 重算）一次性打断前缀缓存，约 1700 token 重置成本——分流频率低（L1 需涨 1500 字），可接受
- npm 包历史上有一版 0.8.4 与 1.2.0 为坏内容（已 deprecate/标注），装机务必 1.2.1+
