# 六层记忆 · 系统架构

> 权威设计文档。改动前先读这里，改完同步这里。
> 最后更新：2026-10-31
>
> 决策过程记录在 `REFACTOR_PLAN.md`（D1–D28）。
> 本文只讲「现在是什么样」和「接下来要改成什么样」。
>
> **注意**：第 6 节是 2026-10-31 已落地的改动（含实测数据）。其余各节描述的是当前实际状态。

---

## 0. 一页速览

**六层**，按「离上下文多远」分两组：

| 活跃层（进上下文） | 深层（不进上下文，供检索） |
|---|---|
| L1 及时层 · L2 缓冲层 · L3 视图 | DL1 流水 · DL2 原文 · DL3 摘要 |

**核心原则（不能碰）**：

1. **重复度是重要性信号**。同样的话说了 2 次 vs 10 次，模型压摘要时分得出
   「反复叮嘱」和「刷屏」。提前去重会把这信号抹掉——所以写入不判重、不去重。
2. **原文时间戳不得变**（`createdAt` 一经写入不再修改），否则遗忘曲线算不准。
3. **大模型只做摘要，小模型只做判关系**，其余全是本地规则或不处理。
4. **搜到 ≠ 相关**。检索是只读的，热度要 `attend()` 确认后才涨，否则形成回音室。
5. **摘要进 DL3 是稀有的**，大部分内容只配当原文沉到 L2 / DL1。

---

## 1. 六层结构

| 层 | 性质 | 存什么 | 进上下文 | 容量 | 遗忘 |
|---|---|---|---|---|---|
| **L1** 及时层 | 活跃 | 刚写入的**原文** | ✓ 全进 | 1500 字 / 200 条 | 不遗忘（靠溢出清） |
| **L2** 缓冲层 | 活跃 | **原文**（比 L1 重要、不那么及时） | ✓ 全进 | 3000 字 / 120 条 | 不遗忘（靠满仓清） |
| **L3** 视图 | 活跃 | DL3 的**排序前 N 条** | ✓ | 1500 字 | 不遗忘（自动让位） |
| **DL1** 流水 | 深层 | **原文**，没被摘要用上的 | ✗ | 无上限 | **快忘**（半衰期 3 天） |
| **DL2** 原文 | 深层 | **原文**，被 ★ 摘要引用的 | ✗ | 60000 字 | **不遗忘**（保底） |
| **DL3** 摘要 | 深层 | **摘要**（长期记忆） | ✗（L3 是它的视图） | 无上限 | **不遗忘** |

**关键关系**：

- L3 **不是存储层**，是「从 DL3 里按分数截取出来的视图」。DL3 里热度掉了，
  分数就掉，自动退出上下文，不需要搬数据。
- DL2 的内容**一定有对应的 DL3 摘要**（是摘要引用它才进 DL2 的）。
  所以 DL3 找不到时，DL2 也不会有——检索可以跳过 DL2 直奔 DL1。
- DL1 是「没被摘要用上的流水账」，DL2 是「被长期记忆收录的原文」。

---

## 2. 完整流水线

以 10 条消息为例。

### ① 写入（10 条 → L1）

```
做什么：算向量 + 落盘
不做：判重、分类、合并、摘要
```

**全部原样进 L1**。理由见原则 1。

成本：1 次批量 embed。

### ② L1 满了 → 取最老一半

```
做什么：按写入时间取一半（如 5 条）
判断：本地规则，不调模型
```

### ③ 溢出处理（这 5 条）—— **唯一的大模型调用**

一次调用，输入 5 条原文，输出三段：

```
★ 星鲸定下以后报告统一用 markdown《1,3,5》   ← 特别重要 → DL3，1/3/5 → DL2
· 封魔说快递柜放错跑了两趟《4》               ← 一般 → 不进 DL3，4 → L2/DL1
+ 2                                          ← 值得留但不特别 → L2
                                                 （没提到的 → DL1）
```

路由规则：

| 标记 | 摘要去哪 | 引用的原文去哪 |
|---|---|---|
| `★` | **DL3** | **DL2** |
| `·` | 不进 DL3 | 跟着走 L2/DL1 |
| `+` | — | **L2** |
| 都没提 | — | **DL1** |

> **没进 DL3 的摘要，其引用的原文不能进 DL2**——DL2 的职责是「供下探查细节」，
> 而下探靠 DL3 的摘要引过去。没有摘要指向它，DL2 就是孤儿，永远搜不到。

优先级：`★` > `+` > 无。同一条编号被两个标记命中时，以 `★` 为准。

> **L1 路径和 L2 路径的差异**（2026-10-31 用户定）：
> L1 溢出（第一批沉淀）**只收 `★`** 进 DL3，`·` 被过滤、其 sources 跟着走 L2/DL1；
> L2 溢出（缓冲区整理）**不设限**，`★` 和 `·` 都正常进 DL3。
> 实现见 `routeByCitation` 的 `ROUTE_GATE` 分支。

### ④ DL3 融合（新摘要入 DL3 时）—— **唯一的小模型调用**

新摘要进 DL3 前，先搜 DL3 现有摘要（余弦 ≥ 0.82），有候选才调模型判：

| 判定 | 处理 | fusionCount |
|---|---|---|
| **重复** | 合并进旧的，删新的 | 旧的 +1 |
| **矛盾** | 新取代旧，**热度/计数转给新的** | **不 +1** |
| **更新** | 两条都留 | — |
| **无关** | 都留 | — |

矛盾时连带作废 DL2 里对应的原文——摘要记了 `sources`，反查就知道该作废哪几条。

**融合只在入库时做**，不做定期全量融合。

### ⑤ L2 满了 → 整层走一遍 ③

L2 是缓冲区，**不设到期**，超容量（3000 字 / 120 条）才触发。

取法（2026-10-31 定）：

```
L2 按 consolidatedAt（进 L2 的时间）排序
  → 从最旧起累加字数，到 consolidateMaxChars / 2 为止（最后一条可超出）
  → 再加上 DL1 的全部
  → 一起送去走 ③
```

区别只有一处：模型标 `+` 的这次直接沉 DL2（观察期用完了）。

> **为什么用 `consolidatedAt` 而不是 `createdAt` 排序**：DL1 升回 L2 的条目
> 内容时间可能很老，用 `createdAt` 排会把它排到最前，打乱时间流（缓存）。
> 用「进 L2 的时间」排，它就自然融入当前时间窗。
> 原文 `createdAt` 本身不变（见原则 2），只是排序键不同。

### ⑥ 检索 → 关注

三档，**只能按顺序下探**：

```
summary  只扫 DL3                ← 只要大意
detail   扫 DL3 → DL2            ← 要细节
full     扫 DL3 → DL2 → DL1      ← 确实没有才下到底
```

会话模型选档。结果带 `confidence`（rerank 原始分）+ `advice`（下一步建议）。

**搜到不等于涨热度**。要会话模型调 `attend(ids)` 确认相关，才 `recallCount +1`，
DL1 的升回 L2 重新观察。被搜到但模型判断无关的，不涨。

相关性闸门用 **rerank 原始分**（`minRerank: 0.02`），不用余弦——
实测余弦分不开（不相关 0.573 vs 相关 0.690），reranker 差两个数量级。

### ⑦ 遗忘

只扫 **DL1**，按保持率衰减，低于阈值进台账后删。**DL3 不遗忘，DL2 不遗忘**。

---

## 3. 模型调用矩阵

| 阶段 | 本地规则 | 小模型 Ling-mini | 大模型 DeepSeek |
|---|---|---|---|
| ① 写入 | 落盘 | embed 向量 | — |
| ② L1 满 | 取最老一半 | — | — |
| ③ 溢出 | 按出处路由 | — | **摘要 + 出处 + 标记** |
| ④ 入 DL3 | 合并/取代执行 | **判重复/矛盾/更新** | — |
| ⑤ L2 满 | 取旧半 + DL1 全 | — | 同 ③ |
| ⑥ 检索 | 粗排打分 | embed + rerank | — |
| ⑦ attend | 记热度 | — | — |
| ⑧ 遗忘 | 衰减 + 台账 | — | — |

**大模型只在 ③⑤ 出现，小模型只在 ①④⑥ 出现。** 其余全是本地规则或不处理。

---

## 4. 指标与热度

### 三个指标，语义不同

| 指标 | 含义 | 什么时候涨 |
|---|---|---|
| `fusionCount` | **融合次数 / 重复次数** | 同一件事被反复说、被合并掉几次。DL3 融合判「重复」时 +1 |
| `recallCount` | **关注次数** | 被会话模型**确认相关**后用过几次。`attend()` 时 +1 |
| `heat` | **热度** | 见下表 |

### 热度来源（2026-10-31 定）

| 事件 | heat 变化 |
|---|---|
| 写入 | **不涨** |
| 摘要入 DL3（初始） | **= 2**（新鲜度） |
| 融合判「重复」合并进旧的 | 旧的 +1 |
| 融合判「矛盾」 | **不 +1**，热度转给新的 |
| 融合判「无关」 | 不涨 |
| `attend` 确认相关 | +1 |
| 搜到但模型说无关 | **不涨** |

### 热度公式

```
半衰期  halfLife = heatHalfLife × (1 + heatRepeatBoost × min(repeatStrength, heatRepeatCap))
热度    heat(t)  = heat × exp(-t / halfLife)
```

