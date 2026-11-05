# 缓存无法复用：runtime-context 快照的落位问题

> 会话：`session-93b48022-85c3-4e99-bfdd-9ed98cac66a9`
> 取证时间：2026-11-05
> 相关方：`@deepseek-ai/dsh-agent-loop`（落位逻辑）、`dsh-memory-tiers`（注入与压缩）

---

## 一句话

`systemPrompt.context()` 合成的 runtime-context 快照，被 `dsh-agent-loop` **追加在本轮用户消息之后**。这段内容跨轮约 99% 相同（实测 8,118 字符），却永远排在一条每轮必变的消息后面，因此无法进入可复用前缀——每轮白白重算约 4,500 token。

---

## 一、现象

连续 5 轮，`cacheRead` 恒定 9088，`input`（未缓存部分）每轮约 5,400：

| turn | input（未缓存） | cacheRead | 间隔 |
| --- | --- | --- | --- |
| 1 | 5389 | 9088 | — |
| 2 | 5441 | 9088 | 11 小时 |
| 3 | 5416 | 9088 | 10 秒 |
| 4 | 5459 | 9088 | 65 秒 |
| 5 | — | 9088 | — |

对照组：11-04 的一次健康会话，`cacheRead` 每轮递增（12800 → 13184），未缓存仅约 600。

`input` 与间隔完全无关（10 秒和 11 小时结果一样）→ 不是缓存过期，是**前缀本身对不上**。

---

## 二、上下文的真实顺序（实测）

从 `session.v4.jsonl.zstd` 按 seq 还原，本轮请求里消息的排列是：

```
[系统提示] [占位符] [本轮用户消息] [runtime-context 快照] [skill-catalog] [time-context] [助手回复…]
                                     ↑
                          记忆块在这里，在本轮用户消息之后
```

对应日志（turn 1）：

```
seq  9  user            你好
seq 10  runtime-context ← 记忆块（8,118 字符）
seq 11  skill-catalog
seq 12  time-context
```

---

## 三、代码依据

### dsh 侧：快照是 append，且排在本轮消息之后

`dsh-agent-loop/lib/index.js`，`step()` 内（约 1066–1072 行）：

```js
let contextAdmitted = false;
if (firstAttempt) for (const message of decision.messages)
  if (message.source.kind === "runtime-context") {
    if (context !== void 0 && !contextAdmitted) {
      this.session.append("user/message", context, { surfaceOp: "append" });
      contextAdmitted = true;
    }
  } else this.session.append("user/message", message, { surfaceOp: "append" });
if (context !== void 0 && !contextAdmitted)
  this.session.append("user/message", context, { surfaceOp: "append" });
```

快照的生成处 `RuntimeContextProjection.project()`（约 338 行）：

```js
return createUserMessage({
  content: [{ type: "text", text: snapshot }],
  source: { kind: "runtime-context", form: "snapshot", sections },
});
```

要点：**落位方式是 `surfaceOp: "append"`（追加到 surface 末尾），且发生在本轮用户消息已经 append 之后**。所以快照永远只在"历史最尾"，且必然排在本轮用户消息后面。

### 插件侧：注入点

`core/index.mjs:982`：

```js
svc.context({ name: 'memory-tiers', order: 250, text: (asm) => buildInjectedBlock(asm), interpolate: false })
```

`status.json` 当前：`inject.mode = "context"`。

---

## 四、为什么这会让缓存归零

缓存按**前缀**匹配。相邻两轮的实际内容：

```
turn N   : [SYS][P][U_N][CTX_N][SK_N][T_N][A_N]
turn N+1 : [SYS][P][U_{N+1}][CTX_{N+1}][SK_{N+1}][T_{N+1}]
                       ↑ 从第一个不同处截断
```

- `SYS`（系统提示 + 37 个工具定义）不变 → 命中，约 9,088 token
- `P`（压缩占位符）文本恒定 → 命中，可忽略
- `U_N` vs `U_{N+1}` 必然不同 → **前缀在这里就断了**
- `CTX_N`（记忆块，8,118 字符，跨轮 99% 相同）排在 `U_N` **之后** → 永远进不了前缀

