# 修改记录

> 只记“改了什么、还没改什么、怎么验收”。
> 设计原理在 `ARCHITECTURE.md`，但 **2026-11-01 起不再往里追加改动记录**（那份文档越写越乱），
> 新的改动一律写这里。每完成一项，把它从「待实施」搬到「已改」。

## 怎么用

1. 动手前先在「待实施」里确认这一项，别顺手改别的
2. 改完写上：提交号、改了哪些文件、怎么验证的
3. 有分歧、没定论的写进「待决策」，标清楚卡在哪

---

## 已改

### 2026-11-02 · memory6 修复（dsh 端先跑通）

| 改动 | 文件 | 验收 |
|---|---|---|
| L3 快照写入 `dl3v`（DL3 的 mtime+size）；`buildBlock` 版本对不上就**现算**（不写盘），对方刚整理完也能立刻看到 | `memory6.mjs` | `test-memory6.mjs` ⑬（7 项） |
| `organize` 没变化就不写盘；DL3 内容没变就跳过它（否则 mtime 一变，L3 快照白刷新一次） | `memory6.mjs` | ⑭（3 项） |
| `turn/end` 之后触发一次 `organize()`——文档一直写"端结束 + 定时器"，原来只有定时器 | `index.mjs` | 手测：一轮结束后 5 分钟内沉淀（不再等满 5 分钟） |
| `embedInto` 跳过已有向量（L2 溢出时会带上 DL1 全部，之前每次都重算一遍） | `memory6.mjs` | ⑨ + 代码审查 |
| 摘要改为**一次批量** embed（原来每条摘要一次往返） | `memory6.mjs` | ⑨ |
| `saveDb` 支持跳过未变层（文件不存在时仍会创建） | `memory6.mjs` | ⑭ + 全量回归 |
| 钉住的轮次不再计入"剩余"，不会把 L1 白搬空 | `memory6.mjs` | ⑦ |
| `atomicWrite` 重试不再 `while` 空转（Node 单线程，空转会卡住整个进程） | `memory6.mjs` | 代码审查 |

**为什么**：① 修掉跨进程盲区——`l3Dirty` / `lastL3At` 是进程内变量，A 端整理完 B 端不会重写快照，新摘要最晚要等 30 分钟才进上下文；
③ 让"端结束即整理"真的发生，同时用"无变化不写盘"抵消它带来的写放大（否则每轮重写 5 个 JSON）；
④⑤ 避免重复 embed 白花钱。

**验收**：`test-memory6.mjs` 58/58、`test-m5.mjs` 41/41、`test-batch.mjs` 20/20、`test-share.mjs` 25/25。

**没改**：注入路径每轮读 6 个文件，见下方「待实施 · 已知问题 Q1」。

---

### 2026-11-01 · 六文件布局（memory6，v0.8.0）

| 改动 | 文件 | 验收 |
|---|---|---|
| 新增 split 布局：`L1.json` + `L1.tmp/` + `L2/L3/DL1/DL2/DL3.json` | `memory6.mjs` | `node test-memory6.mjs` 48 项 |
| 端只追加 `L1.tmp/<writer>.jsonl`；谁先结束谁拿钥匙整理 | `memory6.mjs`、`index.mjs` | 同上 ①⑥ |
| 溢出按 `turnId` 整轮取（剩 ≤ 上限/2）；L2 旧半 + DL1 全部 | `memory6.mjs` | 同上 ③⑦⑨ |
| **DL2 只收被摘要引用的原文**；第二次的 `+` 留 L2（上限 `l2KeepMax`，超出进 DL1） | `memory6.mjs`、`silicon.mjs` | 同上 ⑨（含“DL2 全部有摘要引用”不变式） |
| `attend` / `pin` / `forget` 走 `signals/<writer>.jsonl` | `memory6.mjs` | 同上 ⑧ |
| L3 独立快照 `L3.json`，内容变/到间隔才重写 | `memory6.mjs` | 同上 ④ |
| 检索按层读文件；detail/full 顺着摘要 `sources` 下探 DL2 | `memory6.mjs` | 同上 ④；真实模型手测 rel 0.93 |
| 捕获补 assistant 正文（**整轮**拼起来截 400 字）+ 每行 `turnId` | `index.mjs` | 一轮后 L1 有 user/bot 两条 |
| 压缩归档去重：rows 已写成功时 `archive:false` | `index.mjs`、`compaction.mjs` | 手测：一轮只进一份 |
| 配置加 `layout` / `botCaptureChars` / `quietMs` / `organizeEveryMs` | `index.mjs`、`settings.mjs` | 设置页/启动日志 |
| 旧数据不迁移：split 从空开始，旧 `store.json` 原样保留；`layout=legacy` 可回退 | — | 重启后目录里出现六个文件 |

