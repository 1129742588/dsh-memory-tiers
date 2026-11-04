# dsh-memory-tiers 实机验证手册

> **给执行的 agent**：这份手册是「照着做就能得出结论」的清单，不是背景介绍。
> 每一步都给了「怎么造 / 看什么 / 期望什么 / 失败看哪里」。
> 遇到不通过，**不要改 `core/`**，把证据按 §9 交回即可。
>
> **判定口径**，每条只有三种：
> - **PASS**：期望的现象出现了，且能贴出证据行；
> - **FAIL**：期望的现象没出现（贴出实际日志/返回）；
> - **BLOCKED**：环境不满足（比如没有模型 key、dsh 版本差异导致某个服务缺失），
>   必须写清「缺什么、因此哪一步测不了」，不算通过也不算失败。

建议顺序：§2 离线自检 → §3 安装 → §4 首验 → §5 七步 → §6 配置页 → §7 故障注入。
总时长约 80–100 分钟，其中 §3 之后需要重载插件 一次（重启会结束当前会话）。

---

## 0. 环境与边界

| 项 | 值 |
|---|---|
| 代码位置 | `D:\Tempfile\dsh-memory-tiers`（`core/` 是唯一发布物） |
| 配置与日志 | `<DSH_HOME>/memory-tiers/config.json` / `log.txt` / `status.json` |
| 记忆库（默认） | `<DSH_HOME>/storages/memory` |
| `DSH_HOME` | 环境变量有就用，否则 `~/.dsh` |
| 工具 | `tools/preflight.mjs`、`tools/inspect-session.mjs`、`tools/collect-report.mjs`、`tools/seed.mjs` |
| 测试 | `test/`（72 项，不需要 dsh） |

**不要做**：改 `core/` 里的代码、删用户的记忆库、把真实 API Key 贴进报告（`collect-report` 会自动打码，但手工贴日志时注意）。
**需要重载插件**：新代码、配置页的新前端，都要重启才生效。如果你没有重启权限，做到 §2 为止，把剩下的交给用户。

> 如果你的机器上仓库不在 `D:\Tempfile\dsh-memory-tiers`，全文把这个路径替换成实际路径即可（`core/` 仍是发布物）。

### 0.1 怎么确认「跑的是新代码，不是旧插件」

| 看什么 | 新代码（1.3.0） | 旧插件（0.9.x） |
|---|---|---|
| 配置文件 | `<DSH_HOME>/memory-tiers/config.json`（有 `version: 2`、`storage.dir`、`layers.*`） | `<DSH_HOME>/memory-tiers.json`（有 `layout`、`memoryCfg`） |
| 状态文件 | `<DSH_HOME>/memory-tiers/status.json`（有 `statusVersion`、`boot.steps`） | `<DSH_HOME>/memory-tiers.status.json` |
| 日志 | `<DSH_HOME>/memory-tiers/log.txt`（事件名 `BOOT_*` / `API_MOUNTED` / `DIGEST`） | `<DSH_HOME>/memory-tiers.log`（`ORGANIZE ok …` 为主） |
| 工具 | 5 个 `memory_*` | 同样是 5 个，但**旧版可能根本没装上** |

如果两套文件同时存在：旧文件会在首次启动时被迁移成 `memory-tiers.json.v1-bak`——看到 `.v1-bak` 就说明迁移跑过了。

---

## 1. 术语：六层与七个步骤

后文所有「影响第 N 步」都按这个编号：

1. **收**：每轮结束 → 写 L1（用户的话 / 模型的话 / 工具做了什么）
2. **分**：L1 一过 `hotChars` 就分类 + 摘要 + 分流（被引用的进 DL2，没被引用的进 DL1，少量留 L2）
3. **合**：新摘要 vs DL3 旧摘要（重复合并 / 矛盾作废 / 进展并存）
4. **沉**：L2 满了 → 连同 DL1 再压一次
5. **忘**：DL1 按保持率遗忘（先写台账，写不进去就不删）
6. **喂**：每轮把 L3+L2+L1 拼成 `<memory_context>` 注入上下文
7. **替**：把 dsh 历史换成一条占位（记忆替代历史）

层：`L1 即时` / `L2 巩固` / `L3 长期（视图，不落盘）` / `DL1 遗忘中` / `DL2 原文库` / `DL3 摘要库`。

---

## 2. 离线自检（不需要 dsh；不过就别装了）

```powershell
cd D:\Tempfile\dsh-memory-tiers

# ① 37 项装机前检查（文件清单、独立 import、配置往返、引擎冒烟）
node tools\preflight.mjs

# ② 72 项单元/流程测试
node --test 'test/*.test.mjs'

# ③ 看注入块长什么样（造一份假库，不碰真数据）
node tools\seed.mjs
```

**期望**

| 命令 | 期望 |
|---|---|
| preflight | 输出里有 `✅ 37 项全过。`（任何 ❌ 都要贴出来） |
| 测试 | `# pass 64` / `# fail 0` |
| seed | 打印 `分层: L1=… DL2=… DL3=…` + 一段 `<memory_context>`（含 `## 一直记得的` 和 `## 刚发生的`） |