- `repeatStrength`：被提及的天数累积（艾宾浩斯重复效应）。天数越多，半衰期越长。
- `touchHeat` **按天去重**：同一天多次提及只算一次。
- 衰减是指数的，被提及过的衰减得更慢。

### L3 排序

```
score = importance × heat
```

按 score 降序，累加字数填满 `longMaxChars`（1500 字），可略微超出。

- `importance`：模型给档位，0.9（重要）/ 0.7（一般）/ 0.5（琐事）
- `heat`：范围 1~20，天然主导排序（档位影响小）

**待验证**：跑 L3 前 20 条的档位分布。若第一档仍占 90%，改成
`importance^0.5 × heat` 进一步压缩档位影响。**不做硬配额**。

---

## 5. 关键参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `hotMaxChars` | 1500 | L1 容量（字） |
| `hotMaxItems` | 200 | L1 容量（条） |
| `consolidateMaxChars` | 3000 | L2 容量（字） |
| `consolidateMaxItems` | 120 | L2 容量（条） |
| `consolidateDays` | 0 | **已弃用**（L2 不按时间到期） |
| `longMaxChars` | 1500 | L3 视图容量（字） |
| `dl2MaxChars` | 60000 | DL2 容量 |
| `dl2CompressTarget` | 400 | 单条超这么多字才值得压缩 |
| `allowModelCompress` | false | 模型压缩默认关闭（实测减不掉字） |
| `routeMode` | `citation` | 路由依据：摘要引用，不用重要度数值 |
| `classifyMode` | `onOverflow` | 分类挪到溢出后（现已被 citation 取代） |
| `summarizeMode` | `inline` | `deferred` = 后台队列，不卡写入 |
| `summaryChunk` | 60 | 摘要单次最多压多少条 |
| `fusionPrefilter` | 0.82 | 判关系的余弦预筛 |
| `minRerank` | 0.02 | 检索相关性硬底（滤纯噪音） |
| `minRerankStrong` | 0.08 | 「够用」分界（只给建议，不过滤） |
| `summaryCoherenceWarn` | 0.30 | 摘要「硬凑」检测阈值 |
| `heatHalfLife` | 10 | 半衰期基准（天）。**不要单独调它来加速 DL1 遗忘**——它同时决定 L3 排序的热度，改了会让热度公式自测全翻 |
| `forgetThreshold` | 0.25 | **DL1 忘得快靠这个**。保持率低于它就删。heatHalfLife=10 时 0.03→约 35 天忘，0.25→约 14 天 |
| `heatRepeatBoost` | 0.3 | 重复系数 |
| `heatRepeatCap` | 20 | 强度封顶 |
| `heatPromoteThreshold` | 1.0 | 热度 ≥ 这个 → 有资格升长久层 |
| `budgetTokens` | 0 | 进程级 token 预算，0 = 不限 |

---

## 6. 已实施的改动（2026-10-31 全部落地）

| # | 改什么 | 做法 | 实测 |
|---|---|---|---|
| **1** | L2 溢出取法 | 按 `consolidatedAt` 排序取旧半（**字数**累加到 `consolidateMaxChars/2`，可超出）+ **DL1 全部** | `CONSOLIDATE_FULL 取旧 N 条（M 字）` |
| **2** | 摘要进 DL3 收紧 | `★` 进 DL3、`·` 也进但 L1 路径只收 `★`；只有进 DL3 的 sources 才进 DL2 | DL3 从 203 → **10 条** |
| **3** | importance 三档 | 模型给 `★`→0.9 / `·`→0.7；**热度主导**（heat 1~20 vs 档位 1.29 倍） | 两档都产出 |
| **4** | 遗忘范围 | **只扫 DL1**；忘得快靠 `forgetThreshold` 0.03→**0.25**（约 14 天忘） | 热度自测 17/17 |
| **5** | 热度来源 | 新摘要初始 `heat=2`；涨的只有**融合 +1** 和 **attend +1** | — |
| **6** | 全量融合 | `fusionEveryNWrites: 0`（停用），只靠入库融合 | 判重调用 844→**153** |

### ④ 的实际做法（与原计划不同，用户已确认）

原计划 `heatHalfLife` 10→3 天，**实测会打翻热度公式**——`heatHalfLife` 同时决定
L3 排序的热度和 DL1 的保持率，改了之后 7 项热度自测全失败（持续提及的也晋升不了）。

改成：**热度公式不动（`heatHalfLife: 10`）**，改用 `forgetThreshold: 0.25`
（保持率低于它就删）。效果是 DL1 约 14 天忘（原 35 天），快 2.5 倍，
且热度公式 17/17 自测全过。**用户确认「遗忘架构就现在这样，不用改了」。**

### 额外做的一条：L1 / L2 路由差异（用户 14:08 补充）

> 「只有 L1 进 DL3 这条路需要特重要事件的条件，L2 进 DL3 不需要限制太大，就按正常的」

在 `routeByCitation` 加了 `ROUTE_GATE` 分支：

- **L1 路径**（L1 溢出）：只收 `★`（importance ≥ 0.9）进 DL3，
  `·` 被过滤、其 sources 跟着走 L2/DL1
- **L2 路径**（`secondChance`）：`★` 和 `·` 都正常进 DL3

理由：L1 溢出是第一批沉淀，DL3 是稀有长期记忆要挑最值得的；
L2 满了做整理，本来就是"正常摘要"，不该更严。

### 60 天实测（改前 → 改后）

```
总 token   285,695 → 196,940   −31%
判重       166,020 →  31,438   −81%
调用总数    1080   →   419     −61%
写入耗时   111s   →    66s     −40%
健康检查   11/11 全过
```

### 档位分布（用户关心「别全是第一档」）

```
L1 路径（严格）  → 只产 ★ = 0.9
L2 路径（正常）  → 产 ★ = 0.9 和 · = 0.7
```

30 天 L2 只攒到 1608 字（上限 3000）没触发；调小到 500 字验证到 L2 路径确实产 0.7。
**正常容量下 L2 约 50-60 天满一次**，所以 0.7 是慢热的。不是全第一档 ✓

---

## 7. 对外接口

```js
const mem = createMemory5({
  dir, now, embed, classify, classifyBatch,
  judgeRelation, summarize, summarizeWithSources, rerank, compress,
  cfg: {...},
})

// 写
await mem.write({ text, speaker, people, scene, channel, importance, at, kind })
await mem.writeMany([{...}, {...}])              // 批量，快得多

// 查
await mem.search(q, { depth, limit, person, channel, useRerank })
//   depth: 'auto' | 'summary' | 'detail' | 'full'
//   返回 { hits, confidence, advice, depth, stages }
mem.attend(ids)                                   // 确认相关，记关注
mem.buildBlock(budget)                            // 注入上下文
mem.list(layer?)                                  // 列条目

// 维护
mem.sweep()                                       // 触发分层收敛（enforceLimits）
mem.compressDL2({ force, only })                  // 手动压缩 DL2
mem.flushSummaries()                              // 清摘要队列
mem.pendingSummaries()                            // 队列里还有多少
mem.fuse()                                        // 全量融合（待停用）
mem.fuseDL3(summaryItem, now)                     // 单条入 DL3 融合

// 观测
mem.stats()                                       // 分层统计 + 调用统计 + 闸门
mem.resetCalls()
mem.graveyard({ limit })                          // 遗忘台账

// 测试
mem._seed(item, vec)                              // 直接注入
mem.retentionOf / heatOf / halfLifeOf
```

---

## 8. 三条不能碰的线

1. **不写入判重**。重复度是重要性信号，提前合并会抹掉它。
   （历史上曾有「写入时判重」，60 天烧掉 844 次调用 / 16.6 万 token / 58%，已废除。）
2. **原文时间戳不得变**。`createdAt` 一旦写入不再改，否则遗忘曲线算不准。
3. **搜到不涨热度**。只认 `attend()` 确认，否则误命中的记忆越搜越热，成回音室。

---

## 9. 现状与已知问题

**已解决**（60 天压测 1806 条 / 6 分钟 / 28.6 万 token，11/11 检查通过）：

- 写入判重占 58% 成本且随库增长 → 已废除
- 检索每次全量写盘 → 已去掉（400ms → 23ms）
- 分层检索没真正分层 → 已按层建桶（summary 140ms vs full 548ms）
- 摘要硬凑 → 加 `SUM_SUSPECT` 审计（实际 1%）
- 预算撞顶导致检索静默降级 → 加 `RERANK_FAIL` 审计 + `reranked:false` 提示

**未解决 / 已知代价**：

- ~~向量持久化是单个 JSON，20 万条会 `RangeError`~~ → **已分片（2026-10-31）**：
  每片 5000 条（约 27MB），撑到十万级。再往上（~100 万条）要二进制/偏移索引，见第 12 节。
- 矛盾检测延后到摘要入 DL3 时（原来在写入时）。旧命令在 L1 里多活 2–4 天，
  但 L1 全进上下文，对话模型看得见先后顺序。
- 入库融合若漏判（两条摘要余弦没到 0.82），就永远不合并。DL3 不遗忘，
  多几条重复不影响正确性，只是占空间。

---

## 10. 预备方案：向量索引改造（**未实施**，2026-10-31 备忘）

