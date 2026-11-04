# 修会话：`lacks an identified message`

## 什么时候需要它

dsh 重启后打开某个会话时报：

```
历史加载失败：stored session "session-…" is corrupt:
failed validation: Error: session event at seq N lacks an identified message
```

原因：1.0.0 的历史压缩在追加「占位」时漏了 `data.id`。运行时内存里不校验，**落盘后重新打开**才校验
（dsh 的 `assertMessageEventShape` 要求 `user/message` 的 `data.id` 是非空字符串）。
**代码已经修了**（新占位带 id），但已经写坏的会话不会自愈——用这里的脚本补上。

## 步骤

1. **关掉 dsh**（会话文件可能被占用；不关的话脚本会写回失败并保留备份）。
2. 先只检查，看清要动多少：

   ```powershell
   node D:\Tempfile\dsh-memory-tiers\tools\repair-sessions.mjs
   ```

   输出示例（每行一个文件）：

   ```
   扫描 20 个会话文件（C:\Users\你\.dsh/sessions）
     ·  待修 1 条  session-1fa7e9ed…/session.v4.jsonl.zstd
     ·  待修 9 条  session-2bae71ec…/session.v4.jsonl.zstd
   共 7 个文件 / 26 条事件需要补 id。加 --apply 执行（先关 dsh）。
   ```

3. 确认数字对得上，再执行：

   ```powershell
   node D:\Tempfile\dsh-memory-tiers\tools\repair-sessions.mjs --apply
   ```

   每个被修改的文件都会先备份成 `session.v4.jsonl.zstd.bak-<时间戳>`，
   写回后脚本会**自己再解一遍**做校验（帧数、行数、JSON、每条消息都有 id）。

4. 重载插件，打开原来报错的会话。新会话再压缩一次也不会再产生坏占位（代码已修）。

## 它到底改了什么

- **只**给缺 id 的消息事件补 `id`（`user/message` 补在 `data.id`，其它类型补在 `data.message.id`）；
- 其它字段、其它事件**一律不动**；
- 没被改动的帧**原样保留字节**，只重新压缩被改的那几帧；
- 不碰 `~/.dsh/storages/session_projcache`（它是按 seq 派生的投影缓存，补 id 不改 seq）。

## 回滚

```powershell
Copy-Item '<会话文件>.bak-<时间戳>' '<会话文件>' -Force
```

## 边界

| 情况 | 行为 |
|---|---|
| 一帧都解不开（截断/损坏） | 整份跳过并报错，**不写**；原文件不动 |
| dsh 还开着，文件被占用 | 写回失败，报错并保留备份；关掉 dsh 再跑 |
| 已经修过 | 再跑是 0 条待修（幂等） |
| 别的会话文件也坏了（同样缺 id） | 一次全扫、全修；每个文件各自备份 |
