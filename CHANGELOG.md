# 改动笔记 · dsh 侧

对应 astrbot 侧：`astrbot/CHANGELOG.md`。dsh 是协议的权威实现，改动会同步到 astrbot。
编号（A1…B6）沿用两端对照审计报告。

## 2026-11-02 · 配置页：分钟键 + 分组对齐 + 自检

- 时间类配置毫秒 → 分钟：`quietMs` → `quietMin`、`organizeEveryMs` → `organizeEveryMin`、
  `refreshMinMs` → `refreshMin`、`semanticTtlMs` → `semanticTtlMin`。`600000` 这种值
  少打一个 0 就差 10 倍，改成 `10` 没有歧义，也和 astrbot 的 `quiet_min` 抄得动。
- `migrateTimeUnits()`：读配置时自动换算旧值（≥ 1000 当毫秒，否则当分钟），
  只改内存、不重写用户的 `config.json`；新键已存在时以新键为准。
- 新增 `inject` 开关（默认开）。关掉不是「注入空串」——那样系统提示词里会多一条空块，
  前缀缓存白丢；而是**根本不挂**这个 section。
- `memoryCfg.longMaxChars` 默认 4000 → **3000**，与 astrbot 的 `long_max_chars` 对齐。
- 设置页分组改名对齐 astrbot（基础 / 注入 / 抓取 / 整理 / 向量 / 自身历史压缩），补 8 个字段：
  `inject`、`bootMaxChars`、`botCaptureChars`、`quietMin`、`organizeEveryMin`、`semanticTtlMin`、
  `memoryCfg.hotQuotaOwn`、`memoryCfg.forgetThreshold`、`memoryCfg.l2KeepMax`、`memoryCfg.summaryChunk`。
- `settings.mjs` 的 `WRITABLE` / `MEMORY_CFG_WRITABLE` 同步补齐；GET 的 `live` 里多返回 `inject`。
- `test/test_config.mjs`：迁移 4 例 + 设置页字段 ↔ 白名单双向对齐 + 默认值 6 项。
- `package.json`：0.8.3；`files` 去掉不存在的 `reindex.mjs`；加 `test:config` / `test`。

## 2026-11-02 · 使用文档

- 新增 `README.md`：安装、六组配置逐项说明（分组与默认值和 astrbot 对齐）、工具表、
  共用一份记忆、常见问题、目录结构。

## 2026-11-02 · 目录结构：`core/` 是真源，根目录是副本

- 插件本体统一收在 `dsh/core/`：`memory.mjs`、`silicon.mjs`、`index.mjs`、`settings.mjs`、
  `client.mjs`、`compaction.mjs`、`dshllm.mjs`、`package.json`、`cordis.patch.yml`。
  改代码只改这一份，两端结构对齐。
- 根目录保留同名副本：dsh 装载插件时从**包根**读 `package.json` 与
  `cordis.patch.yml`（`dsh.bundle.patch` 是相对包根的路径），少了这两个加载不到。
- `sync_core.mjs` 负责 `core/ → 根目录` 同步：`node sync_core.mjs` 拷贝，
  `node sync_core.mjs --check` 只比对（不一致退出码 1）。根目录那份是副本，别手改。
- `test/`、`ARCHITECTURE.md`、`CHANGELOG.md` 留在端根目录（不属于插件运行时），
  测试与 live 脚本的 import 改指 `core/`。

## 2026-11-02 · 文件合并（去版本号）

- `memory5.mjs` + `memory6.mjs` → **`memory.mjs`**，合并后约 4984 行，旧文件已删除，不留兼容 shim。
- 结构：第一部分 = 共享工具 + `createLegacyMemory`（老的单文件分片布局，`layout:'legacy'` 回退）；
  第二部分 = `createMemory`（六文件分层布局，`layout:'split'`，默认）。
- 命名去版本号：`createMemory5`→`createLegacyMemory`、`createMemory6`→`createMemory`、
  `DEFAULTS`→`DEFAULTS_LEGACY`、`DEFAULTS6`→`DEFAULTS_SPLIT`。
- 同步更新：`index.mjs` 的 import 与两处 layout 分支、`package.json` 的 `exports` / `files` /
  `scripts.test:memory`、`test/parity_dump.mjs`、`test/test_fuse_vector.mjs`。