三条都过 → 代码本身没问题，继续 §3。任何一条 FAIL → **停**，把命令输出原样交回。

---

## 3. 安装（需要重载插件）

先确认 dsh 的 profile 目录（一般是 `<DSH_HOME>/profiles/desktop`，也可能是 `web`）：

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$prof = Join-Path $dshHome 'profiles\desktop'
$core = 'D:\Tempfile\dsh-memory-tiers\core'
Test-Path $prof; Get-Content (Join-Path $prof 'package.json') -Raw
```

### 3.1 备份

```powershell
Copy-Item (Join-Path $prof 'package.json') (Join-Path $prof 'package.json.bak-verify')
Copy-Item (Join-Path $prof 'cordis.patch.yml') (Join-Path $prof 'cordis.patch.yml.bak-verify')
```

### 3.2 指到新代码（二选一）

**A. 有 pnpm（dsh 插件管理器在用的那个）**

```powershell
cd $prof
pnpm add "link:$core"
```

**B. 没有 pnpm：手工接线**

1. 在 `$prof\package.json` 的 `dependencies` 里加一行：

   ```json
   "dsh-memory-tiers": "link:D:\\Tempfile\\dsh-memory-tiers\\core"
   ```

2. 把 `<prof>\node_modules\dsh-memory-tiers` 换成指向 `core` 的 junction：

   ```powershell
   $link = Join-Path $prof 'node_modules\dsh-memory-tiers'
   if (Test-Path $link) {
     $item = Get-Item $link
     if ($item.LinkType) { $item.Delete() }      # 只删链接本身，不碰目标
     else { Write-Warning "这不是链接而是真目录，先人工确认：$link" }
   }
   New-Item -ItemType Junction -Path $link -Target $core | Out-Null
   Get-Item $link | Select-Object FullName,LinkType,Target
   ```

3. 确认 `<prof>\cordis.patch.yml` 里有这一行（没有就补，值必须是 `false`）：

   ```yaml
   - id: memory-tiers
     disabled: false
   ```

### 3.3 确认「旧的没在跑」

```powershell
Get-Item (Join-Path $prof 'node_modules\dsh-memory-tiers') | Select-Object Target
```

Target 必须是 `D:\Tempfile\dsh-memory-tiers\core`。如果还是旧仓库路径，说明没换成功——**不要继续**。

### 3.4 重载插件

关掉 dsh desktop，重新打开。**重启后新开一个会话**再继续（旧会话里的插件状态是旧的）。

> 回滚：把两个 `.bak-verify` 覆盖回去，junction 指回旧路径，再重启。

---

## 4. 装机后首验（5 分钟，三件事）

### 4.1 你（agent）的工具集里有没有 5 个记忆工具

**PASS 条件**：你这一轮能调用 `memory_write` / `memory_search` / `memory_attend` / `memory_forget` / `memory_stats`。

**FAIL 时**：

```powershell
Get-Content (Join-Path $dshHome 'memory-tiers\status.json') -Raw
```

看 `boot.errors` 和 `boot.steps`：哪一步是 `fail`，就是哪个服务没接上。

### 4.2 状态与日志

```powershell
Get-Content (Join-Path $dshHome 'memory-tiers\status.json') -Raw
Select-String -Path (Join-Path $dshHome 'memory-tiers\log.txt') -Pattern 'BOOT_|INJECT_|API_MOUNTED' |
  Select-Object -Last 30
