# 记忆分层 · dsh 端

让 dsh 记住你说过的话，忘掉无关的，聊再久也不多花钱。

和 astrbot 端的 `astrbot_plugin_dsh_memory` 是同一套协议的两端实现：**分层、整理、路由、注入块的语义完全一致**，
只有接入方式不同（这边走 dsh 的 `systemPrompt` 和工具，那边走 astrbot 的钩子和命令）。
两端指向同一个数据目录，就是**一份共享记忆**。

- 只有 dsh：也能用，自己抓取、自己整理、自己注入。
- 想两端共用：看下面「共用一份记忆」。

架构细节看 [`ARCHITECTURE.md`](ARCHITECTURE.md)，改动记录看 [`CHANGELOG.md`](CHANGELOG.md)。

## 安装

1. 用 dsh 的插件安装方式把本仓库装进去（当前是 link 方式：目录链到 dsh 的插件目录）。
   加载器从**包根**读 `package.json` 与 `cordis.patch.yml`，所以根目录那几个文件必须在。
   根目录那份是 `core/` 的副本，别手改。
2. 重启 dsh，看日志里有没有 `[memory-tiers] 已加载，注册 N 个工具`。
3. 打开「设置 → 记忆分层」，按需改配置，保存后重启生效。

数据目录默认 `~/.dsh/storages/memory-v5`（可用 `DSH_HOME` 改前缀）。

## 设置页

分组和默认值跟 astrbot 配置页一一对应。时间类配置一律是**分钟**（旧版的 `quietMs` /
`organizeEveryMs` / `refreshMinMs` / `semanticTtlMs` 会在读取时自动换算，不用手动改）。

### 基础（数据目录与写者）

| 项 | 默认 | 说明 |
|---|---|---|
| 数据目录 `dir` | `~/.dsh/storages/memory-v5` | 存在固定位置的指针文件 `~/.dsh/memory-tiers.json` 里 |
| 写者标识 `writer` | `default` | 决定 `L1.tmp/<writer>.jsonl`。共用目录时**每个程序必须不同** |

### 注入（每轮拼进上下文的量）

| 项 | 默认 | 说明 |
|---|---|---|
| 注入总量上限 `bootMaxChars` | 0 | 0 = 不限，由下面三层容量决定 |
| 注入记忆 `inject` | 开 | 关掉 = 只写不读 |
| L1 即时层 `memoryCfg.hotMaxChars` | 3000 | 按时间保存的原文 |
| 自己那一端的配额 `memoryCfg.hotQuotaOwn` | 0.7 | L1 里先紧着自己写的占七成 |
| L2 巩固层 `memoryCfg.consolidateMaxChars` | 2500 | 较重要的原话 |
| L3 长期层 `memoryCfg.longMaxChars` | 3000 | 摘要视图，直接决定注入块大小 |
| L3 视图刷新间隔 `refreshMin` | 30 分钟 | 只有 L3 节流：它一变后面缓存全断 |
| 相关旧事有效期 `semanticTtlMin` | 3 分钟 | 超时重新检索，避免带入隔夜话题 |

### 抓取

| 项 | 默认 | 说明 |
|---|---|---|
| 单条用户消息上限 `userCaptureChars` | 2000 | |
| 工具输出上限 `toolCaptureChars` | 500 | bash 一次能吐几万字，L1 才 3000 字 |
| 回复截断 `botCaptureChars` | 400 | 一轮回复拼起来再截 |

### 整理（模型与摘要）

| 项 | 默认 | 说明 |
|---|---|---|
| 安静多久才整理 `quietMin` | 10 分钟 | 避免聊到一半被摘要腰斩 |
| 整理间隔 `organizeEveryMin` | 5 分钟 | 定时补漏 |
| 遗忘阈值 `memoryCfg.forgetThreshold` | 0.25 | DL1 保持率低于此值就忘，忘前写台账 |
| 每轮最多沉淀几条 `memoryCfg.l2KeepMax` | 10 | 其余落流水账 |
| 摘要分片 `memoryCfg.summaryChunk` | 60 条 | |
| 摘要时关思考 `noThink.summary` | 关 | 摘要要想清楚再压 |
| 各阶段模型 `models.*` | 跟会话 / 硅基流动 | 嵌入、重排、融合、摘要可分别指定 |