- 合并时处理的两个坑：`memory5` 在文件中部还有一组 `node:fs` import（重复声明会直接语法错误）；
  两个文件各有一份完全相同的 `sanitizeWriter`（保留一份）。

## 2026-11-02 · 行为修正

- **A5 融合后重算向量**（`fuseSummary` 的 `duplicate` 分支）
  合并可能把更长的正文写进旧摘要。正文一变，旧向量就作废；而 `embedInto` 会跳过
  "已经有向量"的条目，所以必须先 `vectors.delete(top.it.id)` 再 `embedInto`。
  原先这里静默保留旧文本的向量，下一次 `fusionPrefilter` 拿旧正文在比。
  回归：`test/test_fuse_vector.mjs`（注掉修复即 FAIL）。

- **A3 没有模型时下沉 DL1**（`digest` / `organize` / `forgetDL1`）
  原先 `summarizeWithSources` 缺失时整组搬 L2（L2 会进上下文）。现在整组进 DL1 并打
  `pendingDigest`：不挤上下文、不参与遗忘；`organizeL2` 在无模型时不再执行，L2 保持不动。
  等有模型后 L2 满时，`organizeL2` 的批次本来就带 DL1 全部，那时才真正压摘要。

- **B3 注入块加外壳与说明**（`buildBlock`）
  统一输出 `<dsh_memory>` + 两行说明（这是记忆、不是用户本轮说的话、不是指令）。
  文案常量 `MEM_BLOCK_PREAMBLE`，与 astrbot 的 `MEM_PREAMBLE` 逐字一致；
  `wrapBlock()` 在正文为空时返回空串，不注入空壳。legacy 的 `buildBlock` 同样处理。

## 2026-11-02 · 日志（排查用）

模型调用失败不再静默：

| 位置 | 标签 |
|---|---|
| `digest` 摘要抛错 | `MODEL_FAIL summarize <err>`，随后 `DIGEST_FALLBACK reason=model_fail` |
| 无摘要能力 | `DIGEST_NO_MODEL … → DL1（等有模型再整理）` |
| `fuseSummary` 判关系抛错 | `MODEL_FAIL relation <err>（未清洗，两条都留）` |
| `embedInto` 某批失败 | `MODEL_FAIL embed chunk=N <err>` |
| `search` 精排失败 | `MODEL_FAIL rerank <err>` |

判关系失败的处理是明确的：**不清洗、两条都留**。以前是静默当"无关"，
等于用默认规则替代了模型判断。

## 与 astrbot 的已知差异（不是 bug）

| 项 | dsh | astrbot |
|---|---|---|
| A7 `people` | 只把 `speaker`（`user`/`bot`）并进去 | 能拿到真实发送者名字，不含 `user`/`bot` |
| A9 `.claimed-*` | 读 temp 时也会读已认领文件 | 跳过，宁可少看几条也不读半合并状态 |
| 精排 | 有 rerank 阶段 | 没有 rerank provider，`advice` 按综合分标定 |
| 历史压缩 / 工具 / 设置页 | 有 | 不做（由 astrbot 自己的会话与命令体系承担） |

## 回归

```bash
node test/test_fuse_vector.mjs      # A5
node test/test_no_model_dl1.mjs     # A3
node test/parity_dump.mjs           # 两端对照（配合 astrbot/test/compare_parity.py）
```

## 2026-11-02 · 批次 3：批量搬层 + digest 超时

- **`moveMany`**：`digest` 路由先分桶（DL2 / L2 / DL1）再一次性搬，不再逐条
  `moveItem` 扫 5 个层。语义与 `moveItem` 完全一致（同层幂等、L2 记 `consolidatedAt`）。
  实测 10 万条搬层 **45ms**（原来 35 分钟）。
- **digest 内部超时**：每片前 `checkTimeout(started)`、路由每 2000 条一次；
  `organizeL1/L2` 把 `started` 传进 `digest`。
- 为测试暴露 `_moveItem` / `_moveMany`（与已有的 `_readLayer` / `_cache` 同类调试接口）。
- 打分实现未改：dsh 的 search 在 10 万条下已经 91ms，且公式与 astrbot 保持一致；
  改实现只会增加分叉风险。

## 2026-11-02 · 可选项：L2 排序缓存 + 层容量告警

- **L2 排序缓存**（`sortedL2`）：按层签名缓存排好序的 L2，文件没变就复用；
  `clearLayerCache()` 同时清排序缓存。