结果：`cacheRead` 恰好等于系统提示 + 工具定义的大小，与实测的 9,088 完全吻合。

如果快照排在用户消息**之前**：

```
turn N   : [SYS][P][CTX_N][U_N]...
turn N+1 : [SYS][P][CTX_{N+1}][U_{N+1}]...
                    ↑ 这里才断，且 99% 相同
```

前缀可延伸到记忆块的 99% 处，命中量从 9,088 提到约 13,500，每轮少算约 4,500 token。

---

## 五、需要 dsh 侧改动的地方（只有一处）

**把本轮 runtime-context 快照的 append 提前到 `decision.messages` 全部 append 之前。**

语义上：本轮快照是"这一轮的上下文前提"，应当排在本轮所有输入之前，而不是之后。

```js
// 现在：遍历 decision.messages 时遇到 runtime-context 才插入 → 排在本轮用户消息之后
// 期望：先 append context，再 append 本轮各条 message
if (firstAttempt && context !== void 0) {
  this.session.append("user/message", context, { surfaceOp: "append" });
  contextAdmitted = true;
}
for (const message of decision.messages) {
  if (message.source.kind === "runtime-context") continue;  // 旧的占位快照丢弃
  this.session.append("user/message", message, { surfaceOp: "append" });
}
```

### 这个改动的影响面

| 场景 | 影响 |
| --- | --- |
| 历史正常累积（不压缩） | **无影响**。两种顺序下，上一轮的快照都已经落在"上一轮末尾"，都在可复用前缀内 |
| 历史被整段替换（本会话） | **收益 +4,500 token/轮** |
| 语义正确性 | 提升。快照是"本轮上下文"，放在本轮输入之前更符合含义 |

所以这是一次纯增益改动，不会让任何现有场景变差。

---

## 六、边界说明

1. **这个改动不能解释全部未缓存量。** 本会话每轮未缓存约 5,400 token，其中约 4,500 是记忆块，剩余约 900 是本轮用户消息 + skill-catalog + time-context —— 那部分天然不可缓存。
2. **压缩本身仍会封顶。** 插件当前 `compaction.keepTurns = 0`，每轮把「第一个非 system 消息到末尾」整段替换成一行占位符（`core/index.mjs:219`，`surfaceOp: { op: 'replace' }`）。就算 dsh 改了落位，命中上限也就是「系统提示 + 占位符 + 记忆块」。要再往上，只能降低压缩频率。
3. **如果 dsh 认为快照必须排在用户消息之后**（例如为了让模型先看到问题、再看背景），请明确说明这个约束；那样的话本条作废，问题只剩插件侧压缩策略。

---

## 七、附：如何独立复核

```bash
# 1) 解出会话事件（zstd 多帧）
#    每帧以 28 B5 2F FD 开头，逐帧解压后按行解析
# 2) 取 usage：
#    turn/step + usage.prompt_tokens（未缓存） / prompt_cache_hit_tokens（命中）
# 3) 取 runtime-context 字符数：
#    事件 type=user/message 且 data.message.source.kind === 'runtime-context'
#    本会话 5 条，均为 8,000~8,300 字符
```

同源证据（11-04 已排除的两个方向）：

- 记忆块本身**不抖**：相邻三轮正文 99.3% 相同，只在尾部追加 L1 流水账
- `keepTurns` 调大**无效**：模拟 8 轮，稳态前缀复用率 keepTurns=0 → 47%、1 → 29%、3 → 8%（窗口每轮滑一格，断点位置不变，未缓存内容反而更多）

---

## 八、插件侧处理（1.3.1，不改宿主）

不修改 DSH `app.asar`，在插件自己的 `agent/pre-step` 监听里把 `decision.messages` 中的 `runtime-context` 快照稳定移到最前。DSH 的 loop 在遇到第一条 `source.kind === 'runtime-context'` 时插入快照，所以消息落地顺序变成：

```
system/message
  → 固定压缩锚点（普通模式；工作模式无）
  → runtime-context（人格 90 → 稳定环境段 100–200 → 记忆块 205 → web_surface 210）
  → user/message（本轮用户输入）
  → skill-catalog
  → time-context
```