```

**PASS 条件**（缺一不可）：

| 看什么 | 期望 |
|---|---|
| `status.json` | `boot.steps` 全 `"ok"`；`boot.errors` 是 `[]`；`statusVersion: 1` |
| `status.json` | `inject.mode` = `"context"`（老 dsh 可能是 `"section"`） |
| `log.txt` | `BOOT_DONE … errors=0` |
| `log.txt` | `INJECT_ON context` |
| `log.txt` | 4 条 `API_MOUNTED /dsh-memory/api/…`（config / state / log / organize） |

### 4.3 配置接口真的挂了

```powershell
node D:\Tempfile\dsh-memory-tiers\tools\preflight.mjs --url auto
```

**PASS 条件**：`✅ 配置接口已挂载`。

判读规则（很重要）：

- **401 / 403** = 路由存在，只是要鉴权 → **算挂上了**；
- **404** = 没有这条路由 → 插件没挂上 → FAIL；
- 200 = 挂上了，且这台 dsh 不要求鉴权。

### 4.4 打开 GUI：设置 → 记忆

**PASS 条件**：能看到「现在怎么样（只读）」的六层表格 + 一组配置项，没有「读取配置失败」。

> 页面空白/报错时，先看 §4.2 的 `API_MOUNTED`；页面字节是重启后才更新的，改完代码不重启看到的还是旧的。

---

## 5. 七步端到端验证

> 这一节的所有操作都在**装好插件的这个会话里**做。
> 每步的「取证」都给了命令；把输出里对应的那一行贴进报告。
> 为了不让整理等太久，先按 5.0 调快节奏，**验完记得改回去**。

### 5.0 临时调快配置（重启一次）

编辑 `<DSH_HOME>/memory-tiers/config.json`，改这几项（其余不动），然后重载插件：

```json
{
  "layers": { "hotChars": 200, "consolidateChars": 200, "longChars": 800, "l2KeepMax": 2 },
  "organize": { "everyMin": 1, "refreshMin": 1 },
  "compaction": { "enabled": true, "keepTurns": 0 }
}
```

> 1.2.0 起 **L1 只看字数**：超过 `hotChars` 后，下一次整理（每分钟一次的定时器，或点「立即整理」）就会分流，
> 不再等安静期。`everyMin: 1` 只是让定时器勤快一点。
> 验证结束后改回默认（`hotChars: 3000 / consolidateChars: 2500 / everyMin: 5 / refreshMin: 30`）或直接删掉配置让它重新生成。

### 5.1 收（第 1 步）

**造场景**：

1. 随便干一件会用到工具的小事（比如 `Get-Date`）；
2. 再调用 `memory_write`，内容里带一个**唯一标记**，例如：
   `text: "验证标记 ALPHA-731：用户要求所有测试都必须真的跑一遍"`
3. 让这一轮正常结束。

**取证**：

```powershell
$data = (Get-Content (Join-Path $dshHome 'memory-tiers\config.json') -Raw | ConvertFrom-Json).storage.dir
Get-ChildItem (Join-Path $data 'L1.tmp') | Select-Object Name,Length
Select-String -Path (Join-Path $dshHome 'memory-tiers\log.txt') -Pattern 'WRITE_TURN ' | Select-Object -Last 3
node D:\Tempfile\dsh-memory-tiers\tools\inspect-session.mjs --json
```

**PASS 条件**（全部满足）：

- `L1.tmp\<writer>.jsonl` 里有内容；
- 日志有 `WRITE_TURN user=… bot=… tool=… rows=… L1=…`，且 `rows ≥ 2`；
- `inspect-session --json` 的 `store.layers.L1.items > 0`。

**FAIL 时看**：`CAPTURE_ON`（没出现 = 事件订阅没装上）、`CAPTURE_OFF`（配置里关掉了）、`WRITE_TURN_FAIL`、`BUFFER_TRUNCATED`。

### 5.2 喂（第 6 步）

**造场景**：紧接 5.1，不需要额外操作——下一轮请求里就该带记忆块。

**取证**：

```powershell
node D:\Tempfile\dsh-memory-tiers\tools\inspect-session.mjs
```

**PASS 条件**：

- `注入 ✅ 有记忆块 ×N，最近一块 M 字`，且 `M > 0`；
- 打印的片段里能看到 `## 刚发生的`（如果已有摘要，还应有 `## 一直记得的`）；
- `tools.memory` 是 5 个。

**FAIL 时看**：`INJECT_ON` / `INJECT_OFF` / `INJECT_FAIL`；`status.json` 的 `inject.mode` 是不是 `none`。

### 5.3 分（第 2 步：分类 + 摘要 + 分流）

**造场景**：再写 3–5 条不同的内容（`memory_write` 或正常对话都行，每条 40 字以上），然后**等 1–2 分钟**：临时配置里 `organize.everyMin=1`，定时器会自己整理一次。也可以请用户点设置页的「立即整理」（它打的就是 `POST /dsh-memory/api/organize`）。

> 不要用另起一个 node 进程去调 `organize()`：那个进程没有模型能力，会把东西按「无模型」路径推进 DL1，结论就错了。整理必须由跑着的插件自己来做。

**取证**：

```powershell
Select-String -Path (Join-Path $dshHome 'memory-tiers\log.txt') -Pattern 'CLASSIFY|DIGEST|ORGANIZE ok' |
  Select-Object -Last 10
node D:\Tempfile\dsh-memory-tiers\tools\inspect-session.mjs
```

**PASS 条件**（分成两种情况，别混）：

| 情况 | 期望 |
|---|---|
| **有模型**（有会话模型，或配了 apiKey） | 日志出现 `DIGEST[l1] … → 摘要 N（引用 M）`；`DL3 ≥ 1`；`M > 0` 时 `DL2 ≥ 1`（被引用的原文）；`+` 的条目进了 `L2`；`L1` 变少 |
| **没模型**（BLOCKED，不是 FAIL） | 日志 `DIGEST_NO_MODEL … → DL1` 或 `DIGEST_FALLBACK[l1] reason=model_fail`；`DL3 = 0`、`DL1` 增加、条目带 `pendingDigest`。这是**设计好的降级**：没有模型就绝不产生假摘要 |

