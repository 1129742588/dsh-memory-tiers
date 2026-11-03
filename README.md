# dsh-memory-tiers

> 给 DeepSeek Harness（dsh）装一个**真正记得住事**的本地记忆系统——聊得越久越懂你，而且不花冤枉钱。

## 为什么需要它

dsh 自带的历史上下文有两个死穴：**窗口一满就把最早的对话扔掉**，而且**每一轮都把全部历史重发一遍**，token 账单随聊天长度直线上升。

dsh-memory-tiers 用六层记忆把这两个问题一起解决：

- **该记的沉淀下来**：对话轮次先落进 L1 即时层，满了之后由分流模型挑拣——值得长期记住的写成摘要沉入 DL3 摘要库，有信息量但不到摘要程度的原话进 L2 巩固层缓冲，没价值的落 DL1 按遗忘曲线衰减。L2 攒满后再做一次二级整理，把一般重要的内容升级成三档摘要（★★ 重要 / ★ 一般 / ☆ 琐事）。
- **该忘的自然忘**：DL1 里的流水账按保持率衰减，低于阈值才删除，且**先写台账后删数据**——没有静默丢失。
- **注入又稳又省**：每轮只注入一块结构化记忆（`<memory_context>`：一直记得的 + 最近沉淀的 + 按时间排序的历史对话），并做了**前缀缓存友好**设计——实测配合模型侧缓存，未命中只有 500~800 token 且不随轮数增长，历史替换成占位符后长对话的成本几乎不再上涨。
- **坏了不会静默坏**：没有模型就绝不产生假摘要；删除前必有台账；配置损坏自动重建；每一步都有日志事件可查。

一句话：**记忆替代历史**——模型看到的不再是几十屏流水账，而是一份持续更新的记忆档案，细节需要时再用工具检索。

## 安装

三种方式任选（需要 dsh 支持 `dsh.bundle` 插件协议）：

```bash
# 方式一：npm（推荐，可自动更新下载量展示）
# 在 dsh 插件管理器中安装 npm 包 dsh-memory-tiers

# 方式二：GitHub
# 从 https://github.com/1129742588/dsh-memory-tiers 的 tag v1.2.1 安装

# 方式三：dsh 市场搜索 dsh-memory-tiers
```

装完后**重载一次插件**（开关一次插件即可，无需重启 dsh），`设置 → 记忆` 里出现配置页就是装好了。

## 日常使用

### 命令（聊天里直接用）

| 命令 | 作用 |
|---|---|
| `/memory context [all]` | 把**发给模型的完整上下文**（系统提示全文 + 记忆块 + 全部消息）写成文本文件，方便核对与调试；`all` 直接在聊天里刷出 |
| `/memory list` | 分层列出当前记忆库（id / 时间 / 通道 / 重要度 / 正文） |

### 模型工具（模型自主调用）

模型侧会拿到 5 个 `memory_*` 工具：`memory_search`（按深度检索：DL3 摘要 → DL2 原文 → DL1 流水账）、`memory_write`（主动写入记忆）、`memory_attend`（标记重点关注）、`memory_forget`（删除某条）、`memory_stats`（库状态）。注入块里的「使用规则」会教模型：**不打扰用户、上下文有就不检索、按 DL3 → DL2 → DL1 的顺序查、都没有才说不知道**。

### 配置页

`设置 → 记忆`：顶部是四阶段模型的实际来源一览与六层实时状态，中间是全部配置项（改了未生效的会标「待重载」），底部一键「立即整理」和「看日志」。

### 工作模式（专注干活时开）

配置页打开 `工作模式`：会话表现**完全正常**（不注入记忆块、不压缩历史），但记忆照常记录——而且抓取更完整（专属的更大截断字数与层容量）。适合正式干活不想被打扰的场合；关掉重载插件即恢复。

## 配置指南

配置文件在 `<DSH_HOME>/memory-tiers/config.json`，但**推荐用配置页改**（有校验、有回显）。全部 51 项如下，按组说明。

### 存储

| 项 | 默认 | 说明 |
|---|---|---|
| `storage.dir` | `~/.dsh/storages/memory` | 记忆库目录。改完重载插件，旧目录内容不会自动搬 |
| `writer` | `dsh` | 写者标识，多会话共库时区分来源 |

### 抓取（第 1 步「收」）

| 项 | 默认 | 说明 |
|---|---|---|
| `capture.enabled` | `true` | 关掉就完全不记录 |
| `capture.userChars` | `2000` | 单条用户消息最多记多少字，超出截断 |
| `capture.botChars` | `400` | 一轮回复最多记多少字（回复通常不用全记） |
| `capture.toolChars` | `500` | 单条工具输出最多记多少字 |
| `capture.semantic.*` | 关 | 每轮结束后检索相关旧事附进上下文（需要嵌入模型） |

### 注入（第 6 步「喂」）