### 向量 / 语义检索

| 项 | 默认 | 说明 |
|---|---|---|
| API Key `apiKey` | 空 | 空 = 没有语义检索，只走关键词（融合摘要不受影响） |
| API 地址 `apiBase` | `https://api.siliconflow.cn/v1` | |
| 嵌入模型 | `BAAI/bge-m3` | 必须和 astrbot 端一致，否则向量签名对不上（只读不写） |
| 重排模型 | `BAAI/bge-reranker-v2-m3` | 检索精排 |
| 相关旧事 `semanticInject` | 关 | 每轮多一次 embedding 调用 |
| 检索条数 `semanticTopK` | 5 | |
| 相似度下限 `semanticMinSim` | 0.35 | |

### 自身历史压缩

| 项 | 默认 | 说明 |
|---|---|---|
| 每轮压缩 dsh 历史 `autoCompact` | 开 | 压成一条占位（零 LLM），压掉的内容先归档进记忆 |
| 压缩后保留几轮 `compactKeepTurns` | 0 | 0 = 一条不留，全交给记忆 |
| 每轮归档字数 `compactArchiveChars` | 1200 | |

## 工具（模型自己调用）

dsh 这端没有聊天命令，记忆是给模型用的工具：

| 工具 | 作用 |
|---|---|
| `memory_write` | 手动记一条 |
| `memory_search` | 跨五层检索（结果带 id） |
| `memory_attend` | 关注：热度 +1，DL1 的会回 L2 |
| `memory_forget` | 忘掉：写台账后从库和向量里删 |
| `memory_stats` | 各层条数 / 字数 / 向量库 / 整理情况 |

想「看一眼当前注入了什么」，看 `<数据目录>/status.json` 和注入块本身；
astrbot 那边的 `/memory ctx` 提供同样的视角。

## 共用一份记忆

1. dsh 的数据目录就是共享目录（默认 `~/.dsh/storages/memory-v5`），把它填进 astrbot 的「数据目录」。
2. 两端 `writer` 必须不同（`dsh` / `astrbot`）。
3. 两端进程要能看见同一个路径；docker 要把宿主目录挂进容器。
4. 嵌入模型必须一致，签名对不上时本端只读不写。

## 常见问题

**装完没反应？**
看日志有没有 `[memory-tiers] 已加载`。没有 = 包没被加载（检查包根的 `package.json` 和
`cordis.patch.yml` 是否在）；有但注入块是空的 = 记忆库还没内容。

**注入块一直是空的？**
`inject=false`？`bootMaxChars` 设成了很小的值？`<数据目录>/status.json` 里的
`promptInjected` / `inject` 字段能直接回答。

**改了配置没生效？**
设置页保存后要重启 dsh（配置是 apply 时读的）。

**旧配置会不会坏？**
不会。旧的毫秒键读取时自动换算成分钟，只在内存里换算，不会改写你的 config.json。

**两份代码怎么改？**
`core/` 是真源，根目录是副本。改完跑 `node sync_core.mjs`；`node sync_core.mjs --check` 只比对。

## 目录

```
dsh/
├── core/                源码真源：memory / silicon / index / settings / client / compaction / dshllm
├── *.mjs 等             core/ 的副本（加载器从包根读 package.json 与 cordis.patch.yml）
├── sync_core.mjs        core → 根目录 同步
├── ARCHITECTURE.md      架构（前半段与 astrbot 逐字一致，后半段是本端适配）
├── CHANGELOG.md         改动笔记
└── test/                测试（node test/test_xxx.mjs 直接跑）
```