> 1.1.0 起分流是两阶段的：L1 阶段只有 `★`（摘要）和 `+`（留原文）两种标记；`★★/★/☆` 三档只在 L2 满时的第二遍出现。如果日志里出现 `DIGEST_EMPTY[l1]`，说明模型这一批既没给 `★` 也没给 `+`——原文会全进 DL1，这时去看 §5.4 的模型质量，不要当成代码 bug。

**FAIL 时看**：`CLASSIFY …` 的 `批 N 个`（分批是否正常）、`MODEL_FAIL stage=classifyBatch / summarizeWithSources`、`ORGANIZE_FAIL`；如果什么都没发生，先看 `status.json` 六层条数——L1 没到 `hotChars` 就没得分流（1.2.0 起不再等安静期）。

### 5.4 合（第 3 步：融合）

**前置**：必须能用嵌入模型（`status.json` 的 `semantic.embed: true`，或 `/memory` 概览显示「语义 可用」）。没有 → **BLOCKED**，并注明「融合靠向量预筛，没有嵌入就不触发，两条近似摘要会并存（已知代价）」。

**造场景**（分三次，每次都等一次整理）：

1. 写 `"用户要求所有测试都必须真的跑一遍"`；
2. 写语义几乎相同、措辞不同的一条 → 期望 `FUSE_DUP`；
3. 写相反的一条（`"用户说测试不用真跑，看着像通过就行"`）→ 期望 `SUPERSEDE`；
4. 写进展（`"测试从 12 个用例补到 20 个，全部真跑通过"`）→ 期望 `FUSE_UPDATE`。

**取证**：

```powershell
Select-String -Path (Join-Path $dshHome 'memory-tiers\log.txt') -Pattern 'FUSE_DUP|SUPERSEDE|FUSE_UPDATE|SUM_SUSPECT' |
  Select-Object -Last 10
```

**PASS 条件**：三种事件都至少出现一次；`DL3` 的条数没有因为重复写而等量增长；`memory_search` 搜「测试」时重复内容只回一条（或一条有效的）。

**FAIL 时看**：`fusionPrefilter`（默认 0.82，太高/太低会漏判或误判）、`MODEL_FAIL stage=session:chat`（判关系失败会「两条都留」并留痕）。

### 5.5 沉（第 4 步：L2 → DL1）

**造场景**：继续写，直到 `L2` 超过 `consolidateChars`（临时配置是 200 字）；然后再等一次整理（`everyMin=1` 的定时器，或请用户点「立即整理」）。第一次整理会把 `+` 的条目放进 L2，第二次整理才会「L2 旧半 + 全部 DL1」再压一遍。

**取证**：

```powershell
node D:\Tempfile\dsh-memory-tiers\tools\inspect-session.mjs
Select-String -Path (Join-Path $dshHome 'memory-tiers\log.txt') -Pattern 'DIGEST' | Select-Object -Last 6
```

**PASS 条件**：`L2` 条数在第二次整理后下降；`DL1` 增加；日志里出现 `DIGEST[l2]`，且摘要条数按档分布（`★★x/★y/☆z`）。

**FAIL 时看**：`DIGEST_FALLBACK[l2]`（模型失败，整批回 L2）、`ORGANIZE_FAIL`；还要看 `DIGEST[l2]` 的 `keep` 是否超过 `l2KeepMax`（超了会去 DL1，这是设计行为）。

**FAIL 时看**：`consolidateMaxItems`（条数没到也不触发）、`L2` 是不是空的（`+` 太少，模型没标）。

### 5.6 忘（第 5 步）

**造场景**：

1. `memory_search` 找到一条，拿它的 id；
2. `memory_forget` 传这个 id；
3. 再等一次整理（`everyMin=1` 的定时器，或请用户点「立即整理」）。

**取证**：

```powershell
$data = (Get-Content (Join-Path $dshHome 'memory-tiers\config.json') -Raw | ConvertFrom-Json).storage.dir
Get-Content (Join-Path $data 'graveyard\forgotten.jsonl') -Tail 3
Select-String -Path (Join-Path $dshHome 'memory-tiers\log.txt') -Pattern 'FORGET_ITEM|FORGET_MISS|FORGET_FAIL|SIGNAL_APPLY' |
  Select-Object -Last 5
```

**PASS 条件**：`forgotten.jsonl` 多出一行（含 id 和「遗忘」原因）；日志有 `FORGET_ITEM <id> layer=…`；再 `memory_search` 搜不到它。

**FAIL 时看**：`FORGET_MISS`（id 不对/已不在）、`FORGET_FAIL`（台账写不进去，按设计**不会删**）。

### 5.7 替（第 7 步：记忆替代历史）

**造场景**：正常再聊 2 轮（配置里 `keepTurns: 0`，每轮结束都会尝试替换）。

**取证**：

```powershell
node D:\Tempfile\dsh-memory-tiers\tools\inspect-session.mjs
Select-String -Path (Join-Path $dshHome 'memory-tiers\log.txt') -Pattern 'COMPACT_OK|COMPACT_SKIP' | Select-Object -Last 5
```