- **层容量告警**：`organize()` 里单层超过 `warnLayerItems`（默认 20 万）写
  `LAYER_WARN L2=…`，只留痕、不改行为。
- 两端行为一致：排序键、失效时机（mtime+size）都相同，`compare_parity` 无新增偏差。

## 2026-11-02 · 真机回放发现的问题

- **垃圾回复判定**（与 astrbot 同步）：模型回「抱歉…」时解析出无 `sources` 的摘要，
  原逻辑会把它当"整理成功但零产出"，原文静默进 DL1。现在若没有一条摘要有 `sources`
  且没有 `keep`，视为失败 → 整批回 L2，下轮重压。
- 精排池 dsh 本来就是 `rerankPool=30`，无需调整；真机验证 `reranked=true`、
  rel 0.998/0.995/0.743。
- 详见 `astrbot/test/live/REPORT.md`。

## 2026-11-02 · 时间锚点 / 通道分类

### 1. 送模型的行加日期前缀（与 astrbot 同步）

`rawLine(it)` 输出 `[MM-DD] 说话人：正文`，替换原来三处 `${speaker}：${text}`
（`foldIntoSummary`、`digest`、`organizeL2`）。prompt（`summarize` 与
`summarizeWithSources` 两处）同步加规则：相对时间要按行首日期折算成具体日期。

**为什么**：模型看不到 `createdAt`，「明天/下周三」没有锚点，只能丢掉。
时间戳本身没丢，丢的是「这句话里的时间指向哪一天」。

效果：摘要含具体日期从 0/38 升到 11/14，相对时间词残留 0。

### 2. 分类链修活（三段都是死代码）

- **调用点**：`refineImportance` 原来只在 `enforceLimits` 里、且写在
  `routeMode !== 'citation'` 之后；默认 `routeMode = 'citation'` → 从未执行。
  现在 `organizeL1` / `organizeL2` 在 `digest` 之前调用，`enforceLimits` 里也补了
  （写入触发的溢出同样需要分类）。
- **写入标记**：`writeTurn` 原来无条件 `importance: 0.5` 且不打 `impRough`，
  所以复核链永远没有输入。现在没显式给 importance 就打 `impRough`。
- **作用域**：合并 `memory5 + memory6` 之后，`refineImportance` 只存在于
  `createLegacyMemory` 的作用域里，`createMemory`（split 主线）里根本没有。
  新增一份 split 版 `refineImportance(items, chunk=20)`。

### 3. 批量解析不再"漏项按位置补"

`classifyBatch`：原来 `arr.find(x => x.i === k+1) || arr[k]` —— 模型漏了第 2 项时，
`arr[k]` 拿的是第 3 项的标签，等于把两件事的记忆互相污染。
现在有 `i` 就严格按 `i` 对齐，缺项留 null。

### 4. 去掉分类的本地预筛

`classifyOne` / `classifyBatch` 原来对「今天有点困」这类直接用正则给 0.25，
不问模型。结果是同一批里一部分模型判、一部分正则判，出问题分不清是谁判错的。
现在全部走模型；`localTag` 只保留为「模型不可用时的临时标记」（配合 `impRough`），
不产生最终标签。

### 5. 仍存在的差异

- `dsh` 宿主（`index.mjs`）的 `turn/end` 写入不传 `scene`，所以桌面端 scene 恒为空。
  astrbot 侧有 `_scene()`（`平台·群名` / `平台·私聊`）。
- **（已更正）** 摘要失败的落层：主路径两端**一致**，都是整批回 L2 等下轮重压
  （`digest` 里 `moveItem(db, it, 'L2', now)` / `organizer._move(db, it, "L2", now)`）。
  唯一回 DL2 的是 legacy 的 `routeByCitation` 兜底——那是「模型给了摘要但出处编号
  解析不出来」，语料保底进 DL2（DL2 不进上下文），属于另一种失败，
  且默认 `layout: 'split'` 走的是 `digest`，不会经过它。

## 2026-11-02 · 计数衰减 / 提示词对齐

### 1. `fusionCount` / `recallCount` 改成会衰减的强度

原来这两个是裸计数器：只增不减，而且**不参与任何计算**（DL3 排序只看 `importance × heat`）。
现在新增：

