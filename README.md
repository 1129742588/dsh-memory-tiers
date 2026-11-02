# dsh-memory-tiers

给 dsh 加长期记忆，同时把每轮对话的 token 压住不涨。

装好之后你不用刻意「记一下」——它自己记、自己整理、需要时自己找回来。

---

## 它解决两个问题

**① 上下文不够用**

dsh 聊久了会遇到两种结局：要么历史太长爆上下文，要么被压缩掉、事后想不起来。
这个插件把对话记到本地，压缩掉的内容仍在库里，随时能搜回来。

**② 每轮花费随历史增长**

默认它会接管 dsh 的历史压缩：**上一轮说完，历史就被压成一条 20 字占位**（一条不留），
下一轮只带记忆块 + 你这句话。上下文长度不随轮数增长，token 花费也就平了。

省下来的比它花的多：整理是有触发条件的（L1/L2 满了），不是每轮都调模型。

---

## 它怎么做到（一句话版）

记忆分六层：**L1/L2/L3** 是活跃层，每轮拼进上下文；**DL1/DL2/DL3** 是深层，只在检索时用。

```
你说的话 → L1（刚发生的）→ 满了取一半 → 重要的进 L2/L3，不重要的沉 DL1 → DL1 里的按时间忘掉
```

原理、实测数据、边界条件都在 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，本文只讲怎么用。

---

## 安装

**方式一：dsh 插件市场**（推荐）

在 dsh 的插件市场里搜 `dsh-memory-tiers`，安装后重启。

**方式二：npm**

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-memory-tiers
```

然后把 `dsh-memory-tiers` 加进该 profile `package.json` 的 `dsh.profile.bundles`，重启 dsh。

**方式三：本地链接**（改代码时用）

```bash
cd ~/.dsh/profiles/desktop
pnpm add "link:/path/to/dsh-memory-tiers"
```

---

## 第一次配置（三步）

重启 dsh 后，数据目录里会自动生成 `config.json`。改配置有两个入口：

- **设置页**：dsh → 设置 → 记忆（推荐，改完重启生效）
- **手改** `<数据目录>/config.json`

### 第一步：填模型 Key

记忆的「语义检索」和「摘要」需要模型。不填也能用，但只能按关键词搜，且不会自动整理。

去 <https://cloud.siliconflow.cn> 注册，拿一个 `sk-` 开头的 Key，填到：

- 设置页 → 记忆 → 嵌入与重排 → API 密钥
- 或 `config.json` 里的 `apiKey`

默认用硅基流动的两个免费模型：

| 用途 | 默认模型 | 费用 |
|---|---|---|
| 嵌入（向量化） | `BAAI/bge-m3` | 免费 |
| 重排（精排） | `BAAI/bge-reranker-v2-m3` | 免费 |

摘要和判关系默认**跟着你当前会话的模型**走，不额外花钱。

### 第二步：给这个程序起个名字

`writer` 是这个程序在数据目录里的身份，**每个程序必须不一样**：

```json
{ "writer": "dsh" }
```

- 只有 dsh 用：填什么都行（默认 `default`）
- 和 astrbot 共用一份记忆：一个填 `dsh`，一个填 `astrbot`

填成一样的两个程序会往同一份临时文件里写，不会丢，但分不清是谁说的。

### 第三步：确认数据目录

默认 `~/.dsh/storages/memory-v5`。想放别处（比如 D 盘、同步盘）：

```bash
export MEMORY_TIERS_DIR="D:/memory"      # 支持 ~ 和绝对路径
```

或者在插件配置里传 `dir`。**不要试图改 `config.json` 里的路径**——那个文件本身就在目录里。

---

## 配置详解

### 记忆容量（最常调）

三层各自有容量，容量就是**每轮注入多少字**（没有单独的上限开关）：

| 参数 | 默认 | 含义 | 调大会怎样 |
|---|---|---|---|
| `memoryCfg.hotMaxChars` | 3000 | L1 容量：刚说的话 | 记得更多细节，token 更多 |
| `memoryCfg.consolidateMaxChars` | 2500 | L2 容量：最近沉淀的原话 | 同上 |
| `memoryCfg.longMaxChars` | 4000 | L3 容量：长期摘要 | L3 段更长，检索信息更全 |

三层合计约 9500 字（约 7000 token）。觉得占上下文多就调小，觉得记不住就调大。

> L1 上限也是**整理触发线**：写满 3000 字才取一半整理。调太小会整理得很频繁。

### 历史压缩

| 参数 | 默认 | 说明 |
|---|---|---|
| `autoCompact` | `true` | 每轮结束把 dsh 历史压成一条占位（零 LLM 调用） |
| `compactKeepTurns` | `0` | 保留最近几轮原文。0 = 一条不留（L1 里已经有） |

**想保留一点原文**就把它改成 2~3，代价是 token 会随轮数涨一点。

### 模型

| 参数 | 默认 | 说明 |
|---|---|---|
| `apiKey` / `apiBase` | 空 / 硅基流动 | 嵌入与重排用 |
| `preset` | `siliconflow` | `siliconflow` 用上面两个免费模型；`custom` 走 `models` 里自己填的 |
| `models.chat` | `{ source: "session" }` | 判关系用哪个模型。`session` = 跟当前会话 |
| `models.summary` | `{ source: "session" }` | 摘要用哪个模型 |
| `noThink.chat` | `true` | 判关系关思考（只要一个词，思考是浪费） |
| `noThink.summary` | `true` | 摘要关思考。**打开思考会更慢（实测慢 3 倍），但摘要可能更细** |

想换成别的 provider（DeepSeek 官方、OpenAI 兼容接口都行）：

```json
{
  "preset": "custom",
  "models": {
    "embed":  { "base": "https://api.siliconflow.cn/v1", "apiKey": "sk-xxx", "model": "BAAI/bge-m3" },
    "summary": { "base": "https://api.deepseek.com/v1", "apiKey": "sk-xxx", "model": "deepseek-chat" }
  }
}
```

> 嵌入模型一旦换了，旧向量不可比较，插件会自动隔离旧向量并重建。**两个程序共用记忆时，嵌入模型必须一致。**

### 整理节奏

| 参数 | 默认 | 说明 |
|---|---|---|
| `quietMs` | 600000（10 分钟） | 一段对话安静这么久才允许整理，避免聊到一半被腰斩 |
| `organizeEveryMs` | 300000（5 分钟） | 定时补一轮整理（拿不到钥匙会自己跳过） |
| `refreshMinMs` | 1800000（30 分钟） | L3 摘要段的重算间隔。它在上下文最前面，变一次后面缓存全失效 |

### 两端共享一份记忆

两个程序指向同一个目录就是共享：

```json
// dsh 的 config.json
{ "layout": "split", "writer": "dsh" }