**PASS 条件**：

- `压缩 ✅ 有 N 条占位`，且占位文本是「此前 K 轮对话已归档到长期记忆…」；
- 日志有 `COMPACT_OK removed=… rounds=… archived=…`；
- **关键**：模型这边依然能引用 5.1 写的 `ALPHA-731`（说明历史没了、记忆还在）。

**FAIL 时看** `COMPACT_SKIP` 的 reason：

| reason | 含义 | 是否正常 |
|---|---|---|
| `inject-disabled` | 注入关着、历史全替会失忆，所以拒绝 | 正常保护 |
| `no-context` | 记忆块是空的（库空/全在 DL1 等模型），不肯替 | 正常保护 |
| `no-archivable` | 这段历史没有可归档内容 | 正常 |
| `archive-failed` | 写记忆失败 | 异常，看 `WRITE_TURN_FAIL` |
| `replace-failed` | dsh 拒绝 surface 替换 | 异常，贴完整报错 |

---

## 6. 配置页验证（10 分钟）

> 逐字段核对表见 `docs/CONFIG-PAGE.md`（显示项 × 来源 × 含义）。这里只列操作。

| # | 操作 | PASS 条件 |
|---|---|---|
| 6.0 | 看页面最上面的「模型与阶段」 | 分流 / 融合 / 嵌入 / 精排 四行都在，各带 `会话` 或 `API` 标签和**生效模型名**；下面单独一行「当前会话模型」。**分流那行必须等于 `config.json` 里 `model.stages.summary` 的实际解析结果**，不能显示会话模型 |
| 6.1 | 打开 设置 → 记忆 | 六层表格有数字；底部显示配置路径和记忆库路径；「注入记忆」「替代历史」两项与 `status.json` 一致 |
| 6.2 | 改「L1 即时层（字）」为 500，点保存 | 提示「已保存 1 项：layers.hotChars」，并提示重载插件生效 |
| 6.3 | 直接看 `config.json` | `layers.hotChars` = 500 |
| 6.4 | 不重启，刷新页面 | 输入框是 500（文件值），旁边出现**「待重载」标签**，顶部横幅列出该项；「模型与阶段」仍显示运行值 |
| 6.5 | **生效验证**：把「把记忆注入上下文」关掉 → 保存 → 重载插件 | 保存时出现警告（模型将看不到历史与记忆）；重载后 `inspect-session` 显示 `注入 ❌`，日志有 `INJECT_OFF`。再打开 → 重启 → `注入 ✅`、`INJECT_ON context` |
| 6.6 | 「遗忘阈值」填 70，保存 | 报错「不能大于 1」，**其它字段照存** |
| 6.7 | 清空某个数字框，保存 | 该项**不被改成 0**（`changed` 里不出现它） |
| 6.8 | 看 API Key 输入框 | 显示「已设置（留空不改）」，页面源码里看不到明文 |
| 6.9 | 「记忆库目录」填 `relative/x`，保存 | 报错「需要绝对路径」，文件里的旧值不变 |
| 6.10 | 点「立即整理」 | 提示已整理（或「没整理：busy」），页面上的「上次整理」时间更新 |
| 6.11 | 点「看日志」 | 出现最近 20 行日志（含 `BOOT_` / `WRITE_TURN` 之类） |
| 6.12 | 看「工作模式」组的位置与提示 | 在「模型」之后；开关的说明里明确写「切换本项需重载插件才生效」 |

> 6.6 的「其它字段照存」和 6.7 的「不落成 0」是这次特意修的：旧版会把清空当 0，而 `userCaptureChars=0` 等于把「收」这一步关掉。

---

## 7. 故障注入（15 分钟，证明「坏了不会静默」）

每个都要求：**重启 → 看日志 → 恢复**。

| # | 造法 | 期望 |
|---|---|---|
| 7.1 坏配置 | 把 `config.json` 改成 `{ 坏的` | 重启后生成 `config.json.broken-<时间戳>`，新配置自动生成，`BOOT_DONE errors=0`，日志有 `CONFIG_BROKEN` |
| 7.2 没有模型 | 清空 `model.apiKey`，且让会话模型不可用（离线/切到没有 llm 的 profile） | `status.semantic.embed=false`；日志 `NO_KEY`；第 1 步照常、第 2 步走 `DIGEST_NO_MODEL → DL1`；**不产生假摘要** |
| 7.3 关注入 + 全替 | 页面把「把记忆注入上下文」关掉 | 保存时出现警告（模型将看不到历史与记忆）；运行时 `COMPACT_SKIP reason=inject-disabled` |
| 7.4 记忆库目录不可写 | `storage.dir` 指到一个只读目录 | 保存时 400「目录不可写」；若绕过保存直接改文件，重启后 `boot.errors` 里有 `STORE_UNWRITABLE`，插件不崩 |
| 7.5 缺 webServer | 用 `--headless`/无 web 的 profile 启动 | 日志 `BOOT_MISSING webServer` 或看门狗记录；工具/注入照常，**插件不消失** |
| 7.6 工作模式 | 页面打开「工作模式」→ 保存 → 重载插件 | 保存时明确提示需重载；重载后 `status.workMode.enabled=true`、`inject.mode=off`、日志 `INJECT_OFF reason=work-mode`；`inspect-session` 显示 `注入 ❌`；一轮对话后**没有** `COMPACT_OK`（有 `COMPACT_SKIP reason=work-mode`），但 `WRITE_TURN`/`DIGEST[l1]` 照常，抓取字数按 `workMode.*` |
| 7.7 纯字数分流 | 连聊多轮直到 L1 超过 `hotChars` | 下一轮整理就出现 `DIGEST[l1]`；**不再有** `L1_FULL_NO_QUIET`；分流后 L1 字数回落 |