> **状态：仅预备，不许当已做。** 用户 2026-10-31 定：「只是预备」。
> 真要动手前先问用户。三条红线（第 8 节）不受本方案任何一项影响。

### 背景（实测口径，注意是修正后的数）

向量是 **1024 维 Float32Array**（base64 落盘 5.4KB/条）。本地余弦全扫实测 **~2µs/条**：

| 库规模 | 全扫一次 | 体感 |
|---|---|---|
| 现在（~1200 条） | ~2ms | 无感 |
| 1 万条 | 22ms | 无感 |
| 10 万条 | **216ms** | 开始有感 |
| 100 万条 | 2.2s | 不可接受 |

**最先撑不住的是检索**（在应答关键路径上）；融合粗筛、写入粗筛在后台，疼得晚。
写入本地扫描 O(n)/条 和判重 relation O(n)/条 是 90 天模拟（sim90-report.md）确认的两个增长项。

### 动手时机

- **DL3 过 5000 条**（检索约 0.65s，开始有感）前动手；
- 10 万条级再改就要停机重建索引 + 换存储，动静大。

### 三件事（按序）

1. **删除/作废路径索引友好化**（免费，可提前做）
   现在 `removeItem` + `store.vectors.delete` 配对散落多处，`supersededBy` 作废只改字段。
   收拢成统一入口：**能标记失效（tombstone）、能重建**。这一步不引依赖，
   先把数据流理顺，真上 HNSW 时不动调用方。
2. **channel 分桶用足**（零依赖过渡）
   `buildVectorIndex` 的按 channel 桶是现成的（原写入判重遗留），给
   `searchOnce` 带 channel 过滤的场景用上：同 channel 池内比，省掉全层遍历。
3. **上 HNSW**（hnswlib-node 或同类）
   检索、融合粗筛、写入粗筛三处从 O(n) 全扫变 O(log n)。召回靠 `ef_search` 调。

### 代价（提前记下，别到时才发现）

| 代价 | 说明 | 缓解 |
|---|---|---|
| **召回变近似** | 可能漏个别相似候选。检索有 rerank 兜底；融合漏合并只是 DL3 涨快点（DL3 不遗忘，不影响正确性） | `ef_search` 调高 |
| **删除弱** | HNSW 删除是墓碑 + 定期重建（本系统有遗忘/作废，90 天模拟 500+23 条） | 正好靠第 1 件事的失效标记 |
| **写入变慢** | 插入建图 1~5ms/条（现在 2µs） | 写入在后台，无感 |
| **依赖** | hnswlib-node 是原生模块，Windows 编译/分发多一层 | 备选纯 JS（vectra 等，慢几倍） |
| **复杂度** | 索引与 store 一致性、崩溃恢复、测试面变大 | — |

### 明确不做（收益 < 代价）

- **降维**（1024→更小）：精度掉、融合阈值 0.82 得重调、旧向量要重算。1024 维已经不大，省不了多少。
- **Float32Array 替代 JSON 落盘**：只省 25% 空间（5.4KB→4KB/条），丢 JSON 可读性 + 迁移脚本。等第 9 节的 20 万条 `RangeError` 真撞上再一起做。

---

## 11. 预备方案：图片记忆（**未实施**，2026-10-31 备忘）

> **状态：仅预备，不动手。** 同上节，动手前先问用户。
> 三条红线（第 8 节）不受影响。

### 核心决策：图不进层，只挂层

六层的所有机制（摘要、融合、热度、遗忘）都是为**文本**设计的。图片硬塞进去有三个问题：

- 图片没法「摘要」，硬压只剩「主人发了张猫图」，信息全丢；
- 表情包刷屏会把热度系统喂歪（同一个梗发 20 次，heat 爆表）；
- DL3 会被「图片摘要」淹没，挤掉真正的文字记忆。

所以图片的正确位置是**原文的附件**：L1 原文带 `media` 引用，摘要里写「主人发了张猫的照片」（文本照走），要看原图时顺引用去附件库取。

### 三层分离

```
① 附件库（blob）      media/{sha256}.jpg        ← 按内容哈希存，天然去重
② 索引（两路文本）     caption（VLM 描述）+ OCR（图内文字）
③ 挂载点（记忆条目）   media: [{ hash, caption, ocr, w, h }]
```

**第 ② 层是关键**：每张图生成两份文本——
- **VLM caption**：语义描述（「一只橘猫趴在键盘上」），走现有 bge-m3 embedding，**文本 query 直接能搜到图**；
- **OCR 文字**：图里的字（截图、聊天记录、文档照），群聊场景比 caption 还重要。

这样 **Phase 1 不需要任何新检索路径**：caption 当普通文本进 L1/L2，参与摘要、融合、rerank，现有管线一行不改。

### 比「单纯存指针」多做的四件事

| 要点 | 做法 | 为什么 |
|---|---|---|
| 内容哈希去重 | `sha256(图片)` 当文件名，重复只存一份 | 群聊表情包大量重复，不去重磁盘会被刷爆 |
| 引用计数 | 条目引用 hash，删除时减计数，归零才删文件 | 同一张图可能被多条记忆引用，忘一条不能删图 |
| 向量独立存 | 图片向量单独索引文件/表 | 现有 `vectors.json` 已接近上限（见第 12 节），别混进去 |
| 表情包降权 | 哈希重复 >3 次或尺寸 <100px：importance 压 0.5、不进 L3 | 否则 L3 视图全是表情包 |

### 两期落地

- **Phase 1（零新依赖）**：`commitOne` 加 `media` 字段；带图时算哈希 → 存 `media/` → VLM 出 caption + OCR → caption 拼进记忆文本。检索/摘要/融合全复用现有管线。
- **Phase 2（可选，跨模态搜图）**：加中文 CLIP（ONNX 本地推理免费），图片向量进独立索引，支持「找那张猫图」这类无文字线索的查询。**不进 Phase 1**——caption 已覆盖大部分场景，多一套索引多一份维护。

### 代码落点

| 位置 | 改什么 |
|---|---|
| `makeItem` | 加 `media: []` |
| `commitOne` / `writeMany` | 入参加 `images`，写盘前算哈希 + 生成 caption/OCR |
| `forget()` | 删 archive 文件处顺带减引用计数 |
| `store.json` | 只增字段，不动结构（向后兼容） |
| 归档 `.md` | frontmatter 加 `media: [hash...]` |

---

## 12. 向量存储扩容（**① 已实施 2026-10-31**；②③ 仍预备）

> 解决第 9 节那条 `RangeError: Invalid string length`。
> **① 分片已落地**（见下方「实施记录」）；②③ 仍是不许当已做的预备，动手前问用户。
> 本节与第 10 节（HNSW 索引）是**两件事**：本节解决「存得下、启动得了」，第 10 节解决「查得快」。内存问题见文末。

### 问题定量

向量 base64 落盘 **5.4KB/条**（1024 维 Float32Array）：

| 条数 | vectors.json 大小 | 状态 |
|---|---|---|
| 1,184（现在） | 6.5MB | 无感 |
| 1 万 | 54MB | 正常 |
| 5 万 | 270MB | parse 变慢（秒级） |
| **10 万** | **540MB** | **接近 V8 字符串上限，危险** |
| **20 万** | **1.08GB** | **必炸** |

两个原因叠加：① V8 的 JSON 字符串长度上限；② `JSON.parse` 峰值内存是文件的 2~3 倍。

### 三层解法（按规模递进）

| 阶段 | 做法 | 能撑到 | 改动 | 代价 |
|---|---|---|---|---|
| **① 分片 JSON** ✅ | `vectors-part-{i}.json`，每片 ≤5000 条（≤27MB） | ~10 万条 | 约 20 行，当天可上 | 启动要读全部片（5~8 秒） |
| **② 二进制 + 偏移索引**（治本） | `vectors.bin` 定长记录（1024×4B 顺序追加）+ `index.json`（id→片号/偏移，约 40B/条） | ~100 万条 | 半天 + 迁移脚本 | 丢可读性（base64 本来也不可读） |
| **③ SQLite / 磁盘 ANN + 量化** | `vectors(id TEXT PK, vec BLOB)`；配 int8 量化 | 千万级 | 大，与第 10 节一起 | 原生依赖、迁移重 |

**推荐路径**：① 已完成（撑到十万条）；过 5 万条做 ②；③ 跟 HNSW 一起上。

### ① 实施记录（2026-10-31）

改动全在 `createStore`（memory5.mjs），**调用方零改动**：

- 每片最多 **5000 条**（约 26MB），文件名 `vectors-part-0000.json` 起，序号定读取顺序；
- 写入：全量重写所有分片 + **清掉多余旧片**（条目变少时）；`vectors` 为空时清空全部片；
- 读取：按序号依次并入，片间重复 id 只认第一份（防异常数据）；
- **旧库自动迁移**：没有分片但存在旧 `vectors.json` 时，读出 → 写分片 → 旧文件改名 `vectors.json.bak`（保留回退，下次不再读）；
- 快照工具：`mem.dumpVectors(path)` 合并导出单文件（给分析/调试用，库大时慎用）。

实测（专项脚本）：12001 条 → 3 片（26.1/26.1/10.5MB），重载条数与首末值全对；
删到 4000 条后多余分片自动清理；旧格式迁移后 `.bak` 生成、原文件不再被读。
78 项回归全过（41 + 20 + 17）。