| 项 | 默认 | 说明 |
|---|---|---|
| `inject.enabled` | `true` | 关掉 = 只写不读（模型看不到记忆块）；同时压缩会拒绝执行，防止失忆 |
| `inject.maxChars` | `0`（不限） | 记忆块总字数上限，0 = 不限 |

### 六层容量（决定分流的闸门）

| 项 | 默认 | 说明 |
|---|---|---|
| `layers.hotChars` | `3000` | L1 容量：超过就触发分流（纯字数条件，无需安静期） |
| `layers.consolidateChars` | `2500` | L2 容量：超过触发二级整理（L2 旧半 + DL1 全量重压） |
| `layers.longChars` | `3000` | L3 视图容量：注入块「一直记得的」段最多多少字 |
| `layers.l2KeepMax` | `10` | 二级整理时最多留几条原话在 L2 |
| `layers.forgetThreshold` | `0.25` | DL1 保持率低于它才删除（越小忘得越慢） |
| `layers.dl1MaxChars` | `20000` | DL1 硬上限：超过按「越旧越先清」清到 80% |

### 整理节奏

| 项 | 默认 | 说明 |
|---|---|---|
| `organize.everyMin` | `5` | 定时整理间隔（分钟） |
| `organize.refreshMin` | `30` | L3 视图快照刷新间隔（影响注入块前缀缓存） |
| `organize.fusionPrefilter` | `0.82` | 融合预筛的向量相似度阈值：调低更容易发现矛盾/重复（多花模型调用） |

### 模型（四个阶段独立配置）

| 项 | 默认 | 说明 |
|---|---|---|
| `model.stages.summary.*` | `session` | **分流模型**：L1/L2 的挑选 + 摘要 + 保留判断，记忆系统的大脑 |
| `model.stages.chat.*` | `session` | **融合模型**：分类打分 + 摘要融合判关系（重复/矛盾/进展/新增） |
| `model.stages.embed.*` | `BAAI/bge-m3`（硅基流动） | 嵌入模型：语义检索与融合预筛依赖它 |
| `model.stages.rerank.*` | `BAAI/bge-reranker-v2-m3` | 精排模型：检索结果重排序 |
| `model.preset` | `siliconflow` | 选 `siliconflow` 时一键带出嵌入/精排的地址与模型 |
| `model.apiKey` / `.apiBase` | 空 | 上述 stage 的默认 API 凭据（各 stage 可单独覆盖） |
| `model.noThink.*` | `true` | 调用分流/融合模型时关闭思考模式（省时省钱） |
| `model.summaryChunk` | `60` | 分流一次送多少条（大批量时分块） |
| `model.timeoutMs` | `20000` | 单次请求超时 |

> **source 两种取值**：`session` = 蹭当前会话的模型（零配置）；`api` = 走你填的 API（推荐给分流/融合配一个便宜稳定的，和会话模型互不抢额度）。

### 工作模式（专属覆盖）

| 项 | 默认 | 说明 |
|---|---|---|
| `workMode.enabled` | `false` | 开启后：不注入、不压缩，但照常记录与整理 |
| `workMode.userChars` / `botChars` / `toolChars` | `4000` / `800` / `1200` | 工作模式下的抓取截断（比日常大，记得全） |
| `workMode.hotChars` / `consolidateChars` | `6000` / `5000` | 工作模式下的 L1/L2 容量（比日常大，攒得多） |

### 历史替代（第 7 步「替」）

| 项 | 默认 | 说明 |
|---|---|---|
| `compaction.enabled` | `true` | 每轮结束把对话历史替换成一条占位（记忆已接管） |
| `compaction.keepTurns` | `0` | 保留最近几轮原文不替换 |
| `compaction.archiveChars` | `1200` | 每轮归档字数上限 |

## 排错速查

| 现象 | 看哪里 |
|---|---|
| 工具没出现 / 记忆没注入 | `status.json` 的 `boot.errors`；`log.txt` 的 `BOOT_*` |
| 分流没发生 | `log.txt` 搜 `DIGEST`；`DIGEST_NO_MODEL` = 没模型，`DIGEST_FALLBACK` = 模型调用失败 |
| 会话打不开（`lacks an identified message`） | 旧版占位缺 id，跑 `node tools/repair-sessions.mjs --apply`（见 `docs/SESSION-REPAIR.md`） |
| 日志中文乱码 | PowerShell 加 `-Encoding UTF8` |
| 改了配置没生效 | 重载插件（开关一次）；配置页对应字段会标「待重载」 |

更多验证步骤见 `docs/VERIFY.md`（完整实机验证手册）。

## 文档导航

| 文档 | 读者 |
|---|---|
| `docs/ARCHITECTURE.md` | 想理解内部实现的开发者：六层模型、两阶段分流协议、设计取舍 |
| `docs/VERIFY.md` | 测试者：七步端到端验证 + 故障注入手册 |
| `docs/CONFIG-PAGE.md` | 配置页的实现与核对表 |
| `docs/SESSION-REPAIR.md` | 会话修复工具的说明 |

## 许可

MIT
