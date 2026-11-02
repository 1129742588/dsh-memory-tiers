# 多端共享记忆 · 六文件布局（最终版）

> **状态：已实施（v0.8.0）**。代码在 `memory6.mjs`，`index.mjs` 默认 `layout: "split"`。
> 验收：`node test-memory6.mjs` **48 项全过**；真实模型手测 organize / search 通过（rel 0.93）。
> 旧 `memory5` 保留做 `layout: "legacy"` 回退；旧数据不迁移（用户确认数据不重要）。
>
> 本文是**最终设计**。评审过程（为什么换、踩过的坑）见 `CHANGES.md` 和对话记录。

---

## 0. 一句话

两端共用一份记忆时，老方案是“每个写者一个文件、里面还是六层”：对方条目只读，
`moveTo` / `fuse` / `supersede` / `attend` 全跳过——**生命周期不共享**。
新方案把“整理权”收给**当轮拿到钥匙的一方**：端只写自己的 temp，其余五个文件只有一个写者。

---

## 1. 六层 ↔ 六个文件

```
memory/
  L1.json                 真 L1（单文件，只有拿钥匙的一方写）
  L1.tmp/<writer>.jsonl   每端追加自己这一轮（追完就关）
  L1.tmp/*.claimed-*      拿钥匙的人 rename 认领过来、正在并的（瞬态）
  L2.json                 缓冲层（原文）
  L3.json                 DL3 的排序快照（注入只读它，可从 DL3 重建）
  DL1.json                流水（原文，快/慢遗忘）
  DL2.json                摘要引用的原文（只收被引用的，绝不单独进）
  DL3.json                摘要池（真身）
  signals/<writer>.jsonl  attend / pin / forget 请求
  signals/applied.json    已应用的 opId（防重放）
  vectors/deep-*.json     整理者唯一写；两端只读
  organize.lock           钥匙（心跳 10 分钟过期可接管）
  organize.state.json     上一轮整理统计
```

**六个文件** = `L1/L2/L3/DL1/DL2/DL3`；`L1.tmp/` 是 L1 的暂存区，不算第七层。

---

## 2. 并发：一把钥匙 + 临时 L1

```
端每次 turn 结束：
  1. 这一轮的行（user / bot / tools，同一个 turnId）追加到 L1.tmp/<writer>.jsonl
  2. 尝试拿钥匙（open('wx') 创建 organize.lock）
     ├ 拿不到 → 本轮不整理，输入不受影响
     └ 拿到 → 合并（只有它做）：
          a. 扫遗留 *.claimed-*；把两边 temp rename 认领 → 按 id 去重并进 L1.json → 删 claimed
          b. 先消费 signals（attend 可能把 DL1 升回 L2，别被 L2 摘要抢先）
          c. 整理 L1 / L2（见 §3）
          d. 遗忘 DL1、saveDb（先写 L2/DL1/DL2/DL3，最后写 L1）、落向量
          e. L3：内容变了或到 viewRefreshMs 才重写快照
          f. 删钥匙
```

**为什么这么设计**：

- **抢钥匙用“创建文件”**，不是“读 0 再写 1”——读+写两步之间另一端也会读到 0。
- **不直接删别人的 temp**：先 `rename` 认领（原子）。改名成功才算“我收下了”；
  失败说明对方正在写，这轮跳过，下一轮再试。
- **temp 追完就关**：Windows 上 rename 被打开的文件会失败；失败也不会丢，下一轮再认领。
- **钥匙带心跳**：整理卡在模型里超过 10 分钟，另一端可以接管；接管后 `checkLock()` 让原持有者停手。
- **不阻塞输入**：拿不到钥匙就跳过整理，对话照常。
- **注入读 `L1.json` + 所有 `L1.tmp/*`（按 id 去重）**：刚结束的一轮下一轮就能看见，不等合并。

---

## 3. 溢出与路由

### 3.1 按轮次取，不切断问答

每行带 `turnId`（一轮所有行共用一个）。溢出时按时间从旧到新，**整轮**取，直到剩下的字数 ≤ 上限/2；
条数超限也兜底（剩下的条数 ≤ 上限/2）。一轮特别大时 L1 会被一次取空——允许。