**顺带修的一处**：`simulate-big.mjs` / `simulate-m5.mjs` 原来用 `copyFileSync` 拷 `vectors.json` 做快照，
分片后文件不存在了，改成调 `mem.dumpVectors()`。

### ② 的关键设计（真做时照这个来）

- `vectors.bin` 里每条**定长 4096 字节**，顺序追加；偏移 = 序号 × 4096，不用额外存储；
- `index.json` 只存 `{ dim: 1024, ids: ["id1","id2",...] }`（数组顺序对应记录顺序），20 万条约 8MB，远低于 JSON 上限；
- 读取用 `fs.readSync` + `Float32Array` view **零拷贝**，不经过 JSON.parse；
- 删除用**墓碑 + 定期压缩**（与第 10 节 HNSW 的删除策略一致，正好同一套失效标记）。

### 终局问题：内存（比存储更晚爆，但更致命）

存储解决了，**内存还没解决**。检索是全扫余弦，所有向量必须在内存：

| 条数 | 内存（float32，4KB/条） | 结论 |
|---|---|---|
| 20 万 | 800MB | 勉强 |
| 50 万 | 2GB | 危险 |
| 100 万 | **4GB** | Node 必 OOM |

真终局是 **int8 量化**（4KB→1KB/条，召回损失 <1%）或 **mmap + 磁盘 ANN**。这跟存储是两件事，别混。

### 代码落点

| 位置 | 改什么 | 状态 |
|---|---|---|
| `createStore` 读 | 分片按序读；无分片时读旧单文件并迁移 | ✅ 已做 |
| `createStore.save()` / `saveVectors()` | 写分片 + 清多余旧片 | ✅ 已做 |
| `mem.dumpVectors(path)` | 合并导出快照（调试/分析） | ✅ 已做 |
| `simulate-big` / `simulate-m5` 快照 | `copyFileSync` → `mem.dumpVectors()` | ✅ 已做 |
| ② 二进制 + 偏移索引 | 见上方设计 | 未做 |
| ③ SQLite / 磁盘 ANN | 与第 10 节合并 | 未做 |

### 与第 10 节的关系

第 10 节「明确不做」里曾写「Float32Array 落盘只省 25%，等撞上 RangeError 再做」。
**现在这条升级为正式方案**——不是为省空间，是为绕开 JSON 字符串上限。做的时候两节合并实施。

---

## 13. 文件结构

| 文件 | 作用 |
|---|---|
| `memory5.mjs` | 核心：六层、写入、路由、融合、检索、遗忘、存储分片 |
| `store.json` | 条目元数据（单文件，未分片） |
| `vectors-part-*.json` | 向量分片，每片 ≤5000 条（2026-10-31 起；旧 `vectors.json` 自动迁移为 `.bak`） |
| `archive/{channel}/{id}.md` | 深层原文归档 |
| `graveyard/forgotten.jsonl` | 遗忘台账 |
| `silicon.mjs` | 模型调用：embed / classify / relation / summarize / rerank，含 token 预算闸 |
| `simulate-big.mjs` | 压测：按天推进 + 心跳 + 分段计时 + 健康检查 |
| `watch.mjs` | 看门狗：心跳超 3 分钟判卡死 |
| `build-dataset.mjs` | 造测试数据集 |
| `test-m5.mjs` / `test-batch.mjs` | 端到端测试（41 + 20 项） |
| `REFACTOR_PLAN.md` | 决策记录（D1–D28） |

---

## 14. 模型提示词清单（改之前先看这节）

> 提示词是**行为的一部分，但回归测不出来**（测试用假模型）。改一句可能让 78 项全过、实际效果全变。

### 各环节提示词

| 环节 | 函数 | 位置 | 要点 |
|---|---|---|---|
| 分类 | `classify` / `classifyBatch` | `silicon.mjs` `CLASSIFY_SYS` + 批量版 | 三档定义 + 10 个示例；「0.85 一天不超过一两条」「做了事拿到结果是 0.6 不是 0.85」；本地规则前置（`LOW/HIGH_PATTERNS`）省钱 |
| 摘要（主路径） | `summarizeWithSources` | `silicon.mjs` ~580 行 | 摘要 + 出处编号 + ★/·/+ 三档；**条数上限 n/10 是刹车不是任务量**；一条只讲一件事；人名必留；`+` 约二三成 |
| 摘要（无出处） | `summarize` | `silicon.mjs` ~470 行 | 按 channel 换重点（action/dialog/event 三套 focus）；1-3 行，`·` 开头，每条 ≤40 字 |
| 判关系 | `relation` | `silicon.mjs` ~836 行 | 四类：duplicate / contradiction / update / unrelated；**update 不能误判成 contradiction**（否则删掉进展史） |
| 判同一件事（旧） | `sameEvent` | `silicon.mjs` ~814 行 | 极简 yes/no，已不是主路径 |
| 向量 / 精排 / 压缩 | — | — | 向量和 rerank 不需要提示词（API 自带打分）；**compress 有意停用**（实测模型压缩一个字都减不掉） |

### 三个跨环节的硬约束（改提示词时别弄丢）

1. **必须 `thinking: false`**。不传会开推理，输出被 maxTokens 截断——历史事故：输出 295K token 是输入的 2.4 倍，钱全烧在被截断的思考上。
2. **单块上限 `summaryChunk: 60`**。分块会重复付 system 提示词的钱；大模型按输入线性计费，一次 60 条最省。
3. **人名和数字必须保留**。摘要把「张三说要爬山」压成「聊了爬山」，这条记忆就废了。

### 改提示词的验证流程（必须是这套，别偷懒）

```
① 改 silicon.mjs 的提示词
② 真实模型跑 20~50 条样本（不能用 test-m5 的假模型）
③ 人工对比：摘要是否丢人名/数字、是否硬凑、★ 比例是否合理
④ 只有 ①②③ 都过，才跑 78 项回归确认没把代码改坏
```

回归只能证明「代码没坏」，证明不了「提示词变好」。两者缺一不可，顺序不能反。

---

## 15. 接入方式：上下文 ↔ 记忆

> **状态：已接入（2026-10-31）。** `index.mjs` 已从 v1（`memory.mjs` 三层）切到 **v5（`memory5.mjs` 六层）**。
> 数据目录换成 `~/.dsh/storages/memory-v5`（v1 的旧库不迁移，留在原目录）。
> 插件是 link 安装，改完**重启 dsh 生效**。

### 装在哪（踩过的坑）

插件必须装进**你实际启动的那个 profile**：

| profile | 谁在用 | 装法 |
|---|---|---|
| `desktop` | 桌面版 DeepSeek Harness（Electron） | 手动改 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` + `dsh.profile.bundles`，然后 `pnpm install` |
| `web` | `dsh web` 命令行起的实例 | `dsh plugin --profile web add ./` |

**症状**：装在 web、却启动桌面版 → 插件完全不加载、`storages/memory-v5` 不生成、没有任何报错。
判断方法：重启后看 `~/.dsh/storages/memory-v5/status.json` 是否存在。

### 配置方式：config.json（不是设置页表单）

**没有配置界面是有意的**：dsh 的设置页表单需要 `schemastery` 声明 schema，
而 link 安装的插件 **import 不到 dsh 自己的包**（和 `defineTool` 同一个坑）。
所以配置走 JSON 文件，零依赖：

```
~/.dsh/storages/memory-v5/config.json
```

首次启动自动生成示例。字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKey` | `''` | 硅基流动 key；留空则用本地哈希向量（语义弱） |
| `apiBase` | `https://api.siliconflow.cn/v1` | 也可用环境变量 `SILICONFLOW_API_KEY` |
| `bootMaxChars` | 4200 | 每轮注入上下文的最大字数 |
| `autoCapture` | true | 是否自动捕获对话 |
| `userCaptureChars` | 2000 | 单条用户消息截断 |
| `toolCaptureChars` | 500 | 工具输出截断 |
| `budgetTokens` | 0 | 进程级 token 预算，0 不限 |

### 怎么用

| 场景 | 做什么 |
|---|---|
| 自动记忆 | **什么都不用做**。每轮 `turn/end` 自动把用户消息和工具行为写进 L1，`deferred` 摘要后台跑 |
| 查看状态 | `/memory`（概览）；`/memory list`；`/memory search 关键词`；`/memory flush`；`/memory sweep` |
| 模型主动记 | `memory_write` 工具（补充自动捕获漏掉的结论） |
| 模型主动查 | `memory_search` → 确认相关后 `memory_attend`（搜到不涨热度） |
| 排查 | 看 `status.json` 的 `promptInjected` / `semantic` 字段；日志里 `[memory-tiers]` 前缀 |

### 两条路径

```
写入（上下文 → L1）：
  每条消息 → mem.write({ text, speaker, people, scene, channel, at })
           → commitOne：embed + 进 L1（不判重、不分类、不摘要）
           → 溢出时按 deferred 入队 → 空闲 flushSummaries() 沉淀

读取（记忆 → 上下文）：
  每轮组装 prompt → mem.buildBlock(budget, { includeHot: false })
    ├─ 「一直记得的」= L3 视图（DL3 按 importance×heat 截前 N）
    └─ 「最近沉淀的」= L2
    （「刚发生的」= L1 默认不注入，理由见下节）
  → ctx.systemPrompt.context({ name:'memory-tiers', order:250, text })
    ★ 是 context（追加式 user 快照），不是 section（塞系统提示词）
```