**为什么**：两端共用一份记忆时，老方案是“每个写者一个文件、里面还是六层”，对方条目只读
（`moveTo` / `fuse` / `supersede` / `attend` 全跳过），生命周期不共享。新方案把“整理权”收给
当轮拿到钥匙的一方：端只写自己的 temp，其余五个文件只有一个写者。

**上线**：
1. 重启 dsh（插件是 link 安装，改完即生效）。
2. 数据目录会出现 `L1.json`、`L2.json`、`L3.json`、`DL1/DL2/DL3.json`、`L1.tmp/`、`signals/`、`vectors/`。
3. 旧 `store.json` / `vectors-*.json` 原样不动，可随时回退。
4. `config.json` 会按老配置跑：`layout` 缺省 = `split`；`memoryCfg.hotMaxChars` 缺省 3000。

**回退**：`config.json` 加 `"layout": "legacy"` → 重启，回到 memory5 的单文件分片。

**没做**：五档分档（见「待决策」）、向量索引、跨机共享、旧数据迁移。

---

### 2026-11-01 · 跨写者融合边界（提交 `2033df6`）

| 改动 | 文件 | 验收 |
|---|---|---|
| `moveTo` / `fuseDL3` / `markSupersede` / `attend` 遇到外来条目（`__foreign`）一律跳过 | `memory5.mjs` | `node test-share.mjs` 第⑤组 7 项 |
| 注入侧：自己的条目排前面，外来条目只借剩余空间（自己满时留 30%） | `memory5.mjs` | 同上；手动看 `buildBlock()` 输出 |
| 新增 `test-share.mjs` 第⑤组：跨文件不合并、不取代、对方条目字段一字不改 | `test-share.mjs` | 25/25 通过 |
| `.modeltest_*` 测试目录移出仓库并加进 `.gitignore` | `.gitignore` | `git status` 干净 |

**为什么改**：跨文件判重会 `mergeSummaries(对方的条目, 我的新摘要)` + `removeItem(我的新摘要)`。
合并结果落在对方对象上（存不回去），删除却写进了自己的分片（永久生效）——两边都不剩，凭空丢一条记忆。

---

## 待实施

### 已完成（v0.8.0，见顶部「六文件布局」）

- ~~S1 · L1 合并注入带渠道标记~~：L1 行已输出 `[origin·speaker]`（`[dsh·user]` / `[astrbot·星鲸]`），两端分得清。
- ~~S2 · 对方一写，我下一轮注入必见~~：注入读 `L1.json` + 所有 `L1.tmp/*`，不再有“等 30 分钟”。
- ~~S3 · 跨端语义检索~~：向量只有整理者写一份（`vectors/deep-*`），两端只读，跨端语义检索成立。
- ~~S4 · L1 容量的合并语义~~：容量是**全局阈值**（`memoryCfg.hotMaxChars`），
  注入是**按端配额**（`hotQuotaOwn`，自己最多 70%，剩下的给另一端）。

### 已知问题（暂不改，等你点头）

| # | 问题 | 影响 | 改法 |
|---|---|---|---|
| Q1 | **注入每轮读 6 个文件**：`buildBlock` → `readL1View` → `deepIdSet()` 全量解析 DL1/DL2/DL3，L2 还被读两次 | 库大（DL1 上千条）时每轮 10–30ms 同步 IO，阻塞事件循环 | 正常流程下 L1 不含深层 id（`saveDb` 先写目标层、最后写 L1），这个比对只有崩溃后才需要 → 挪到 `reconcile` 里，注入不做全量比对；或维护一个 `L1.ids.json` 小索引 |