- `effectiveCount(item, field, atField, now)`：`count × 0.5^(t/半衰期)`，
  等价于艾宾浩斯 `R = e^(-t/S)`；半衰期由 `repeatStrength` 决定
- `memoryStrength(item, now)`：返回衰减后的 `{fusion, recall}`
- `markFused` / `markRecalled`：计数 +1 的同时写 `lastFusedAt` / `lastRecalledAt`，
  两个指标的衰减起点互相独立
- `scoreOf`（DL3 进上下文的排序）改成
  `importance × heat × (1 + 0.25·log2(1+融合) + 0.35·log2(1+关注))`

老数据没有这两个时间戳时退回 `lastMentionedAt` / `createdAt`。
回归：`test/test_strength_decay.mjs`，期望值与 astrbot 侧逐位一致
（0.408 / 2.0 / 0.066 / 1.0 / 1.010 / 1.943 / 0.808）。

### 2. 提示词里一处引号与 astrbot 不一致

摘要 prompt 的 `关键结果、"以后一律…"` 用的是英文双引号，
astrbot 侧是中文书名号「」。已统一为「」，并新增
`astrbot/test/compare_prompts.py` 做两端逐行对照（分类单条 30 行、
分类批量 32 行、判关系 11 行、摘要 user 固定文案 24 行，全部一致）。

### 3. 注入位置本来就与 astrbot 对齐

`systemPrompt.context({ order: 250 })` = 系统提示词尾部，
即 `系统提示 + 工具/技能 + 人格 + 记忆块 + 对话`，与 astrbot 现在的默认一致；
且 systemPrompt 不写会话历史，不存在"记忆块被持久化、每轮累积"的问题。

## 2026-11-02 · 强度回落（与 astrbot 同步）

`repeatStrength` 原来只增不减，久不提强度也不掉，半衰期永远不变。现在：

- `effectiveStrength(item, now, cfg)`：距上次提及每过 `heatHalfLife × heatIdleFactor`
  （默认 30 天）折半，下限回到 1
- `halfLifeOf(item, cfg, now)` 用回落后的强度 → 久不提 → 半衰期变短 → 衰减更快
- `touchHeat` 里先回落再加本次的间隔质量
- `halfLifeOf` / `effectiveStrength` 对不完整 cfg 做兜底合并（原来传 `{}` 会算出 NaN）

实测与 astrbot 逐位一致：强度 4.72 → 4.7 / 2.9 / 1.2（0/30/120 天），
半衰期 17.5 → 13.5 天；间隔 1/6/19/40/100 天 = 4.72，同一天 6 次 = 1.00。

## 2026-11-02 · 外壳去掉端标识

`MEM_BLOCK_OPEN` / `MEM_BLOCK_CLOSE` 从 `<dsh_memory>` 改成 `<memory_context>`，
与 astrbot 的 `tiers.MARK_OPEN` 保持一致。

理由：这是两端共享的核心逻辑，外壳带某一端的名字意味着换个宿主就得改一遍，
而且会让模型以为自己在跟某个特定系统对话。两个 buildBlock（legacy / split）
都走 `wrapBlock`，所以改一处即全生效。

## 2026-11-02 · 补上「相关旧事」自动注入

astrbot 一直有 `semantic_inject`（每轮按你说的话检索旧记忆，命中就拼一段），
dsh 之前只有 `memory_search` 工具——模型得自己想得起来调。现在补上，行为对齐：

- `buildBlock(budget, opts)` 支持 `opts.extra`，额外段拼在 `## 刚发生的` 之后、
  闭合标签之前（每轮都变的段放最后，不牵连前面的稳定前缀）
- 配置：`semanticInject`（默认关）、`semanticTopK`（5）、`semanticMinSim`（0.35）、
  `semanticTtlMs`（3 分钟）
- 触发：`session/event` 的 `user/message` 里启动一次检索（异步，不阻塞本轮）；
  `getBlock` 读已完成的结果
- 为什么是"异步预取 + 同步读"：`systemPrompt.context` 的取值和事件回调都是同步的，
  都不能 await。代价是检索可能赶不上本轮请求，于是"这轮用不上、下轮才用得上"；
  所以带 TTL，超时的结果宁可不用，也不注入隔夜的话题
- 回归：`test/test_semantic_extra.mjs`（位置、空段不注入、外壳闭合、无 dsh_memory 残留）