### 写入 L1 的三种方案（关键决策）

| 方案 | 谁触发 | 优点 | 缺点 |
|---|---|---|---|
| **A 模型主动**（v1 现状） | 模型调 `memory_write` 工具 | 简单；模型判断质量高 | **漏记、记得太碎、会自己去重**——v5 的核心信号「重复度 = 重要性」直接失效 |
| **B 自动捕获**（v5 设计意图）✅ | 订阅 `session/event`，按 turn 写入 | 全量、不靠自觉；重复度信号完整 | 需要过滤系统注入；工具输出要截断 |
| **C 提示词要求** | 在 systemPrompt 里让模型每轮自己写 | 零改造 | 不稳定，等于 A 的弱化版 |

**结论：走 B，钩子已经确认存在。** dsh 的 session 是事件溯源（event-sourced）的，
每次 append 都会 post-commit 广播：

```js
ctx.on('session/event', (session, event) => {
  // event.type ∈ user/message | assistant/message | tool/call | tool/result | turn/end | ...
  // event.data 是对应 payload
})
```

**可用的事件（dsh-session 的 `KNOWN_SESSION_EVENT_TYPES` 里挑出来的）**：

| 事件 | payload | 记忆里对应什么 |
|---|---|---|
| `user/message` | `UserMessage`（`content: ContentBlock[]`、`source`） | 用户原话 → `channel='dialog'` |
| `assistant/message` | `AssistantMessage`（含 `usage`） | AI 回复 → `channel='dialog'`（可选，可截断） |
| `tool/call` | `name`、`arguments`（原始 JSON 字符串）、`callId` | 行为的前半：调了什么 |
| `tool/result` | `message: ToolResultMessage`、`isError`、`callId` | 行为的后半：结果如何 |
| `turn/start` / `turn/end` | `{ turn }` / `{ turn, reason }` | **收口时机**：一轮结束再写 |

### 「事件」和「行为」怎么进 L1

核心原则：**按 turn 聚合，不逐条事件写**。一轮对话结束时（`turn/end`）把这一轮合成 1~N 条记忆：

```
一轮对话：
  user/message      「帮我把测试跑一下」        ┐
  assistant/message 「好，我跑一下」            │
  tool/call         bash: npm test              ├─ 合成：
  tool/result       「3 个失败：test-m5 …」     │
  assistant/message 「3 个失败，我看了下…」     ┘

写入：
  { text: '用户：帮我把测试跑一下', channel: 'dialog', speaker: 'user' }
  { text: '运行 bash「npm test」→ 3 个失败：test-m5…', channel: 'action', speaker: 'bot' }
  { text: 'AI：3 个失败，我看了下…', channel: 'dialog', speaker: 'bot' }
```

**六个必须处理的细节**：

1. **过滤系统注入**。`user/message` 的 `source` 不只有人类——`agent.inject()`、skill 内容、
   cron 通知、子目录 AGENTS.md 都走这个事件。只记 `source` 是人类输入的那类，否则 L1 会被
   系统注入污染，而且每轮重复注入会让「重复度=重要性」信号失真。
2. **只取 text 块**。`content` 是 `ContentBlock[]`，还有 `reasoning`（思考）和 `image`。
   思考过程不该进记忆——它是模型的草稿，不是事实。
3. **工具调用要配对**。`tool/call` 只有 name+arguments，`tool/result` 才有结果，靠 `callId` 配对；
   一轮可能有多个 step（多次工具调用），在 `turn/end` 统一收口。
4. **工具输出截断**。bash 输出动辄几万字，记前 500 字 + `…（截断）`，否则 L1 一次就被撑爆。
5. **`turn/end` 才写**。中途写会得到半截对话（问了还没答），而且写入次数多一倍。
6. **写完即 flush（可选）**。`deferred` 模式下 turn/end 写入不阻塞，空闲调 `flushSummaries()`。

### v5 接入改造清单（已完成）

| # | 改什么 | 状态 |
|---|---|---|
| 1 | `package.json` 的 `files` 加 `memory5.mjs` / `silicon.mjs` | ✅ 已做（版本 0.2.0） |
| 2 | `index.mjs` 换 `createMemory5` | ✅ 已做 |
| 3 | 工具：`memory_write`（写一条） | ✅ 已做 |
| 4 | 工具：`memory_search` + `memory_attend` | ✅ 已做（搜到不涨热度，确认才涨） |
| 5 | 注入：`systemPrompt.section` | ✅ 已做（`buildBlock`，`order: 2600`） |
| 6 | 订阅 `session/event` | ✅ 已做（按 turn 聚合 + 过滤系统注入 + 工具输出截断） |
| 7 | 定时 flush / sweep | ✅ 已做（5 分钟 flush，6 小时 sweep） |
| 8 | 无 key 降级 | ✅ 已做（本地哈希向量，语义变弱但不崩） |

**冒烟验证**（假 ctx）：5 个工具注册、`session/event` 订阅、一轮对话写入 2 条
（用户消息 + 工具行为，skill 注入被正确过滤）、`buildBlock` 注入正常、78 项回归全过。

### 自动捕获的实现要点

- **按 turn 聚合**：`user/message` → 缓冲；`tool/call` + `tool/result` 按 `callId` 配对；
  `turn/end` 时一次性 `writeMany`。
- **过滤**：只记 `source.kind === 'user'` 的输入（`agent.inject` / skill / cron 的 kind 不是它）。
- **截断**：用户消息 ≤2000 字，工具输出 ≤500 字（bash 一次能吐几万字，L1 才 1500 字）。
- **失败兜底**：没有 embedding key 时用本地哈希向量；写入失败只打日志，不影响对话。

### 启动时要做的一件事

v1 是 `mem.decay()`（补结算关机以来的遗忘）；v5 对应的是 `mem.sweep()`——它会执行完整的分层收敛（作废条沉底、L1/L2 溢出、DL1 遗忘）。**启动不扫一次，停机期间该忘的不会忘。**

---

## 16. 上下文成本：为什么不能塞系统提示词（2026-10-31 修）

> 症状：每轮只发一句话，账单上却涨好几万 token。实测定位后修掉，本节记过程和结论。

### 实测数据（dsh 桌面版，deepseek-flash，4 轮简单对话）

会话记录 `~/.dsh/sessions/*/session.v4.jsonl.zstd` 里每次 `assistant/message` 都带 `usage`：

| 轮次 | inputTokens（未命中） | cacheReadTokens | 说明 |
|---|---|---|---|
| 1 | 12715 | 0 | 首次，全量计费，正常 |
| 2 | **4018** | 12800 | 本该只有几百（新增消息） |
| 3 | 4034 | 16896 | 同上 |
| 4 | 4009 | 25600 | 同上 |

`totalTokens` 是累加值（12847 → 16926 → 21310 → 25609 → 29815），**界面上看到的「好几万」就是这个累计数**。真正的问题是每轮有约 4000 token 未命中缓存、按全价计费。

### 根因：记忆块坐在系统提示词正中间

dsh 的缓存是**前缀缓存**——从第一个 token 开始匹配，一旦某处变了，**它后面的全部失效**。

对齐两轮 system message 后发现：9729 字里前 6625 字（68%）一致，**分歧点正好是记忆块**：

```
…（前 68% 稳定的身份/策略/工具说明）
## 刚发生的                    ← 记忆块从这里开始
- 10-31 [user] 小鱼是你吗      ← 每轮都是新的
（后面还有 3100 字稳定的工具说明，全被连累）
```

三个错叠在一起：

1. **位置错**：`order: 2600` 正好撞上 `SECTION_ORDERS.TOOL_WORKFLOW`，记忆块插在工具说明中间，
   把它后面的 3100 字稳定内容一起拖下水。
2. **内容错**：L1「刚发生的」是当前会话的对话——**历史里本来就有**，注入等于每轮重说一遍，还每轮变。
3. **机制错**：用 `section()` 塞系统提示词，变化必然导致后续前缀失效。

### 修法：换成追加式快照 + 砍掉 L1 + 节流

**① 用 `systemPrompt.context()` 代替 `section()`**

dsh 有两套注入接口，语义完全不同：

| | `section()` | `context()` |
|---|---|---|
| 去哪 | 拼进**系统提示词** | 作为 **user 角色快照**追加进历史 |
| 变化后果 | 它之后的系统提示词全部重新计费 | 只多一条消息，**前面的历史缓存不受影响** |
| 去重 | 无 | 框架比对文本，**内容没变就不追加**（`project()` 里的 `retained?.text === snapshot` 判断）|

系统提示词因此变成逐字节不变 → 首轮之后全量命中缓存。

**② L1 不再注入（`injectHot: false`）**

L1 存的是当前会话的对话原文，模型在历史里已经看过。把它再塞进注入块，
唯一效果就是让注入块每轮都变、缓存每轮都断。跨会话恢复靠 L2/L3（沉淀过的）+ `memory_search`（按需检索）。

**③ 节流（`refreshMinMs`，默认 5 分钟）**

L3 视图按 `importance × heat` 截取，而 heat 随时间衰减，边界条目的分数会此消彼长，
入选集合偶尔变一条 → 文本变化 → 快照刷新。5 分钟内的变化先压住，返回上一次的文本。
记忆晚几分钟进上下文没人察觉，但省下的是真金白银。

### 效果

