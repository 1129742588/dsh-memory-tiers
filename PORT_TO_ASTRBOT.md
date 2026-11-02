# 移植到 astrbot（任务书）

> 给新会话用的背景文档。读这一份就能开始，不需要翻聊天记录。
> 目标：**astrbot 和 dsh 共用一份记忆**——两端各自记，互相看得见。

---

## 0. 一句话

dsh 侧的插件已经在跑（`memory6.mjs`，六文件布局）。astrbot 不需要重写一套记忆系统，
只要**按同一套文件格式写自己的临时文件、读别人的文件**，两端就通了。

难度不在算法，在**协议细节要对齐**。

---

## 1. 现状

| 项 | 值 |
|---|---|
| 仓库 | `C:\Users\Anxiple\WorkBuddy\2026-10-26-16-37-10\dsh-memory-tiers` |
| 默认实现 | `memory6.mjs`（1337 行，六文件布局，`layout: "split"`） |
| 设计文档 | 同目录 `ARCHITECTURE.md` 第 26 节（布局）、27 节（待办） |
| 发布 | npm `dsh-memory-tiers@0.8.2`，GitHub `1129742588/dsh-memory-tiers` |
| 数据目录 | 默认 `~/.dsh/storages/memory-v5`，可用 `MEMORY_TIERS_DIR` 或插件配置 `dir` 指定 |
| dsh 的 writer | `dsh`（config.json 或环境变量 `MEMORY_WRITER`） |

dsh 现在做什么：

```
每轮结束 → 把这一轮（用户 + 助手正文 + 工具）追加到 L1.tmp/dsh.jsonl
         → 尝试拿钥匙（organize.lock）
             拿到：合并所有 temp 进 L1.json，按容量整理，写回六个文件
             拿不到：跳过，下一轮再来
每轮开始 → 读 L1.json + 所有 L1.tmp/*，拼成记忆块注入
```

---

## 2. 目标与边界

**必须做到**

1. astrbot 说的话，dsh 下一轮注入里能看到（带 `[astrbot·xxx]` 标记）
2. dsh 说的话，astrbot 下一轮能看到
3. 两端同时跑，谁都不丢数据

**第一阶段不做**

- astrbot 自己整理（摘要、路由、遗忘）——让 dsh 做，它已经实现了
- astrbot 的语义检索——先用"读 L1/L2/L3 拼上下文"就够

**第二阶段（等第一阶段跑稳）**

- astrbot 也拿钥匙整理（dsh 不在线时仍能沉淀）
- 共用向量、语义检索

---

## 3. 协议

### 3.1 目录

```
<数据目录>/
  L1.json                  真 L1（只有拿钥匙的一方写）
  L1.tmp/<writer>.jsonl    每端追加自己的当前轮
  L2.json  L3.json         L2 原话缓冲 / L3 摘要快照
  DL1.json DL2.json DL3.json  深层（流水 / 被引用的原文 / 摘要池）
  signals/<writer>.jsonl   attend / pin / forget 请求
  vectors/deep-part-0000.json  向量
  config.json              配置（dsh 写的，astrbot 只读）
  organize.lock            钥匙，平时不存在
```

`<writer>` 只允许 `[A-Za-z0-9_-]`，astrbot 用 `astrbot`。

### 3.2 条目的 JSON 结构

写入 L1 的行，最小字段如下（多写不报错，少写会丢信息）：

```json
{
  "id": "m5_1a_x9k2ab3f",
  "seq": 42,
  "text": "群里今天有人说想换个头像",
  "kind": "raw",
  "channel": "dialog",
  "layer": "L1",
  "speaker": "星鲸",
  "people": ["星鲸"],
  "scene": "QQ群·摸鱼",
  "importance": 0.5,
  "heat": 1,
  "lastMentionedAt": 1762056000000,
  "repeatStrength": 1,
  "fusionCount": 0,
  "recallCount": 0,
  "supersededBy": null,
  "createdAt": 1762056000000,
  "archivedAt": null,
  "spanFrom": null,
  "spanTo": null,
  "pinned": false,
  "archiveFile": null,
  "turnId": "astrbot-lq3k-1-a9f",
  "origin": "astrbot"
}
```

