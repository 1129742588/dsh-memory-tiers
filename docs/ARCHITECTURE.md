# 架构文档（ARCHITECTURE）

> 面向想理解/参与开发的读者。使用方法见根目录 `README.md`，验证方法见 `docs/VERIFY.md`。

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
                           │ toEngineCfg()
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
5. **沉**：L2 满 → L2 旧半 + DL1 全量二遍整理（★★/★/☆ 三档摘要）→ `DIGEST[l2]`
6. **忘**：DL1 保持率 < 阈值 → 台账先行删除 → `FORGET_ITEM`；DL3 琐事档摘要衰减淘汰 → `FORGET_SUMMARY`
7. **喂**：每轮请求注入 `<memory_context>`（L3 视图 + L2 原话 + L1 近况）

## 2. 模块职责

| 文件 | 职责 | 要点 |
|---|---|---|
| `index.mjs` | 插件入口与宿主接线 | 九步启动（step 逐项降级不炸）、turn 事件订阅、压缩、5 个 `memory_*` 工具、`/memory` 命令、4 个 web API、看门狗 |
| `memory.mjs` | 全部记忆引擎逻辑 | 六层存储、organize 流水线、两阶段分流、融合、遗忘、L3 视图、注入块构建 |
| `llm.mjs` | 模型四阶段的统一抽象 | summary（分流）/ chat（融合）/ embed / rerank；每阶段独立 source（session/api）；失败一律返回 null（降级不抛） |
| `settings.mjs` | 配置 schema 与读写 | 51 项 schema、coerce/校验、v1→v2 迁移、保存白名单（越界拒但其它照存） |
| `client.mjs` | 配置页前端（注入 dsh web） | 六层状态表、四阶段来源一览、逐字段「待重载」diff、工作模式组 |

**启动九步**：`config → model → memory → tools → capture → systemPrompt → inject:webServer → commands → timers`。
任一步失败只记 `BOOT_FAIL` 继续装其余——上一版一个异常炸掉整个插件的教训换来的设计。

## 3. 存储布局

```
<DSH_HOME>/memory-tiers/          ← 配置与运行态
  config.json      status.json    log.txt    context.txt
<DSH_HOME>/storages/memory/       ← 记忆库（目录可配）
  L1.json L2.json DL1.json DL2.json DL3.json   五个数据层（L3 是视图不落盘）
  vectors/…json     嵌入向量（融合预筛/语义检索）
  graveyard/forgotten.jsonl        遗忘台账（先台账后删）
  signals/applied.json             attend/pin/forget 信号队列
  organize.state.json              上次整理结果（状态页数据源）
  L1.tmp/<writer>.jsonl            写入缓冲（organize 时原子并入）
  *.lock                           文件锁（跨进程互斥）
```

要点：
- **L3 是视图不是层**：从 DL3 按热度截取生成，另有快照文件（内容没变就不重写，保 mtime 稳定以维持前缀缓存）。
- **原子写**：所有落盘走 temp + rename；崩溃最多重放一次 tmp 缓冲，不会丢数据。
- **跨进程安全**：organize 全程持锁，锁被接管会 `checkLock` 中止写入。

## 4. 两阶段分流协议

分流模型的输出是**单次调用**的临时标记，不随条目流转存储——L2/DL1 里存的永远是纯原文。

### 第一阶段（L1 溢出，`DIGEST[l1]`）

| 标记 | 含义 | 去向 |
|---|---|---|
| `★ 摘要《行号》` | 值得长期记住 | 摘要 → DL3（先融合四判），被引用原文 → DL2 |
| `+ 行号` | 有信息量但不够摘要 | 原话 → L2（`consolidatedAt` 排队尾） |
| 其余 | 流水账 | → DL1（等二级整理或遗忘） |

### 第二阶段（L2 满，`DIGEST[l2]`）

对「L2 旧半 + DL1 全量」重判，三档都写摘要：

| 标记 | importance | 去向 |
|---|---|---|
| `★★` | 0.9 | DL3（重要） |
| `★` | 0.6 | DL3（一般） |
| `☆` | 0.3 | DL3（琐事；1 天保护期后按 0.55 系数衰减淘汰） |
| `+ 行号` | — | 限量 `l2KeepMax` 回 L2 防抖 |

**解析器带阶段参数**：同一解析函数按 phase 决定 ★ 的 importance（first pass 恒 0.9，second pass 按子档），两条路径不得互相污染。

### 融合四判

新摘要进 DL3 前：embed → `fusionPrefilter`（默认 0.82）向量预筛 → 融合模型判关系：
`FUSE_DUP`（重复合并）/ `SUPERSEDE`（矛盾作废旧条）/ `FUSE_UPDATE`（进展并存）/ 新增。
判关系失败不猜——两条并存并留痕（`SUM_SUSPECT`）。

### 降级路径（绝不产生假数据）