- 注入块从 4055 字降到 3952 字（L1 只占 103 字，省的不多）
- **但内容从「每轮必变」变成「几乎不变」**（正式库连续 3 次调用逐字节一致）
- 系统提示词恢复逐字节稳定，每轮省约 4000 token 全价计费

### 这条经验推广到任何注入

> **凡是每轮可能变的内容，都不能放进系统提示词；要么走 `context()`，要么放最后。**

判断顺序：
1. 内容会变吗？不变 → `section()` 随便放
2. 会变 → 用 `context()`（追加，不破坏前缀）
3. `context()` 也用不了 → `section()` 的 order 必须**大于** `SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX`（10200），保证后面没内容可污染

### 怎么自己复现诊断

```bash
# 解开会话记录，看每轮 usage
zstd -dc ~/.dsh/sessions/*/*/session.v4.jsonl.zstd | node -e "
let b='';process.stdin.on('data',d=>b+=d).on('end',()=>{
  for(const l of b.split('\n')){const o=l&&JSON.parse(l);
    if(o&&o.type==='assistant/message'&&o.data?.usage)console.log(o.data.turn,JSON.stringify(o.data.usage))}
})"
```

判读：**`inputTokens` 应该只有「新增消息」的量（几百），`cacheReadTokens` 才是历史量**。
如果每轮 `inputTokens` 都是几千、且接近系统提示词的字数，就是系统提示词在被破坏。

### 后续：修复生效了，但那 6 万不是记忆的锅（2026-10-31 19:40）

重启后同一个会话的实测：

| 轮次 | 未命中 input | 缓存重读 cacheRead | 总输入 |
|---|---|---|---|
| 4.1（修前） | 4009 | 25600 | 29609 |
| 5.1（切换那轮） | 4343 | 29696 | 34039 |
| 5.2 | 176 | 34560 | 34736 |
| 6.1 | 3011 | 56576 | 59587 |
| 7.1 | **221** | 59648 | 59869 |
| 8.1 | **156** | 59904 | 60060 |

系统提示词从 9885 字降到 **5775 字**（记忆块 3952 字移出），5.1 之后每轮未命中稳定在 **156~221 token**。修复有效。

**但总输入仍是 6 万。** 拆开看这 6 万是怎么来的（统计整个会话的字符构成）：

| 成分 | 字符数 | 占比 |
|---|---|---|
| **工具结果**（Bash 输出、文件读取） | 55978 | **46.5%** |
| system 提示词（只算最后一条 5775） | — | — |
| assistant 思考（reasoning） | 5727 | 4.8% |
| assistant 工具调用参数 | 2977 | 2.5% |
| **记忆快照**（1 条，替换语义只保留最新） | 3952 | **约 4%** |
| assistant 正文 | 873 | 0.7% |

**结论：上下文里记忆只占 4%，46.5% 是工具输出。** 一个干了大量文件读取/命令执行的会话，6 万上下文是正常水位，跟记忆插件无关。

两个容易误读的点：

1. **`totalTokens` 是会话累计值**，不是单轮消耗。界面上看到「6 万」往往是这个数累计到 6 万，或者 `input + cacheRead` = 上下文总长度。
2. **`cacheReadTokens` 要计费**，但按缓存命中价（DeepSeek 是未命中的约 1/10）。6 万缓存 token 的钱 ≈ 6 千全价 token。

### 快照会累积吗？不会

`dsh-session` 里 `isReplacementSurfaceEvent()` 判定 `surfaceOp !== 'append'` 为替换：
新快照会 **shadow 掉旧快照**，旧的不再进上下文（只在 session 日志里留痕）。所以快照再多也不会线性膨胀，
但**每次刷新仍会带来一条新的几百上千 token 内容**（旧的那条才被释放）。

因此 `refreshMinMs` 默认调成 **30 分钟**——记忆是长期背景，半小时内变了也不着急进上下文。

### 想真正把上下文压下来，按收益排序

| 手段 | 效果 |
|---|---|
| **开新会话** | 最彻底。历史清零，上下文直接回到 1 万级 |
| **少让工具全量打印** | 一条 `cat` 长文件就是几千字。用 `grep -c` / `head` / `-o` 只取需要的 |
| 调小 `memoryCfg.longMaxChars` | 每条记忆快照的字数上限，从 4000 降到 2000 可省一半（代价：进上下文的记忆条数变少） |
| 调大 `refreshMinMs` | 减少快照刷新次数，默认已是 30 分钟 |

---

## 17. 已知问题清单（待修，按发现时间倒序）

> 这里只记「确认存在但暂不修」的问题。修完的挪到对应章节的实施记录里。
> 每条要写清楚：现象、怎么发现的、影响、可能的修法。

### K1 · action 通道一条都没写进 L1（2026-10-31 发现 → 同日已修）

**状态：✅ 已修复 2026-10-31 20:40。** 根因 + 修法见本节末尾。

**现象**：插件设计上每轮结束会写两类记忆——用户消息进 `channel: 'dialog'`，
工具调用（`tool/call` + `tool/result` 配对）进 `channel: 'action'`。但实测 L1 的 9 条
**全部是 `dialog`，`action` 零条**。

**怎么发现的**：

```bash
node -e "
const d=JSON.parse(require('fs').readFileSync('store.json','utf8'));
const l1=d.items.filter(i=>i.layer==='L1');
l1.forEach(i=>console.log(i.channel, i.text.length+'字', i.text.slice(0,40)))"
# 输出 9 条全是 dialog：小鱼是你吗 / 艾婷门的群号是多少 / 照旧今天还没亲你呢…
```

**影响**：

- 「昨天帮你修过什么」这类**行为记忆**完全没有——只能靠会话历史，会话一关就没了
- 跨会话恢复时模型不知道自己以前干过什么活
- 反过来看，从省 token 角度这是好事（少记一堆命令输出）；所以不急

**可能的原因**（未验证，按可能性排序）：

1. `turn/end` 时 `buf.tools` 已经被清空——比如 `turn/end` 事件先于最后一个 `tool/result` 到达，
   或者某些步骤不发 `turn/end`
2. `tool/call` / `tool/result` 的字段名与我用的 `d.callId` / `d.name` / `d.arguments` 不一致
   （dsh 版本差异）
3. `writeMany` 对 `channel: 'action'` 的条目有过滤（比如重要性阈值），静默丢掉

**修法**：加一条审计——每次 `turn/end` 把「本轮 buffered 的 user 条数 / tool 条数 / 实际写入条数」
写进 `audit.log`。有了这条日志，下次一看就知道是「没抓到」还是「抓到没写」。
先加日志，别急着改逻辑。

### K1 修复记录（2026-10-31 20:40）

**根因**：`tool/result` 事件的 `callId` 和 `isError` **不在 `event.data` 顶层，而在 `event.data.message` 里**。

```js
// 真实结构（从 session.v4.jsonl.zstd 里捞出来的）
{ type: 'tool/result', data: {
    turn: 3, step: 1,
    message: {
      role: 'tool',
      toolCallId: 'call_00_...',   // ← callId 在这里
      isError: false,              // ← isError 也在这里
      content: [...] } } }

// 旧代码（永远拿到 undefined）
const c = buf.tools.get(d.callId)   // undefined
c.err = !!d.isError                 // 恒为 false
```

匹配不上 → `c.done` 永远是 `false` → 被 `if (!c.done) continue` 静默跳过 → **action 零条，无任何报错**。

**修法**（`index.mjs` 的 `session/event` 处理器）：

```js
const cid = d.callId ?? d.message?.toolCallId ?? d.message?.source?.callId
const c = cid ? buf.tools.get(cid) : undefined
c.err = !!(d.isError ?? d.message?.isError)
```

同时改了两处行为：

1. **没配到 result 的调用也记**。原来 `if (!c.done) continue` 直接丢掉被中断的调用，
   现在记成「未完成：（被中断，无结果）」——用户要求「每次对话结束后记录确确实实进了 L1」，
   漏记等于打破这个保证。
2. **加 `capture.log` 审计**。每轮结束追加一行到 `<数据目录>/capture.log`：
   `turn 归档 user=1 tool=3 rows=4 written=4 L1=4`。
   这类「静默丢数据」的 bug，只有把「抓到几条 / 写了几条 / 库里几条」摆在一起才看得见。

**验证**（模拟一轮含完成/失败/中断三种调用）：

```
dialog  "帮我跑下测试"
action  "运行 bash「{"command":"npm test"}」→ 完成：3 个失败：test-m5"
action  "运行 read「{"file_path":"x.mjs"}」→ 失败：ENOENT: no such file"
action  "运行 grep「{"pattern":"foo"}」→ 未完成：（被中断，无结果）
capture.log: turn 归档 user=1 tool=3 rows=4 written=4 L1=4
```

回归 41 + 20 + 17 全过。

**遗留**：`capture.log` 会一直增长，暂不轮转。等它大到碍事再说（一天几百行，无所谓）。

### K2 · 压缩阈值曾是 84 万 token（2026-10-31 已改配置，不算 bug）

不是代码问题，但记一笔：dsh 默认 `thresholdRatio: 0.8`（上下文窗口 1048576 的 80%），
实际用不到那个量级，导致一条 4.3 万字工具输出永久滞留、每轮重读。
已在 `~/.dsh/profiles/desktop/cordis.patch.yml` 覆盖为 `0.06` / `retainRatio: 0.03`，
`tool-result-pruner` 的 `thresholdChars` 从 8192 降到 4000。详见第 16 节。