字段作用（哪些必须）：

| 字段 | 必须 | 说明 |
|---|---|---|
| `id` | ✅ | 全局唯一。格式建议 `m5_<base36 序号>_<4位时间36进>+<4位随机>`；多进程下必须带随机 |
| `text` | ✅ | 正文 |
| `createdAt` | ✅ | **毫秒**时间戳。排序、时间窗、热度衰减都靠它 |
| `origin` | ✅ | 谁写的（`astrbot`）。注入时的渠道标记和配额按它分 |
| `turnId` | ✅ | 一轮一个（同一轮所有行共用一个）。整理时按整轮取，不会把问答拆开 |
| `layer` | ✅ | 写 L1 就填 `"L1"` |
| `kind` | 建议 | `raw`（原文）/ `summary`（摘要）。astrbot 只写 raw |
| `channel` | 建议 | `dialog` / `action` / `event` / `note`，摘要按它分组 |
| `speaker` | 建议 | 说话人；群聊里是群成员名 |
| `scene` | 建议 | 场景（如 `QQ群·摸鱼`），检索可按场景过滤 |
| `importance` | 建议 | 0~1，astrbot 可以先固定 0.5（整理时会由模型重判） |
| `heat` / `lastMentionedAt` 等 | 可选 | 不写就用默认值，不影响读取 |

### 3.3 写入：只追加自己的 temp

```python
import json, time, random, string

def write_turn(dir_path, writer, rows, turn_id):
    """rows: [{"text":..., "speaker":..., "channel":..., "scene":...}]"""
    lines = []
    for r in rows:
        lines.append(json.dumps({
            "id": new_id(),
            "seq": next_seq(),
            "text": r["text"],
            "kind": "raw",
            "channel": r.get("channel", "dialog"),
            "layer": "L1",
            "speaker": r.get("speaker", ""),
            "people": r.get("people", []),
            "scene": r.get("scene", ""),
            "importance": r.get("importance", 0.5),
            "heat": 1,
            "createdAt": int(time.time() * 1000),
            "turnId": turn_id,
            "origin": writer,
        }, ensure_ascii=False))
    with open(f"{dir_path}/L1.tmp/{writer}.jsonl", "a", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
```

**四条硬规则**

1. **只写 `<自己>.jsonl`**，绝不碰 `L1.json` 或别人的 temp
2. **追加，不重写**（`"a"`）。追完立即关闭——Windows 上打开的文件没法被 rename
3. **UTF-8 无 BOM，行尾 `\n`**，一行一个 JSON，中文不转义（`ensure_ascii=False`）
4. 一轮一个 `turnId`

### 3.4 读取：L1.json + 所有 temp，按 id 去重

```python
def read_l1_view(dir_path):
    items, seen = [], set()
    for path in [f"{dir_path}/L1.json"] + glob.glob(f"{dir_path}/L1.tmp/*.jsonl"):
        if path.endswith("L1.json"):
            try:
                for it in json.load(open(path, encoding="utf-8")).get("items", []):
                    if it["id"] not in seen: seen.add(it["id"]); items.append(it)
            except FileNotFoundError:
                pass          # 首次运行没有这个文件，当空
        else:
            for line in open(path, encoding="utf-8", errors="ignore"):
                line = line.strip()
                if not line: continue
                try: it = json.loads(line)      # 可能读到半行（对方正在写）→ 跳过
                except json.JSONDecodeError: continue
                if it["id"] not in seen: seen.add(it["id"]); items.append(it)
    return items
```

注意：