> 7.2 与 7.5 属于「降级验证」，BLOCKED 也算正常——但必须记录实际现象。

---

## 8. 性能记录（可选，5 分钟）

```powershell
node D:\Tempfile\dsh-memory-tiers\tools\inspect-session.mjs
```

记下：记忆库六层条数、注入块字数、`ORGANIZE ok … Nms` 的耗时。若条数上了几千，再记 `memory_search` 的响应时间（agent 自己计时）。

**参考线**（1000 条以内）：注入块 < 3000 字（默认 `longChars` 3000）；单次整理 < 5 秒（不含模型调用）。

---

## 8.5 会话打不开时：先修会话（不修就看不到后面的证据）

如果重启后打开旧会话报 `... lacks an identified message`，那是 1.0.0 的压缩占位缺 id 留下的历史数据，
**新代码已经不再产生**，但旧数据不会自愈。先关掉 dsh，然后：

```powershell
node D:\Tempfile\dsh-memory-tiers\tools\repair-sessions.mjs           # 只检查
node D:\Tempfile\dsh-memory-tiers\tools\repair-sessions.mjs --apply   # 补 id（先备份）
```

详细说明见 `docs/SESSION-REPAIR.md`。修完重载插件 再继续 §4/§5；这一步不需要算进七步的 PASS/FAIL。

---

## 9. 交回清单（必须）

1. **离线自检**：`preflight` 最后 5 行 + `node --test` 的 `# pass/# fail` 两行 + `seed` 的注入块。
2. **一分打包报告**：

   ```powershell
   node D:\Tempfile\dsh-memory-tiers\tools\collect-report.mjs
   ```

   产物在 `D:\Tempfile\dsh-memory-tiers\scratch\verify-report-<时间>.md`，
   已包含：配置、`status.json`、`log.txt` 末 200 行、会话取证（工具/注入/压缩/六层）、自动结论。密钥自动打码。

3. **七步结果表**（照抄，填 PASS/FAIL/BLOCKED + 证据行）：

   | 步骤 | 结论 | 证据（日志行 / 命令输出） |
   |---|---|---|
   | 1 收 | | |
   | 2 分 | | |
   | 3 合 | | |
   | 4 沉 | | |
   | 5 忘 | | |
   | 6 喂 | | |
   | 7 替 | | |

4. **配置页结果**：§6 的 13 项，逐项 PASS/FAIL；并按 `docs/CONFIG-PAGE.md` 填一张「显示值 = 实际值」核对表。
5. **凡 FAIL**：贴 `status.json` 的 `boot.errors` + 对应日志行（不要只写「不行」）。
6. **跑过会话修复的**：贴 `repair-sessions.mjs` 的检查输出（几个文件 / 几条事件）与是否成功。


---

## 10. 1.3.0 新增验收（10 分钟）

| # | 动作 | 判定 |
|---|---|---|
| 1 | 设置页点「打开记忆星图」；换 `storage.dir` 重载后再开 | 页面能开；数据跟新库；没有 8902 端口；边写边刷新不闪 |
| 2 | 配置页填一段人格 → `/memory context` | 顺序是「系统提示 → 人格 → 记忆块」；关掉人格后没有空白段 |
| 3 | 输入框旁标记：会话 A 开工作模式 → 聊两句 → 关掉 | A 显示「工作模式 · 已豁免」；继续聊，历史仍在；B 显示「记忆接管」不受影响 |
| 4 | 设置页解除 A 的豁免 | 先出现风险提示，再点确认才解除；解除后 A 恢复注入/接管 |
| 5 | 重启 dsh（或重载插件）后看 `sessions.json` | A 的豁免仍在 |
| 6 | 工作模式连跑几轮 | 日志有 `SKELETON`；L1 是每条轮次一条骨架，不含工具输出/参数；DL2 增长变慢 |
| 7 | 改 `layers.hotChars` 保存 | 提示「立即生效」；下一轮整理按新值 |
| 8 | 改 `model.summaryChunk` 保存 | 提示「需重载」；页面标「待重载」；运行值不变 |
| 9 | 带人格连发 3–5 轮 | 缓存未命中稳定低位、不随轮数累积（正常会话仍 500–800 量级） |

