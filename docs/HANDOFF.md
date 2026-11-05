# 交接简报（新会话开场用）

> 粘贴这份到新会话，或者让它读一遍 `docs/HANDOFF.md`，就能接上之前的工作，不用重新讲背景。

## 这是什么项目

`D:\Tempfile\dsh-memory-tiers`：dsh 的**记忆插件**（npm 包 `dsh-memory-tiers`，当前 1.3.1）。给 dsh 加六层记忆：L1 即时 / L2 巩固 / L3 视图 / DL1 流水 / DL2 原文 / DL3 摘要。核心机制叫「两阶段分流」——L1 满了把旧的一半送去提炼，摘要进 DL3、原话进 DL2。

## 本机环境

| 项 | 值 |
|---|---|
| 配置 | `C:\Users\Anxiple\.dsh\memory-tiers\config.json` |
| 会话状态 | `C:\Users\Anxiple\.dsh\memory-tiers\sessions.json`（工作模式/接管豁免，跨重启保留）|
| 记忆库 | `C:\Users\Anxiple\.dsh\storages\memory`（writer=`dsh`）|
| L1 上限 | 20000 字（`layers.hotChars`，今天调过）|
| 日志 | `C:\Users\Anxiple\.dsh\memory-tiers\log.txt` |
| 现存会话 | 15 个（已备份到 `scratch/sessions-backup-2026-11-04`）|
| 星图 | 插件内 `/dsh-memory/star`；开发用 `node tools/star.mjs serve` → 8902 |

## 已经做完的（别重做）

- v1.2.x 的一批修复：会话占位补 id、前缀缓存四连修（未命中 5300→1700→600→稳定 500-800）、L2 直写改缓冲
- 星图 `tools/star.mjs`：球状星云/时间螺旋、三着色、引用连线、双页侧栏、划过全文、拖拽/滚轮锚定、选中真居中、详情显示「牢固度/融合次数/关注次数」
- 向量加载失败留痕：`VEC_LOAD_FAIL` / `VEC_ITEM_BAD`，架构文档 §11.1 有实测数据
- v1.3.0：星图进核心（内存数据、`/dsh-memory/star`、设置页入口）；人格槽位（order 90/95，
  外部 `memoryTiersPersona` 服务，可选 `persona.inSummary`）；工作模式按会话 + 接管豁免 +
  输入框旁模式标记；工作模式粗骨架记忆；配置热改（模型等少数项仍需重载）
- v1.3.1：`agent/pre-step` 把 runtime-context 快照移到本轮用户消息之前；人格 order 90，
  记忆块动态 `WEB_SURFACE - 5`（通常 205，排在稳定环境段之后、端口块之前）；
  压缩占位固定为「（历史已归档到长期记忆）」，不再带轮数；
  技能目录（`skill-catalog`，约 1,576 字）前置到快照之前。缓存前缀可延伸到记忆块与技能目录，
  普通轮未命中实测 611 → 161 token。

## 待做的

- 向量存储格式改造（Float32/二进制/分片）——按 `docs/PENDING-CHANGES.md` 第六节继续暂缓
- 真机验收：装 1.3.1 后按 `docs/VERIFY.md` 跑一遍星图、人格顺序、会话豁免、热改、缓存未命中

## 硬约束（改代码前必读）

- **缓存四条红线**：L1 单时间轴升序禁拆段、自己端全量注入不截断、注入文本逐字稳定（禁时间戳）、顺序固定不动态插拔
- 改完必跑：`node tools/preflight.mjs`（37 项）+ `node --test test/*.test.mjs`（76 项）
- 生效方式是**重载插件**，不是重启 dsh
- 删除类操作：`~/.dsh/sessions`、`storages/`、`memory-tiers/` 一律先列清单 + 二次确认 + 默认备份

## 工作习惯

- 用中文；直接动手改，别只给建议
- 文档要短、只给方向，不写处方式实现（作者明确要求过）
- 改完要报实测数字，不要"应该没问题"

## 关于丢失的那个会话

原会话 `session-34daf893`（4MB，11-3 11:52 创建，cwd=`D:\Tempfile\dsh-memory-tiers`）已被误删，磁盘级恢复只捞回 11-3 12:31–21:00 的 5 轮对话（`scratch/recovered-session-body.md`）。**结论性内容都在 `docs/` 里**，丢的是推演过程。
