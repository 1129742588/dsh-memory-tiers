# 配置页字段核对表（1.3.0）

> 用途：验收「页面上显示的 = 插件实际在用的」。
> 问题 3/4 的根因就是这里混用「文件值 / 运行值」——本表把每一项的来源写清楚。
> 页面：设置 → 记忆（`/dsh-memory/api/config` + `/state`）。

## 页面结构（从上到下）

1. **六层说明 + 当前历史策略**（运行值；有待重载项时带「重载插件后生效」）；
2. **模型与阶段（实际生效）**：分流 / 融合 / 嵌入 / 精排 四行，各带 `会话|API` 标签与生效模型名；
   下面一行单独显示**当前会话模型**（避免把会话模型误当成某一阶段的模型）；
3. **现在怎么样（只读）**：待整理 / 向量 / 整理锁 / 语义检索 / 嵌入模型 / 注入记忆 / 替代历史 + 六层表；
4. **待重载**横幅（有才显示）+ 每个被改字段旁的「待重载」小标签；热改项保存后直接变运行值；
5. **已废弃/未知键**提示（如旧配置里的 `organize.quietMin`）；
6. **会话模式与接管豁免**表：会话短 id / 轮次 / 状态 / 最后活跃 / 解除豁免（二次确认）；
7. **配置字段**：分组顺序固定为 模型 → 人格 → 工作模式 → 存储 → 抓取 → 注入 → 六层容量 → 整理节奏 → 历史替代。

## 显示项 × 来源 × 含义

| 显示项 | 数据来源 | 含义 / 注意 |
|---|---|---|
| 分流（source/model） | `run.stages.summary`（`llm.resolveStage`） | 实际用于「挑选 + 摘要 + 保留」的模型；`source=session` 时显示会话模型名 |
| 融合（source/model） | `run.stages.chat` | 实际用于分类 + 判重复/矛盾/进展的模型 |
| 嵌入（source/model） | `run.stages.embed` | 向量检索用的模型（`preset=siliconflow` 时固定 BAAI/bge-m3） |
| 精排（source/model） | `run.stages.rerank` | 重排模型 |
| 不可用标签 | `stage.ready` | 会话通道不可用 / API 缺 key / 未配模型 |
| 当前会话模型 | `run.session.model`（会话通道） | **只是**「跟随当前对话模型」时的来源；不代表分流/融合一定用它 |
| 待整理条数 | `stats.pending` = 临时区条数 + 信号队列**条数** | 不是文件数 |
| 向量条数 | `stats.vectors` | 内存里已加载的向量 |
| 整理锁 | `stats.lock` | 正在整理时显示「整理中」 |
| 语义检索 | `caps.embed` | 嵌入真的能发出去（不是「配了 key」） |
| 嵌入模型 | `caps.embedModel` | 解析后的模型名 |
| 注入记忆 | `run.injection.mode/reason` | 每轮 / 关 / 关（工作模式）/ 关（会话已豁免）/ 没挂上 |
| 人格 | `run.persona` | 开关、字数、是否进分流；空人格不显示为空段 |
| 替代历史 | `run.config.compaction` | 运行中的压缩开关与保留轮数 |
| 会话状态 | `run.sessions` + `/api/sessions` | 工作/豁免/普通计数；逐个会话的模式与轮次 |
| 星图入口 | `run.star.url` | 插件内 `/dsh-memory/star`，不另起端口 |
| 六层条数/字数 | `stats.count/chars` | 实时读盘 |
| 配置路径 / 记忆库 | `paths` | 文件位置 |
| 「待重载」标签 | `pendingRestart`（服务端逐字段 diff） | 文件值 ≠ 运行值；密码字段不参与比较 |
| 已废弃键 | `status.ignored`（`normalize`） | 文件里有、代码不认；不生效、不自动删 |

## 「显示值 = 实际值」核对表（验收时逐项填）

| 项 | 页面显示 | `config.json` | 运行中实际 | 一致？ |
|---|---|---|---|---|
| 分流模型 | | `model.stages.summary.source/model` | `/state` 的 `stages.summary` | |
| 融合模型 | | `model.stages.chat.source/model` | `stages.chat` | |
| 嵌入模型 | | `model.preset` / `model.stages.embed.model` | `stages.embed` | |
| 精排模型 | | `model.stages.rerank.model` | `stages.rerank` | |
| 注入 | | `inject.enabled` | `injection.mode` | |
| 替代历史 | | `compaction.enabled/keepTurns` | `config.compaction` | |
| L1 容量 | | `layers.hotChars` 或 `workMode.hotChars` | `workMode.hotChars`/引擎 | |
| 抓取字数 | | `capture.*` 或 `workMode.*` | `workMode.capture` | |
| 待整理 | | — | `stats.pending` | |
| 语义检索 | | `model.preset` + key | `caps.embed` | |

## 怎么快速验（PowerShell）

```powershell
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$base = (Get-Content (Join-Path $dshHome 'memory-tiers\status.json') -Raw | ConvertFrom-Json).api.baseUrl
# 1) 页面接口：文件值 + 运行值 + 待重载
Invoke-RestMethod "$base/dsh-memory/api/config" | Select-Object -ExpandProperty pendingRestart
# 2) 四阶段实际解析
Invoke-RestMethod "$base/dsh-memory/api/state" | Select-Object -ExpandProperty stages
# 3) 热改：POST 保存 layers.hotChars 后，effective 应立即变成新值、pendingRestart 为空
# 4) 会话状态 / 豁免名单
Invoke-RestMethod "$base/dsh-memory/api/sessions"
# 5) 星图与数据
Invoke-WebRequest "$base/dsh-memory/star" -UseBasicParsing | Select-Object StatusCode
Invoke-RestMethod "$base/dsh-memory/star/data" | Select-Object -ExpandProperty layers
```

> 端口每次重启会变：用 `status.json` 的 `api.baseUrl`，或 `preflight --url auto`。