---

## 附录 A：日志事件对照表（`log.txt`）

| 事件 | 含义 / 看到它说明什么 |
|---|---|
| `BOOT_OK <step>` | 某一步装载成功（config / model / memory / tools / capture / systemPrompt / webServer / commands / timers） |
| `BOOT_FAIL <step> …` | 某一步失败；插件继续装其余部分 |
| `BOOT_MISSING <service>` | 服务一直没来（或看门狗超时）——设置页/命令没挂上时看这个 |
| `BOOT_DONE ms=… steps=… errors=N` | 装载结束；`errors=0` 才是干净启动 |
| `BOOT_DEGRADED …` | 有错误时的汇总行 |
| `API_MOUNTED <path>` | 配置页接口挂上了；一条都没有 = 接口没挂 |
| `INJECT_ON context / section` | 记忆块挂上了（context 是新接口，section 是老接口兜底） |
| `INJECT_OFF reason=inject-disabled / work-mode` | 没挂注入：配置关了 / 工作模式 |
| `WORK_MODE on hotChars=… consolidateChars=… user=…` | 工作模式启动（不注入、不压缩，容量用专属值） |
| `INJECT_FAIL` | 注入失败 |
| `CAPTURE_ON …` / `CAPTURE_OFF` | 「收」这一步开/关 |
| `WRITE_TURN user=… bot=… tool=… rows=… L1=…` | 一轮写进 L1；`rows` 是这一轮的条数 |
| `WRITE_TURN_SKIP` / `WRITE_TURN_FAIL` | 这一轮没有可写内容 / 写失败（失败时**不会**压缩历史） |
| `BUFFER_TRUNCATED` | 某会话缓冲过大，做了截断（长时间不结束的会话） |
| `CLASSIFY n/m 条（改判 x，批 k 个）` | 分类跑了多少条、改了几个、分了几批 |
| `MODEL_MISSING` / `MODEL_FAIL stage=… ms=…` | 模型不可用 / 调用失败（含阶段和耗时） |
| `NO_KEY stage=embed|rerank` | 云端地址没 key，主动跳过（不是错误） |
| `SESSION_UNAVAILABLE` / `SESSION_EMPTY` | 会话模型通道拿不到 / 返回空，回落 HTTP |
| `DIGEST[l1] … → 摘要 N（引用 M）` | L1 阶段分流成功（★ 摘要 → DL3，引用 → DL2，`+` → L2） |
| `DIGEST[l2] … → 摘要 N（★★x/★y/☆z，引用 M）` | L2 满后的第二遍：三档摘要 + 限量保留 |
| `DIGEST_EMPTY[l1|l2] … → DL1` | 模型这一批既没给摘要也没给 `+`：原文全进 DL1（不是错误，但要看模型质量） |
| `DIGEST_NO_MODEL … → DL1` | 没有摘要能力：原文下沉 DL1 等模型（设计行为） |
| `DIGEST_FALLBACK[l1|l2] reason=model_fail|empty_reply` | 模型失败：整批回 L2，下轮再压 |
| `FUSE_DUP` / `SUPERSEDE` / `FUSE_UPDATE` | 融合：重复合并 / 矛盾作废 / 进展并存 |
| `FORGET n 条（…）` / `FORGET_ITEM <id>` / `FORGET_FAIL` | 遗忘发生了 / 单条被删 / 台账写不进去（不删） |
| `DL1_TRIM n 条（超上限 X 字，清到 Y 字）` | DL1 超过 `layers.dl1MaxChars`，按「越旧越先清」清到 80% |
| `FORGET_SUMMARY n 条…；连带清理原文 m 条` | DL3 淘汰了琐事档摘要，并清理它独占的 DL2 原文 |
| `SIGNAL_APPLY n 条` | attend / pin / forget 队列被消费 |
| `COMPACT_OK removed=… rounds=… archived=…` | 历史被替换成占位 |
| `COMPACT_SKIP reason=…` | 没有替换（`inject-disabled` / `no-context` / `work-mode` / `keep-turns` 等，见 §5.7 表） |
| `READ_FAIL` / `READ_CORRUPT` | 某层文件读坏了，只读路径当空处理（整理路径会直接报错） |
| `MERGE_TEMP_BAD` / `SWEEP_STALE` | 半截临时文件被跳过 / 被清理 |
| `RELOCATE_LEGACY` | 旧版残留文件被归位（只搬不删） |
| `ORGANIZE ok merged=… L1=… L2=… L3=… Nms` | 一次整理完成 |
| `ORGANIZE_FAIL …` / `L1_ALL_PINNED` | 整理失败 / 超容量但可搬的轮次都钉住了（1.2.0 起没有 `L1_NOT_FULL`：没到容量就直接返回） |
| `CONFIG_CREATED|FILLED|INVALID|BROKEN|MIGRATED|SAVED` | 配置的生成/补齐/非法/损坏/迁移/保存 |
| `API_ERROR` | 接口内部异常（带堆栈） |