| 场景 | 行为 |
|---|---|
| 无任何模型 | `DIGEST_NO_MODEL`：原文下沉 DL1，条目带 `pendingDigest`，等有模型再压 |
| 模型调用失败 | `DIGEST_FALLBACK`：整批退回 L2，下轮再压 |
| 模型输出无标记 | `DIGEST_EMPTY`：按没被引用处理 → DL1（安全路径） |
| 嵌入不可用 | 融合跳过（近似摘要并存，已知代价）；检索退化为关键词 |

## 5. 关键设计决策与取舍

以下每条都对应一次实测事故或作者明确拍板，改动前先理解为什么。

### 5.1 注入块必须「追加式」——前缀缓存的生命线

`<memory_context>` 拼在请求里，模型侧缓存按前缀匹配。实测教训（1.2.0）：

- L1 视图按 **createdAt 降序**排 → 每条新对话插队到段首 → 整块每轮失效 → **未命中恒定 5300 token**
- 修复：**升序**排列，新行只追加段尾 → 未命中降到 600
- 修复后仍回弹 1700：注入配额（行渲染口径，每行带时间戳前缀膨胀约 30%）低于分流水位 → 装箱截断 → 滑动窗口 → 前缀又断
- 终态：**自己端（origin === writer）全量注入不装箱**（大小由分流机制保证），只对「另一端」来源保留配额防爆；「选择从新、展示从旧」（配额不够牺牲最旧）

> 通用结论：任何会插入到序列中段的变化都是缓存杀手；一切变化必须是**尾部追加**。

### 5.2 L1 溢出：纯字数、整轮取半、选择从新

- 触发：`chars(L1) > hotChars`（1.2.0 起去掉安静期条件——一直在聊也不该让 L1 无限膨胀）
- 取法：按整轮（问答不拆开）从旧到新，取到剩余 ≤ `cap/2` 为止；`pickTurnBatch` 单轮特别大时允许整层取空（作者确认）
- L1 常态水位 1500~3000 字，注入层不做二次配额（见 5.1 的口径教训）

### 5.3 遗忘：先台账后删

任何删除（遗忘曲线 / DL1 容量清理 / DL3 琐事淘汰）都**先写 `graveyard/forgotten.jsonl` 台账**，写不进去就不删。DL3 只淘汰琐事档（☆，importance < 0.45），重要/一般摘要只靠融合合并或作废——它们理论上永久保留。

### 5.4 配置可信性

- schema 是唯一真相源；未知字段**保留但进 `ignored`**（升级不留暗坑）
- 保存：越界字段拒绝但**其它字段照存**；空数字框不落成 0（`userChars=0` 等于关掉「收」）
- 「配了不生效」是测试专门防的缺陷——每个 schema 项必须真的有人读

### 5.5 压缩（历史替代）与记忆的关系

- 压缩只在注入开启时执行（`inject-disabled` 保护）——不然模型既没历史也没记忆
- 压缩占位必须带 `data.id`（1.0.0 缺过，落盘重启后校验失败导致会话打不开——修复见 `tools/repair-sessions.mjs`）
- 写入失败时**不压缩**（`WRITE_TURN_FAIL` 短路）

### 5.6 工作模式

`workMode.enabled` 运行时短路注入与压缩（等效 `inject off` + `compaction off`），但 capture/organize 照常且使用专属的大容量抓取配置。与 `inject.enabled=false`（只写不读）语义不同：工作模式是「照写、不读、不替」。需重载插件生效，UI 明确提示。

### 5.7 性能稳定性

- organize 超时（`maxOrganizeMs`）由 heartbeat + `checkTimeout` 控制，卡死被接管
- 无变化不落盘：turn 后每轮都调 organize，无条件重写五文件会把「每轮尝试」变成「每轮全量重写」并打断前缀缓存——`changed` 判定后才写
- L3 快照 + `viewRefreshMs`：注入块稳定部分尽量复用字节

## 6. 与宿主的边界

- 插件只通过 cordis 注入的服务说话：`systemPrompt`（context() 挂记忆块）、工具注册、命令注册、web API 挂载
- 已知限制：注入块在请求中的位置由宿主决定，`deriveMessages()` **不包含**注入块——要「原样看请求」只能走 session 落盘数据或将来由宿主提供请求快照（`/memory context` 目前用正推方案，见 open-issues）
- 宿主版本差异通过 `boot.errors` 与 §5 的现象暴露，不要在插件里猜测宿主行为

## 7. 测试与验证

- `node --test test/*.test.mjs`：64 项单测（配置迁移/溢出取整轮/融合/遗忘台账/注入预算/命令输出等）
- `node tools/preflight.mjs`：34 项装机前检查（文件清单、独立 import、配置往返、引擎冒烟、接口探活）
- `docs/VERIFY.md`：七步端到端实机手册（含故障注入 §7）
- 改动后三者必须全绿；任何 FAIL 都要贴证据，不接受「看起来好了」