// astrbot 侧
{ "layout": "split", "writer": "astrbot" }
```

规则：

- 各自只写自己的 `L1.tmp/<writer>.jsonl`，注入时合并
- 谁先结束谁拿「钥匙」整理，同一时刻只有一个在整理
- 深层（L2/L3/DL1~3）只有一个写者，不会互相覆盖

**要求**：两端都用本插件、`writer` 不同、嵌入模型一致。旧数据不迁移，`layout: "legacy"` 可回退到老的单文件布局。

---

## 怎么确认它在工作

1. dsh 启动日志里出现：`[memory-tiers] 布局 split · writer=dsh · 嵌入 api:BAAI/bge-m3`
2. 数据目录里出现 `L1.json`、`L1.tmp/`、`L2/L3.json`、`DL1/DL2/DL3.json`
3. 聊两轮后 `L1.tmp/dsh.jsonl` 里有内容，`organize.state.json` 有统计
4. 设置 → 记忆，能看到每层的条数和字数

---

## 常见问题

**Q：token 没降下来？**

先确认三件事：`autoCompact` 是 `true`；`compactKeepTurns` 是 `0`；插件真的在跑（看启动日志）。
另外缓存是否命中也要看——上下文块**追加在末尾**，前缀不变才省得下来。

**Q：它好像没记住我说的话？**

- L1 只注入最新的若干条（按配额），更早的在 L2/DL 里
- 想让它"永远记得"，说的时候带上明确的意愿（"以后都…"），这类内容更容易被判为重要
- 检索是按需的：模型得先想到去搜，才会搜

**Q：搜索搜不到？**

`search` 有 `depth` 参数：`summary`（只搜摘要）/ `detail`（摘要 + 原文）/ `full`（+ 流水）。
默认走 `summary`，找不到时换 `full` 再试一次。

**Q：整理很慢，几十秒？**

正常。一次整理要调模型生成摘要，2000 条原文要约 40~140 秒（取决于输出多少）。
整理在后台跑，不阻塞对话；另一端的整理会等它放钥匙。

**Q：能删掉记忆吗？**

`mem.forget(id)` 会写台账并删除；也可以直接改/删数据目录里的 JSON。删之前先备份。

**Q：换机器怎么办？**

把整个数据目录拷过去，设好 `MEMORY_TIERS_DIR` 指过去即可（配置、记忆、向量都在里面）。

---

## 数据与备份

```
<数据目录>/
  L1.json  L2.json  L3.json  DL1.json  DL2.json  DL3.json   ← 六层
  L1.tmp/<writer>.jsonl                                     ← 各端待合并的当前轮
  signals/<writer>.jsonl                                    ← attend/pin/forget 请求
  vectors/deep-part-0000.json                               ← 向量
  graveyard/forgotten.jsonl                                 ← 遗忘台账
  config.json                                               ← 配置
  organize.lock                                             ← 整理时的锁（正常情况下不存在）
```

备份就拷整个目录。想彻底重来，删掉目录、重启，会重新生成。

---

## 开发者

> 下面这些脚本只在仓库里，npm 包里不含（`files` 字段只带运行时文件）。

```bash
node test-memory6.mjs      # 六文件布局，66 项
node test-m5.mjs           # legacy 回归，41 项
node test-batch.mjs        # 批量写入，20 项
node test-share.mjs        # 多写者分片，25 项
node sim-real.mjs          # 真实模型仿真（九组机制，--dry 假模型不花钱）
node bench-scale.mjs sum   # 摘要规模基准（会花真钱）
```

设计、实测数据、已知问题、待办：全部在 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
改代码前先读那一份，本文为了好读省略了大量约束。

## License

MIT