---

## 附录 B：配置项 × 影响哪一步

| 配置 | 影响 | 说明 |
|---|---|---|
| `layers.hotChars` / `layers.hotQuotaOwn` | 1 / 6 | L1 容量、注入时自己这端占多少 |
| `layers.consolidateChars` / `layers.l2KeepMax` | 2 / 4 | L2 什么时候下沉、`+` 留几条 |
| `layers.longChars` | 6 | 「一直记得的」最多多少字 |
| `layers.forgetThreshold` | 5 | DL1 保持率低于它才忘 |
| `layers.dl1MaxChars` | 2 / 5 | DL1 字数上限：超了按「越旧越先清」清到 80% |
| `organize.everyMin` | 2 | 定时整理间隔（1.2.0 起 L1 只看字数，没有安静期） |
| `organize.refreshMin` | 6 | L3 快照刷新（影响前缀缓存） |
| `organize.fusionPrefilter` | 3 | 融合预筛阈值：调低更容易判出矛盾（多花模型调用） |
| `capture.*` | 1 / 6 | 抓什么、截多长、每轮要不要检索相关旧事 |
| `inject.enabled` / `inject.maxChars` | 6（+7 的安全条件） | 关掉就只写不读；`maxChars` 是总量上限 |
| `model.*` | 2 / 3 / 4 / 6 | 分流、融合、嵌入、精排；`preset` 选「硅基流动」时忽略嵌入/精排覆盖值 |
| `workMode.*` | 1 / 2 / 5 | 工作模式：不注入不压缩，抓取与 L1/L2 容量用这组更大的值（重载插件生效） |
| `compaction.*` | 7 | 要不要替、留几轮、每轮归档多少字 |
| `storage.dir` | 全部 | 记忆库位置（改完重载插件生效，旧目录不自动搬） |

> DL3 淘汰参数（只淘汰琐事档：系数 0.55、阈值 0.25、保护期 1 天）是引擎内部值，不暴露到配置页。

---

## 附录 C：已知限制 / 「不算 bug」的现象

1. **没有模型**（既没 key 也没会话模型）：第 2/3/4 步只能把原文下沉 DL1，不会产生摘要；语义检索自动关闭（只走关键词）。这是设计，不是失败。
2. **没有嵌入模型**：第 3 步融合不会触发（融合靠向量预筛），近似摘要会并存——已知代价。
3. **L1 只看字数**：超过 `hotChars` 后下一轮整理就分流，不再等「安静期」。所以「刚聊完没立刻分流」只可能是没到容量，不是卡住。
4. **配置/前端改动要重载插件**：设置页的 JS 是随 dsh 启动打包下发的，改完不重启看到的还是旧页面。
5. **会话模型通道**第一次拿不到会冷却 30 秒再试；重启后头几秒看到 `SESSION_UNAVAILABLE` 属正常。
6. **第二遍只在 L2 满时触发**：没有「DL1 洪水强制第二遍」的兜底（作者定的）。DL1 靠「遗忘曲线 + 字数上限」收敛，超上限会清旧的并写台账——这是设计，不是丢数据。
7. **DL3 只淘汰琐事档**（importance < 0.45）；重要/一般的摘要不按时间淘汰，只靠融合合并/作废。所以 DL3 长期仍可能增长，只是慢。
8. **`/memory context` 不显示工具定义、不显示请求配置**：文件里是「系统提示全文 + 本轮将注入的记忆块 + 其余消息」。
   注入块由插件用 `mem.buildBlock()` **实时构建**——它在命令执行时还不在会话消息里（dsh 在请求组装时才合成 runtime-context 快照），
   所以看到「文件里有、会话里没有」是正常的；文件里那一段才是本轮真正会注入的内容。
9. **工作模式**：开启后注入/压缩被强制关闭，这是设计；「什么都能看到」的普通模式请关掉工作模式后重载插件。
10. **日志是 UTF-8**：PowerShell 5.1 用 `Get-Content` 默认按 ANSI 读会花屏，加 `-Encoding UTF8`（`Select-String` 同理）。
11. **`scene` 固定是 `dsh`**：桌面端没有「群」的概念，摘要不分场景聚合；这是有意为之，不是漏填。
12. **配置页显示的是「文件值」，运行值单独标「待重载」**：改完不重启，页面字段显示新值、旁边有「待重载」标签，
    而「模型与阶段」「现在怎么样」显示的是运行值——两处不一致是**正确行为**，不是 bug（见 `docs/CONFIG-PAGE.md`）。
13. **本手册的验证范围**是「插件自己的读写/注入/压缩」。dsh 版本差异（服务名、事件字段）只能通过 §4.2 的 `boot.errors` 和 §5 的现象暴露出来——遇到就记 BLOCKED/FAIL，附证据，不要改代码。
14. `tools/` 和 `test/` 不在发布包里（`core/` 之外），它们不参与 dsh 装载。