```
L1 超 hotMaxChars/Items
  → 只挑“安静了 quietMs（默认 10 分钟）”的轮次
  → 按 turnId 整轮取旧一半
  → 摘要（DL3/DL2/L2/DL1）

L2 超 consolidateMaxChars/Items
  → 同样按 turnId 整轮取旧一半（用 consolidatedAt 排序，不用原文时间）
  → 再加上 DL1 全部
  → 再摘要
```

### 3.2 摘要路由（一次调用出摘要 + 出处）

| 标记 | 摘要去哪 | 引用的原文去哪 |
|---|---|---|
| `★`（L1 路径 importance ≥ 0.9） | DL3 | DL2 |
| `·`（L1 路径） | 不进 DL3 | L2（模型标 `+`）或 DL1 |
| `+`（第一次） | — | L2 |
| `+`（第二次，L2 溢出） | — | **留在 L2**（本轮最多 `l2KeepMax` 条，超出进 DL1） |
| 都没提 | — | DL1 |

**DL2 的唯一入口是“被摘要引用”**。`+` 永远不进 DL2；模型失败时整批回 L2（下轮再压），也不进 DL2。
摘要被删后留下的 DL2 孤儿，由 `reconcile` 移到 DL1。

**提示词**：`+` 从“约二三成”收紧到“约一到两成，宁少勿多”；第二次整理时额外告诉模型
`+ 最多 l2KeepMax 条`，代码再兜一层上限。

### 3.3 为什么“先写目标、最后写 L1”

崩在中间时 L1 里还有原文，靠 id 去重不会重复、不会丢。
崩在“写了 DL3、没写 L2/DL1”时，摘要已存在，`srcKey` 命中，补齐来源即可。

---

## 4. L1 记完整一轮

- 捕获：`user/message`（真人）+ `assistant/message`（正文）+ `tool/call` / `tool/result`。
- assistant 正文**按整轮拼起来再截断**（`botCaptureChars`，默认 400），不是每条消息截。
- 顺序 `user → bot → tools`；这一轮所有行共用 `turnId`。
- L1 注入按端配额：`hotQuotaOwn`（默认 0.7），自己最多 70%，剩下的给另一端；
  超出部分留在文件里、不进上下文（不丢，等整理），块尾会提示“还有 N 条未显示”。
- 行格式：`[origin·speaker]`（如 `[dsh·user]`、`[astrbot·星鲸]`），两端分得清。

---

## 5. L3 快照

- `DL3.json` 是真身；`L3.json` 是它按 `importance × heat` 排序截取的前 N 条。
- 注入只读 `L3.json`，不现场排 DL3——L3 排在注入块最前，一变后面缓存全断。
- 只在**内容变了**（新摘要/融合/取代/attend）或**到 `viewRefreshMs`** 时重写。
- 作废/新增摘要要强制刷新，否则旧命令会在 L3 里多活一个周期。
- 设置页/`stats` 显示快照生成时间。

---

## 6. 检索

- 按 depth 读文件：`summary` → DL3；`detail` → DL3 + DL2；`full` → + DL1。
- 向量只有整理者写一份（`vectors/deep-*`），两端只读——跨端语义检索这才成立。
- **detail/full 命中摘要后，顺着 `sources` 去 DL2/DL1 取原文**，不拿查询去扫 DL2。
- rerank 返回 `[{index, score}]`，按 index 映射；全被滤光时保留原分（防降级误杀）。
- 支持 `scene` 过滤；结果带 `when` / `layer` / `rel` / `via`。
- 检索只读，不改热度；热度要 `attend()` 信号确认后才涨。

---

## 7. 信号：attend / pin / forget

- 端写 `signals/<writer>.jsonl`，整理者用同样的 rename 认领方式消费。
- `attend`：热度 +1、`recallCount` +1；DL1 的升回 L2；DL3 的让 L3 重算。
- `pin`：`pinned = true`；`pickTurnBatch` 跳过钉住的轮次，遗忘也跳过。
- `forget`：先写台账，再从所有层删、删向量。
- 语义从“立即生效”变成“最多一个整理周期后生效”；工具返回“已提交”。
- `signals/applied.json` 记 opId，重放不重复。

---

## 8. 一致性与崩溃

- **同一 id 只存在一层**：`reconcile` 做层内去重 + 跨层去重（深层优先），
  L1 里已进 L2/深层的副本删掉。