- 人格 order 90；记忆块动态取 `WEB_SURFACE - 5`（通常 205），排在稳定环境段之后、端口/URL 块之前；
- 压缩占位改成固定文本「（历史已归档到长期记忆）」，不再带“此前 N 轮”，避免它成为变化点；
- 监听使用 `{ prepend: true }`，在其它 pre-step 监听之后执行，保证快照在所有消息之前；
- 未来 DSH 自己把快照提前时，快照已在最前，监听自动 no-op；
- 代价：DSH 的 runtime-context 是**一条原子快照**，工作目录/沙箱/审批等会随人格/记忆一起提前到用户消息之前；稳定环境段（100–200）放在记忆块之前，端口块（web_surface 210，约 62 字）放在记忆块之后——端口重启变化时不会连带丢掉整块记忆缓存，代价是这 62 字每轮不进缓存。沙箱/审批等变化仍会打断它后面的记忆块，但它们很少变。
- 技能目录是独立 `skill-catalog` 消息，排在用户消息之后；它按 `name + description` 的 digest 变化，改技能正文不会触发，约 1,576 字符。**1.3.1 追加：见第九节，它已被前置。**

---

## 九、技能目录前置（1.3.1 追加，2026-11-05 实测）

### 现象

第八节上线后普通轮仍有 611–704 token 未命中，而 `runtime-context` 相邻两轮的公共前缀已达 11,348 / 11,543 字，尾部只有约 200 字在变。差额只能来自 `runtime-context` 之外。

### 原因

`dsh-tool-skill` 在 `agent/pre-step` 里把目录 **append 到 `decision.messages` 末尾**（`tool-skill.js`：`[...decision.messages, catalog]`），落位在用户消息之后。用户消息每轮 1–208 字不等，目录的 token 起点随之漂移，1,576 字整段每轮重付。

拆账（c5a9b502 第 80 轮，实测 611 token）：

| 项 | 字符 | 说明 |
|---|---|---|
| L1 尾部新增 | 75 | 对话本身，不可省 |
| 提示行 + `</memory_context>` | 62 | 固定文本，但在 L1 之后 |
| 端口行 web_surface | 63 | 205 方案的固定代价 |
| 用户本轮消息 | 1–208 | 不可省 |
| **skill-catalog** | **1,576** | **约 450 token，占七成** |

「原生只有 200」是误判：93b48022 从第 7 轮起请求里**没有** `skill-catalog` 消息（`req 7 ← user:16 | runtime-context:710`），是目录不存在，不是目录命中。

### 处理

同一个 `agent/pre-step` 监听里，把 `source.kind === 'skill-catalog'` 的消息一并提到 `runtime-context` 之前：

```js
return { ...decision, messages: [...catalog, ...ctx, ...rest] }
```

落地顺序变为：

```
system/message → 压缩锚点 → skill-catalog → runtime-context（… 记忆块 205 …）→ user
```

目录前面只剩系统提示与工具定义（会话内恒定），因此整段命中。

### 实测结果

| 轮次 | 未命中 token | 说明 |
|---|---|---|
| 80 | 611 | 改动前 |
| 81–82 | 650 / 704 | 尚未重载 |
| 83 | 7,281 | 重启后首轮，端口行变更，整段失效一次 |
| **84** | **161** | 稳态 |

日志确认：`INJECT_ORDER skill-catalog-first count=1 chars=1576`。

剩余 161 token ≈ L1 新增 75 + 提示行/闭合 62 + 端口行 63 + 用户消息。继续压缩只剩两处：把提示行移到 L1 之前（省约 33 token/轮），或把记忆块改到 order 220（省端口行 16 token/轮，但每次重启要付整块 11,698 字，一天重启 ≥2 次即不划算）。

### 与宿主的关系

DSH 侧仍建议把目录改成 context section（order 150 左右）注入，这样不必依赖插件的消息重排；插件这次做的是等价的临时方案。宿主若将来自己前置，本段逻辑自动 no-op（`catalog` 为空时只剩原来的快照前置）。