- `L1.json` 可能不存在（首次），当空数组
- 可能读到半行 JSON（对方正在追加）→ **跳过那一行，不要整份放弃**
- 已经沉到 L2/DL 的条目 **不要**再当"刚发生的"注入；正常流程下 `L1.json` 里不会有它们（整理会清），崩溃后可能有，重复显示一条不影响数据

### 3.5 注入格式（和 dsh 保持一致）

```
## 一直记得的
- 10-02 [摘要] 主人最近在做肺结节竞赛，Dice 0.88
## 最近沉淀的
- 10-15 [dsh·user] 把 memory5 的分片逻辑抽出来之后…
## 刚发生的
- 11-02 [astrbot·星鲸] 群里今天有人说想换个头像
- 11-02 [dsh] 刚才把检索加了缓存
```

行格式：`- MM-DD [origin·speaker] 正文`；摘要行用 `[摘要]` 代替来源标记。

**L1 的分配顺序**：先放自己的（最多 `hotMaxChars × 0.7`），剩下的给另一方。
两端都按这个规则，各自的注入块才会稳定、不来回跳。

### 3.6 信号（可选，第二阶段）

想让自己"确认相关"的操作影响记忆（热度 +1、DL1 升回 L2），写信号而不是直接改文件：

```json
{"op": "attend", "ids": ["m5_xxx"], "opId": "astrbot-lq3k-1", "at": 1762056000000}
{"op": "pin", "ids": ["m5_xxx"], "v": true, "opId": "...", "at": ...}
{"op": "forget", "ids": ["m5_xxx"], "opId": "...", "at": ...}
```

写到 `signals/astrbot.jsonl`，整理者会认领并执行。`opId` 要唯一（用于防重放）。

### 3.7 向量（可选）

如果 astrbot 也要语义检索，必须满足：

- 嵌入模型和 dsh **完全一致**（默认 `BAAI/bge-m3`）
- 向量文件格式：`{ "<id>": "<base64 of Float32Array>" }`，写在 `vectors/deep-part-0000.json`
- `vectors/deep-meta.json` 里 `sig` 必须等于 `api:BAAI/bge-m3`

**第一阶段建议先不做**，用关键词就够了。

### 3.8 锁与整理（第二阶段）

如果 astrbot 也要整理（比如 dsh 没开）：

```
1. open('organize.lock', 'x') 创建成功 = 拿到钥匙
   写 {"pid":..., "writer":"astrbot", "at":..., "tab":"<随机token>", "phase":"start"}
2. 每 30 秒 utimes 一次心跳
3. 把 L1.tmp/*.jsonl rename 成 *.claimed-<ts>.jsonl（改名成功才算收下，失败就跳过）
4. 合并进 L1.json（按 id 去重）→ 整理 → 先写 L2/DL1/DL2/DL3，最后写 L1
5. 写盘前确认锁还是自己的（读 lock 的 tab 比对）
6. 删自己的锁（别删别人的）
```

细节照抄 `memory6.mjs` 的 `acquireLock` / `claimTemps` / `saveDb`。

---

## 4. 分阶段计划

| 阶段 | 做什么 | 验收 | 预估 |
|---|---|---|---|
| **A** | 只写 `L1.tmp/astrbot.jsonl` + 读 `L1.json` 拼进上下文 | 群里说一句，dsh 那边 `buildBlock()` 里出现 `[astrbot·xxx]` | 半天 |
| **B** | 把 `L2.json`、`L3.json` 也读进来（拼在 L1 前面） | astrbot 的上下文里出现 dsh 沉淀的摘要 | 2 小时 |
| **C** | 拿钥匙整理（摘要 + 路由 + 遗忘） | 只有 astrbot 在跑时，L1 也会溢出、也会产生摘要 | 2~3 天（要调模型） |
| **D** | 向量 + 语义检索 | astrbot 能搜到 dsh 记的内容（语义命中，不只是关键词） | 1~2 天 |