### 20:55 收紧到极限（1 万触发，只留 800 token）

用户要求「把 dsh 自带的会话记录删掉，历史全交给记忆系统」。配置改成：

```yaml
- id: compaction-basic
  config:
    thresholdRatio: 0.01    # ≈1.05 万 token 就压
    retainTokens: 800       # 只留最近 800 token 原文
    headroomTokens: 4096    # 默认 65536 会把触发点推得很晚
```

**预期**：上下文从 ~1.6 万降到 ~0.8 万（系统 6k + 摘要 + 800 原文）。

**但有个账必须算清楚——LLM 压缩可能比不压缩更贵：**

```
不压缩：每轮 1.6 万，绝大部分是缓存命中（约 1/10 价）
        ≈ 0.0016 元/轮

压缩后：每轮 0.8 万                           ≈ 0.0008 元/轮
        + 每 4 轮一次压缩：读 1 万 + 写摘要
          约 0.0065 元/次 ÷ 4              ≈ 0.0016 元/轮
        ─────────────────────────────────────────
        合计                                   ≈ 0.0024 元/轮
```

**结论：为了省钱而用 LLM 压缩是亏的**（贵约 50%）。压缩真正的价值是**防止上下文无限增长**（长会话会撞 104 万窗口），不是省钱。

要真正做到「零成本删历史」，只有一条路：**自定义 CompactionEngine**，压缩时不调模型，直接把选区归档进记忆再丢。

**为什么没直接做**（2026-10-31 结论）：

1. `CompactionEngine` 是 `@deepseek-ai/dsh-compaction` 的抽象类，link 安装的插件 **import 不到**（同 `defineTool` / `schemastery` 那个坑）。
   绕法是用 `ctx.provide('compaction', 鸭子类型对象)`，理论上可行但未验证。
2. **没有 dsh 运行环境可测**。压缩涉及 surface 选区、tool call/result 配对平衡、`compaction/start|end` 锁、失败回滚——
   写错会**直接损坏会话**（用户全部对话丢失）。这种代码不能"写完再说"。
3. 需要先把 `compaction-basic` 在配置里 `disabled: true` 才能换实现，切换瞬间如果新实现有 bug，会话就停在那里压不动了。

**如果要继续做**，建议顺序：先在本地拨出一个一次性 dsh profile 做试验田，用固定 fixture 会话反复压，验证不损坏再上主 profile。

---

## 18. 历史压缩：插件接管，零 LLM（2026-10-31 实施）

> 前情：用户要的不是「压缩省钱」，是**上下文大小恒定**——每轮不调工具时 token 消耗应该差不多。
> LLM 压缩做不到（摘要长度不可控 + 每次要一次模型调用），所以改成插件自己压。

### 机制

```
turn/end 事件
  → ① 本轮消息写进 L1（K1 修好后 user + action 都记）
  → ② compactSurface()：把除最近 1 轮以外的历史压成一条 20 字占位
        ├─ 先归档：被压掉的对话文本写进记忆（写失败就不压，宁大不丢）
        └─ 再替换：append 一条 user/message，surfaceOp = replace(startSeq, endSeq)
```

**dsh 自带的 LLM 压缩被推到 `thresholdRatio: 0.99`**（≈104 万 token），只当最后保险：
万一本插件挂了，上下文涨到窗口 99% 时还能被 dsh 兜一层，不至于撞死。

### 为什么不用 `ctx.compaction` 接管

`CompactionEngine` 要求凑齐 `compaction/start` + 摘要节点 + `compaction/end` 三件套，
返回完整的 `CompactionResult`，还要自己处理选区、tool 配对、并发锁、失败回滚。
而它的摘要**必须调 LLM**（`summarizationProvider` / `summarizationModel` 是必填的）。

直接做 surface 替换只要 30 行，效果一样，而且零 LLM。**压完的历史不进模型，只进记忆。**

### 三个必须遵守的约束（都是实测撞出来的）

1. **`assistant/message` 不能带 `sourceEventSeqs`** —— 它内嵌 provider stream，dsh 直接抛错：
   `assistant/message embeds its source stream and cannot carry sourceEventSeqs`。
   所以替换节点只能用 `user/message`。
2. **选区必须结束在 `user/message` 之前**。否则会把 `tool/call` 和 `tool/result` 切开，
   留下孤儿 tool result。按「user/message 的位置」切分天然安全。
3. **占位本身也是 `user/message`，必须排除在轮次计数之外**。
   否则下一轮会把占位当成一轮又压一遍，无限生成新占位。判据：`source.kind === 'compaction'`。

### 配置

```json
{
  "autoCompact": true,          // 每轮结束自动压
  "compactKeepTurns": 1,        // 保留最近 1 轮原文
  "compactArchiveChars": 1200   // 每次归档进记忆的字数上限
}
```

`compactKeepTurns: 0` 可以做到「只剩占位」，但那样模型完全看不见上一句问了什么，
全靠记忆块——不建议，除非记忆块的 L1 注入打开了。

### 验证（本地 fixture，真 Session 对象，5 轮对话）

```
第 1 轮后 surface 条数: 2
第 2 轮后 surface 条数: 3   ← 从这开始恒定
第 3 轮后 surface 条数: 3
第 4 轮后 surface 条数: 3
第 5 轮后 surface 条数: 3

最终可见内容：
  （此前 1 轮对话已归档到长期记忆，需要细节可以让我检索）
  第5轮问题
  第5轮回答

capture.log:
  turn 归档 user=1 tool=0 rows=1 written=1 L1=1
  压缩 removed=2 archived=1     ← 每轮都压，surface 不再增长
```

### 预期效果

```
上下文 = 系统提示(≈6k) + 记忆块(≈1.5k) + 最近 1 轮 + 占位(20 字)
       ≈ 固定 8k 上下，聊多少轮都不变
```

代价：模型对「更早的对话」只能靠记忆块 + `memory_search`，看不见逐字原文。

### 还没覆盖的

- **压缩后 assistant 的回复不进记忆**：turn 归档只记 user + tool，assistant 正文只在
  `compactSurface` 的归档里出现（作为「前 N 轮对话」的一部分）。如果哪天要「精确回忆我说过什么」，
  得把 assistant 正文也单独记一条。
- **perf**：每轮压缩会 append 一条新事件，session 日志线性增长（磁盘），但 surface 恒定。

### 上线后撞到的三个 bug（2026-10-31 21:15 修，全部来自真实会话离线复现）

第一次上线后 `capture.log` 只有 `turn 归档`、**没有一行 `压缩`**——压缩静默失败了。
用真实会话文件（`zstd -dc session.v4.jsonl.zstd` → `Session.create(id, events)`）离线复现，抓到三个：

**B1 · 选区起点撞上系统提示词**

```
surface replace: node 0 holds the system prompt and may be rewritten
only by a system/message over exactly that node
```

`surface.nodes[0]` 是 `system/message`，dsh 禁止 replace 覆盖它。
**修法**：选区起点改成「第一个非 `system/message` 的节点」。

**B2 · `userIdx` 把框架注入算成了对话轮次**

`user/message` 有 **四种** 来源，只有第一种是真人：

| `source.kind` | 是什么 |
|---|---|
| `user` | 真人说话 ← 只算这个 |
| `runtime-context` | 运行时快照（工作目录、沙箱策略、审批策略…） |
| `skill-catalog` | 技能清单 |
| `time-context` | 时间快照 |
| `compaction` | 我们自己写的占位 |

旧代码只排除了 `compaction`，于是 6 轮对话被算成 **13 轮**，`keepTurns` 完全失真。
**修法**：`if (src?.kind !== 'user') continue`。

**B3 · 归档把框架注入原样抄进了记忆（自我污染）**

归档时没过滤来源，结果 `runtime-context` 的全文（工作目录、沙箱策略）连同**注入块里的记忆块自身**
一起被写进 L1——记忆把自己抄进了自己。而且它太长，一条就吃光 1200 字预算，
导致真正的对话只剩一句「（还有 N 条略）」，L1 里实际躺着 3 条空归档。
**修法**：归档只接受 `user` / `model` / `tool` 三种来源；超预算时改成「截断保留」而不是整条丢弃。

修完后同一份真实会话的归档内容：

```
[归档] 前 5 轮对话（已被压缩出上下文）：
user: 嗯，简单回复我下，我看看现在会不会无缘无故消耗许多token
bot: 没事，我就简单回你一句，不调工具、不查东西…
user: 「阿里云送鸡蛋那次，谁领了券？」
bot: [调用 memory_search …] [调用 memory_search …]
tool: - [lm-41] (DL3 2026/10/29) 昨晚豪豪星猫发了阿里云送鸡蛋的图…
…（另有 17 条系统注入或过长内容未收录）
```

### 真实的 token 构成（用户实测每轮 20k，2026-10-31）

| 成分 | token | 说明 |
|---|---|---|
| 系统提示词 | ≈4.5k | 5775 字 |
| **工具 schema** | **≈7.5k** | 13 个工具的 JSON 定义，**最大单项，且插件管不了** |
| 记忆块 | ≈3k | L3 视图 3952 字 |
| 对话历史 | 5k+ | 随轮数增长 → 压缩后降到 ≈100 |