### 还没做

- **五档分档**（见下「待决策」D2）——现在还是 citation 三路（DL2 / L2 / DL1）。
- **`routeMode: 'importance'` 旧路径**（D3）：memory5 里两套分流并存；split 布局不读它，但旧文件还在。
- **设置页展示新字段**：`layout` / `botCaptureChars` / `quietMs` / `organizeEveryMs` 已进 `config.json` 白名单，
  但设置页表单还没加这几项（改配置要手改 `config.json` 或等界面）。
- **向量索引 / HNSW**：见 `ARCHITECTURE.md` 第 10 节，仍是预备方案。
- **旧数据导入**：如果以后想保留旧 `store.json` 的 82 条，需要一个一次性导入脚本（旧 → 六个文件）。

---

## 待决策

| # | 事项 | 选项 | 卡在哪 |
|---|---|---|---|
| ~~D1~~ | ~~L1 容量按谁的算~~ | 已定：全局阈值 + 按端注入配额 | — |
| D2 | 五档分档（重要/次重要/一般/琐事/无用） | 见下方“已知设计，未实施” | 暂缓，目前的 citation 模式能跑 |
| D3 | 是否删掉 `routeMode: 'importance'` 旧路径（memory5） | 删 / 留 | 只在 `layout=legacy` 时走到；确认不再回退后可删 |

### 已知设计，未实施：五档分档（2026-11-01 讨论稿）

```
L1 分流（判五档）
  重要      → 原文 DL2 + 摘要 DL3
  无用      → DL1
  其余三档  → 原话进 L2（观察）
        ↓ L2 满
L2 分流（再判一次）
  前三档    → DL3
  某一档    → 留在 L2
  无用      → DL1
```

**未定的三处**（讨论时没定下来）：

1. 档位顺序：`重要 > 次重要 > 一般 > 琐事 > 无用`，还是 `重要 > 一般 > 琐事 > 次重要 > 无用`
2. L2 分流时「留一档」留的是哪一档
3. 留在 L2 的那档会让 L2 长期满仓（每次写入都触发分流）→ 需要收口规则：
   「留一轮」还是「只留最近 N 条」

**另外**：五档必须和摘要**一次调用出**（`{摘要, 出处编号, 档位}`），分两次判会出现“判了重要但没摘要”的对不上。

---

## 已确认不用改（避免重复讨论）

| 以为要改的 | 实际状态 |
|---|---|
| 标签在分流时打 | **已经是默认**：`classifyMode: 'onOverflow'`，写入只跑本地规则 + `impRough`，L1 溢出时批量复核（`memory5.mjs:1367-1379`、`2307`） |
| L2 满取“整层” | 不是。取最旧一批到 `consolidateMaxChars/2`，再加 DL1 全部（`2231-2243`） |
| L1 只有第一档进 DL3 | 已经是，`≥0.9` 门禁（`2420-2426`） |

---

## 清理项（待点头）

| # | 内容 | 为什么 |
|---|---|---|
| C1 | 删掉 `memory5.mjs:78` “L2 是一次性整层取走” | 和 `2215` 的实现直接矛盾，2026-11-01 就是因为这行读错了逻辑 |
| C2 | 删 `routeMode: 'importance'` 旧路径 | 两套分流并存，容易串（见 D3） |
| C3 | L1 剥离 `heat/supersededBy` 等元数据 | 实践影响很小，优先级最低 |

---

## 发布状态

| 项 | 状态 |
|---|---|
| 本地仓库 | **0.8.0**（六文件布局，`layout: "split"` 默认） |
| npm | 0.5.1（未发新版） |
| 要用上新改动 | 本地 `link` 已经是最新（重启 dsh 生效）；发 npm 时记得 `files` 里带 `memory6.mjs` |