- **DL2 不变式**：每条 DL2 都必须被某条 DL3 摘要的 `sources` 引用；孤儿移到 DL1。
- **先写目标层，最后写 L1**：`saveDb` 顺序 `L2 → DL1 → DL2 → DL3 → L1`。
- **claim/merge 幂等**：同一 id 只进真 L1 一次；崩了重跑不重复。
- **钥匙 fencing**：`checkLock()` 在写盘前确认钥匙还是自己的；被接管就放弃本轮。
- **原子写**：临时文件 + rename；Windows EBUSY 重试 6 次，仍失败就保留旧文件、记 audit，绝不半写。
- **读侧**：解析失败保留上一版，不把整层当空。

---

## 9. 配置

| 参数 | 默认 | 含义 |
|---|---|---|
| `layout` | `split` | `split` / `legacy`（回退） |
| `memoryCfg.hotMaxChars` | 3000 | L1 达到就整理（不是注入上限） |
| `memoryCfg.hotMaxItems` | 200 | L1 条数兜底 |
| `hotQuotaOwn` | 0.7 | L1 注入自己最多占多少 |
| `memoryCfg.consolidateMaxChars` | 2500 | L2 容量 |
| `memoryCfg.longMaxChars` | 4000 | L3 快照容量 |
| `botCaptureChars` | 400 | 一轮回复拼起来后截断 |
| `toolCaptureChars` | 500 | 单条工具输出截断 |
| `quietMs` | 600000 | 安静 10 分钟才整理 L1 |
| `organizeEveryMs` | 300000 | 整理定时器 |
| `viewRefreshMs` | 1800000 | L3 快照重算间隔（内容变会立刻重算） |
| `l2KeepMax` | 10 | 第二次整理最多留多少 `+` 在 L2 |
| `staleLockMs` | 600000 | 钥匙多久没心跳可接管 |
| `maxOrganizeMs` | 300000 | 单轮整理硬超时 |

---

## 10. 决策记录

| # | 决定 | 结论 |
|---|---|---|
| D1 | 整理由谁跑 | **谁先结束谁拿钥匙**；两端模型配置可不同，嵌入模型必须一致 |
| D2 | L1 文件形态 | **真 L1 单文件 + 每端 temp**（用户选的临时方案） |
| D3 | L3 | **独立 `L3.json` 快照**，DL3 是真身 |
| D4 | DL1 是否参与 L2 摘要 | **参与**：L2 旧半 + DL1 全部 |
| D5 | L1 注入 | **按端配额**（`hotQuotaOwn`） |
| D6 | L1 写入 embed | **不 embed**，整理时整批算 |
| D7 | attend/pin/forget | **信号队列**，最多一个整理周期后生效 |
| D8 | 正文真相 | **JSON**；archive md 只做导出 |
| D9 | 向量归属 | **整理者统一写**，两端只读 |
| D10 | 迁移 | **不迁移**，旧 `store.json` 保留；`layout=legacy` 回退 |
| D12 | bot 截断 + L1 容量 | **400 字 / 3000 字** |
| D13 | detail 检索 | **顺着 `sources` 下探 DL2** |
| D14 | L2 第二次 `+` | **留在 L2**（上限 `l2KeepMax`，超出 DL1）；**绝不进 DL2** |
| D15 | 迁移保留期 | 不适用（不迁移） |

---

## 11. 验收

```
node test-memory6.mjs     48 / 48
node test-m5.mjs          41 / 41   （legacy 回归）
node test-batch.mjs       20 / 20
node test-share.mjs       25 / 25   （legacy 分片）
node memory5.mjs          17 / 17   （热度自测）
真实模型：organize → DL3 摘要 + DL2 原文；search detail rel 0.93，原文标 via
```

---

## 12. 已知限制 / 没做

- **两端都要用 memory6**；astrbot 还在 memory5 就不会写 `L1.tmp/astrbot.jsonl`，等于没共享。
- **同名 writer 会写同一个 temp**：每个程序用插件配置或 `MEMORY_WRITER` 起不同名字。
- **旧数据不迁移**：split 从空开始；想保留旧 82 条需要一个一次性导入脚本。
- **设置页表单**没加 `layout` / `botCaptureChars` / `quietMs` / `organizeEveryMs`（可手改 `config.json`）。
- **向量索引 / HNSW**、跨机共享、五档分档：仍未做。