**所以压缩后的地板是 ≈15k，不是我之前估的 8k。** 之前把 5775 字按 4k token 算，
忽略了工具 schema 这 7.5k。要再往下压只能减工具（dsh 侧配置）或缩记忆块。

### 21:35 去掉总闸门 bootMaxChars（限制只由三层容量决定）

用户的设计意图：**上下文大小的唯一约束应该是 L1/L2/L3 各自的容量**，不该再有一个独立的总额。

旧逻辑：`budget(4200)` 当总闸门，L3 先吃（`pack(..., Infinity)`），剩下 `rest` 分给 L2/L1。
实测后果：L3 吃掉 4067 字，L2 只剩 133 字预算、**351 字里只进了 55 字**——
「刚沉淀的对话」优先级还不如「一周前的群聊」，明显不对。

新逻辑：

```js
const longLines = pack(visible(long), Infinity)                  // 上限 = longMaxChars（l3View 已截）
const consLines = pack(visible(cons), Infinity)                  // 上限 = consolidateMaxChars（满了会溢出）
const hotLines  = includeHot ? pack(visible(hot), Infinity) : [] // 上限 = hotMaxChars
// budget 退化为可选的硬上限：0 = 不限（默认），> 0 才截断
if (budget > 0 && out.length > budget) return out.slice(0, budget)
```

效果（真实库）：

| | 改造前 | 改造后 |
|---|---|---|
| 总注入 | 4139 字 | **4625 字**（≈3.1k token） |
| L3 | 4067 字 | 4150 字 |
| L2 | **55 字** | **458 字（全进）** |

代价仅 +486 字（≈+320 token），换来「刚聊的事」能完整进上下文。

三层容量对照（默认值，都在 `DEFAULTS`）：

| 层 | 参数 | 默认 | 当前配置 |
|---|---|---|---|
| L1 | `hotMaxChars` | 2000 | — |
| L2 | `consolidateMaxChars` | 2500 | — |
| L3 | `longMaxChars` | 2000 | 4000 |

想控制上下文大小就调这三个（或 config.json 的 `memoryCfg`），不要再用 `bootMaxChars`。

---

## 19. dsh 适配层速查（换 agent 时看这节）

> 这一节把所有「dsh 特有的东西」集中列出来。移植到别的 agent 时，只需要替换本节提到的接口，
> `memory5.mjs`（六层记忆）和 `compaction.mjs` 的选区逻辑都不用动。

### 19.1 插件形态

```
package.json
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }   ← 告诉 dsh 怎么插进配置树
  "files": [...]                                           ← 漏一个文件，装上就 ERR_MODULE_NOT_FOUND
cordis.patch.yml
  - insert: [{ id: memory-tiers, name: dsh-memory-tiers }] ← id 随便取，name 必须等于包名
index.mjs
  export const name = 'memory-tiers'
  export const inject = ['tools']       ← 等这些服务就绪才加载
  export function apply(ctx, config) {}  ← dsh 启动时调一次
```

安装：`pnpm add "link:/path"`（开发）或 `pnpm add xxx.tgz`（分发），然后把包名加进
`~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles`，**重启生效**。
装错 profile 是静默失败——插件不会加载，也没有任何报错（踩过）。

### 19.2 用到的 ctx 能力

| 能力 | 用途 | 备注 |
|---|---|---|
| `ctx.tools.register({name, description, parameters, execute})` | 注册 5 个记忆工具 | 参数是手写 JSON Schema，不能用 `defineTool`（import 不到） |
| `ctx.systemPrompt.context({name, order, text, interpolate})` | 注入记忆块 | **用 context 不用 section**，原因见第 16 节 |
| `ctx.commands.register({name, ...})` | `/memory` 命令 | |
| `ctx.on('session/event', (session, event) => {})` | 捕获对话 | 返回 disposer |
| `ctx.effect(fn)` | 注册定时器 | `fn` 返回清理函数，否则卸载后泄漏 |
| `ctx.inject(['systemPrompt'], cb)` | 延迟拿服务 | 服务可能比插件晚就绪 |
| `ctx.logger` | 日志 | 可能不存在，要有 console 兜底 |

### 19.3 `session/event` 事件与字段（字段坑最费时间）

| 事件类型 | `data` 关键字段 |
|---|---|
| `user/message` | `{ role, content, source }` |
| `assistant/message` | `{ turn, step, message, usage, stream }`，`message.content` 含 `text` / `reasoning` / `tool_call` 块 |
| `tool/call` | `{ turn, step, callId, name, arguments }` ← **callId 在顶层** |
| `tool/result` | `{ turn, step, message }`，**callId 和 isError 在 `message` 里**，不在顶层 |
| `turn/start` / `turn/end` | `{ turn }` |

> ⚠️ `tool/result` 的 `d.callId` 恒为 `undefined`。正确写法：
> `d.callId ?? d.message?.toolCallId ?? d.message?.source?.callId`。
> 读错字段的后果是**所有工具调用被静默丢弃，一句报错都没有**（K1）。

`user/message` 的 `source.kind` 有五种，只有第一种是真人：

| kind | 含义 |
|---|---|
| `user` | 真人输入 |
| `runtime-context` | 运行时快照（工作目录/沙箱/审批策略），**每轮都注入** |
| `skill-catalog` | 技能清单 |
| `time-context` | 时间快照 |
| `compaction` | 压缩占位 |

过滤错会把框架注入当成对话（实测 6 轮被算成 13 轮），甚至把注入块抄进记忆形成自我污染。

### 19.4 surface（模型看得见的那部分历史）

```js
session.surface.nodes            // readonly SessionSeq[]，模型可见顺序
session.eventAt(seq)             // → SessionEvent | undefined
session.seq                      // 当前最大 seq
session.append(type, data, {     // 追加 / 替换
  surfaceOp: 'append' | { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: [...],        // ★ assistant/message 禁止带这个
})
```

三条硬规则：

1. **`assistant/message` 不能带 `sourceEventSeqs`**（内嵌 provider stream，dsh 直接抛错）
   → 压缩的替换节点只能用 `user/message`。
2. **不能 replace 系统提示词节点**：`node 0 holds the system prompt and may be rewritten
   only by a system/message over exactly that node` → 选区起点必须跳过开头的 `system/message`。
3. **`startSeq`/`endSeq` 是 surface 位置，不是数值区间**——多次替换后高位 seq 会落到老位置上。

### 19.5 怎么拿到 dsh 的包（`@deepseek-ai/*`）

link 安装的插件 **import 不到** dsh 自己的包，三个解法：

| 场景 | 方法 |
|---|---|
| 本地测试 | 绝对路径：`import('file:///…/npm-cache/_npx/<hash>/node_modules/@deepseek-ai/dsh-session/lib/index.js')`。包内部依赖会正常解析。`NODE_PATH` 对 ESM **无效** |
| 运行时拿基类 | 沿原型链偷：`Object.getPrototypeOf(ctx.compaction)` 上溯找 `constructor.name === 'CompactionEngine'` |
| 想要正经依赖 | 软链接插件目录的 `node_modules/@deepseek-ai` → npx 缓存，但 npx 路径带 hash，dsh 升级就断 |

**本插件最终的取舍：一个都不用。** 压缩改成直接做 `session.append` 的 surface 替换，
不继承任何 dsh 类，也不 import 任何 dsh 包——所以它在任何提供相同 `session` API 的宿主上都能跑。

### 19.6 数据目录（可指定，便于备份与迁移）

优先级（高 → 低）：

1. 插件配置的 `dir`（`apply(ctx, { dir })`，dsh 侧 cordis 配置）
2. 环境变量 **`MEMORY_TIERS_DIR`**（支持 `~` 展开）
3. `<DSH_HOME 或 ~/.dsh>/storages/memory-v5`

**不能从 config.json 读**——config.json 就在目录里，先有目录才能读它。

目录是**自包含**的，整个拷走就能在别处恢复：

```
<dir>/
  store.json              全部记忆条目（含分层、importance、heat、时间戳）
  vectors-part-0000.json  向量分片（每片 5000 条）
  archive/                每条记忆的 .md 归档
  graveyard/              遗忘/作废的台账
  config.json             参数（apiKey / 三层容量 / 压缩开关）
  status.json             最近一次加载状态（loadedAt / promptInjected / semantic）
  capture.log             每轮归档与压缩审计
```

### 19.7 移植到别的 agent：改动清单

| 要改的地方 | 现在（dsh） | 别的 agent 要提供什么 |
|---|---|---|
| 写入触发 | `ctx.on('session/event')` 的 `turn/end` | 任意「一轮结束」钩子，每轮调 `mem.writeMany(rows)` |
| 读取注入 | `ctx.systemPrompt.context()` | 能把一段文本作为 user 快照插进历史，且内容不变时不重复插 |
| 历史压缩 | `session.surface.nodes` + `append(replace)` | 能列出可见消息、能用一条消息替换一段 |
| 工具 | `ctx.tools.register()` | 任意 function calling 注册方式 |
| 定时维护 | `ctx.effect(setInterval)` | 任意定时器 |

**`memory5.mjs` 一行都不用改**——它只依赖 `{ text, speaker, channel, at }` 这种纯数据。
`compaction.mjs` 只依赖 `session.surface.nodes` / `eventAt` / `append` 三个方法，
适配层写个小 shim 就能复用。