**先做 A。** 做完 A 就已经"互通"了，B 只是让上下文更完整。

---

## 5. 陷阱清单（都踩过）

1. **Windows rename 被打开的文件会失败**——写 temp 用 `with open(...)`，写完立即关闭
2. **同一个 writer 名 = 写同一个 temp**——astrbot 必须用 `astrbot`，不能和 dsh 都叫 `default`
3. **别直接改 `L1.json` / 别人的文件**——会被对方的整理覆盖（内存副本回写）
4. **时间戳必须是毫秒**，秒级会让热度衰减算错、时间窗检索失效
5. **ID 必须带随机**——两个进程的计数器都从 1 开始，纯序号必撞
6. **读 temp 可能读到半行**——逐行 try/except，跳过坏行
7. **两端的嵌入模型必须一致**（如果都做向量），否则余弦是在比两个不同空间
8. **`L1.tmp` 里可能有 `*.claimed-*`**——那是对方正在合并的，不要读、不要删
9. **`config.json` 是共享的**——astrbot 只读，不要写；`writer` 从环境变量或自己的配置取
10. **JSON 中文不要转义**（`ensure_ascii=False`），否则 dsh 显示成 `\uXXXX`

---

## 6. 验收清单

```
[ ] 只有 astrbot 在跑时，写 3 轮 → L1.tmp/astrbot.jsonl 有 9 行
[ ] 启动 dsh → buildBlock() 里出现这 3 轮（带 [astrbot·xxx]）
[ ] dsh 聊 2 轮 → astrbot 的注入块里出现 [dsh]
[ ] 两端同时各写 5 轮 → 合并后一条不少、没有重复 id
[ ] dsh 整理一次 → L1.tmp 清空，L1.json 里出现两端的条目
[ ] 整理后 astrbot 的 temp 也被认领了（不是只认领自己的）
```

---

## 7. 参考代码位置（`memory6.mjs`）

| 要抄什么 | 函数 | 大致位置 |
|---|---|---|
| 读层（带缓存） | `readLayer` / `readLayerCached` | 234 / 300 附近 |
| 原子写 | `atomicWrite` | 150 附近 |
| 写一轮 | `writeTurn` | 400 附近 |
| 读 L1 视图 | `readL1View` | 510 附近 |
| 认领 temp | `claimTemps` / `mergeTemps` | 290 / 600 附近 |
| 抢锁/心跳/校验 | `acquireLock` / `heartbeat` / `checkLock` | 480 附近 |
| 写回顺序 | `saveDb` | 620 附近 |
| 按轮取 | `pickTurnBatch` | 93 |
| 注入拼装 | `buildBlock` / `lineOf` | 1150 附近 |

条目字段的权威定义在 `memory5.mjs` 的 `makeItem`（200 行附近）。

---

## 8. 不要做的事

- ❌ 不要在 astrbot 里重写一套"六层记忆"——只做协议对接，逻辑留给 dsh
- ❌ 不要改 `memory6.mjs` 的格式来迁就 Python——格式是两端的契约，改一次两端都要跟
- ❌ 不要为了"简单"把 temp 改成一个大文件——并发写立刻出问题
- ❌ 不要先做向量——A 阶段用关键词就能验证互通，向量是最后一步

---

## 9. 开工前先确认

1. dsh 现在用的数据目录（`MEMORY_TIERS_DIR` 或默认 `~/.dsh/storages/memory-v5`）
2. dsh 的 `writer` 名（`config.json` 里）
3. astrbot 的 Python 版本与运行方式（有没有常驻事件循环、能不能拿到"一轮"的边界）
4. astrbot 侧要注入上下文的位置（系统提示词 / 历史前面 / 单独一条 user 消息）

第 4 点决定实现方式：**能追加一条 user 消息**最省事（和 dsh 一样），
如果要塞进系统提示词，得注意它会打断 prompt 缓存。
