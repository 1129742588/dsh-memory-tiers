/**
 * 历史压缩：把 dsh 自带的会话历史压成一条极短占位，内容归档进记忆系统。
 *
 * 为什么不接管 ctx.compaction：
 *   dsh 的 CompactionEngine 要求凑齐 compaction/start + summary + end 三件套，
 *   还要实现选区、tool 配对、并发锁、失败回滚；而它的摘要必须调 LLM（既慢又要钱）。
 *   这里改成：把 compaction-basic 的阈值调到永不触发（thresholdRatio 0.99），
 *   由插件自己在 turn 结束时直接做 surface 替换 —— 零 LLM、逻辑完全可控。
 *
 * 关键约束（踩过的坑）：
 *   - assistant/message 不能带 sourceEventSeqs（它内嵌 provider stream），
 *     所以替换节点只能用 user/message。
 *   - 选区必须结束在 user/message 之前，否则会把 tool/call 和 tool/result 切开。
 *   - startSeq/endSeq 是 surface 位置，不是数值区间（多次替换后高位 seq 会落到老位置）。
 */

/** 从一个事件里抽出可读文本（只取 text 块，reasoning 是草稿不进记忆） */
function eventText(ev) {
  const msg = ev?.data?.message ?? ev?.data
  const blocks = msg?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'tool_call' || b.type === 'tool-call') {
      const n = b.name || b.toolName || 'tool'
      const a = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? '')
      parts.push(`[调用 ${n} ${String(a).slice(0, 80)}]`)
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** 事件所属角色（用于归档时打标签） */
function eventRole(ev) {
  if (ev.type === 'user/message') return 'user'
  if (ev.type === 'assistant/message') return 'bot'
  if (ev.type === 'tool/result') return 'tool'
  return 'sys'
}

/**
 * 把 dsh 可见历史压成一条占位。
 *
 * @param {object} session  dsh 的 Session 实例（有 surface / eventAt / append）
 * @param {object} mem      createMemory5 的实例（只用到 writeMany）
 * @param {object} opts
 *   keepTurns  保留最近几轮原文（按 user/message 计数），默认 1
 *   archiveChars 单次归档最多写多少字，默认 1200
 *   log        日志
 * @returns {Promise<{compacted:boolean, removed:number, archived:number, reason?:string}>}
 */
export async function compactSurface(session, mem, opts = {}) {
  const keepTurns = Math.max(0, Number(opts.keepTurns ?? 1))
  const archiveChars = Math.max(100, Number(opts.archiveChars ?? 1200))
  const log = opts.log || console

  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || nodes.length < 2) {
    return { compacted: false, removed: 0, archived: 0, reason: 'empty' }
  }

  // ★ 选区起点必须跳过开头的 system/message。
  //   dsh 会拒绝：「node 0 holds the system prompt and may be rewritten only by
  //   a system/message over exactly that node」。系统提示词不属于可压缩范围。
  let first = 0
  while (first < nodes.length && session.eventAt(nodes[first])?.type === 'system/message') first++
  if (first >= nodes.length - 1) {
    return { compacted: false, removed: 0, archived: 0, reason: 'only-system' }
  }

  // 找所有「真实用户轮次」在 surface 里的位置。
  // ★ user/message 有四种来源，只有 source.kind === 'user' 是真人在说话：
  //     user           ← 真人
  //     runtime-context ← 运行时快照（工作目录、沙箱策略…）
  //     skill-catalog   ← 技能清单
  //     time-context    ← 时间快照
  //     compaction      ← 我们自己生成的占位
  //   把后四种算成"轮次"会让 keepTurns 完全失真（实测 6 轮被算成 13 轮）。
  const userIdx = []
  for (let i = first; i < nodes.length; i++) {
    const ev = session.eventAt(nodes[i])
    if (ev?.type !== 'user/message') continue
    const src = (ev.data?.message ?? ev.data)?.source
    if (src?.kind !== 'user') continue
    userIdx.push(i)
  }

  // 要留 keepTurns 轮 → 至少要 keepTurns+1 个 user 才有东西可压
  if (userIdx.length <= keepTurns) {
    return { compacted: false, removed: 0, archived: 0, reason: 'nothing-to-compact' }
  }

  // 选区 = [first, keepStart)，keepStart 是「保留的第一轮」的 user 位置
  const keepStart = userIdx[userIdx.length - keepTurns]
  if (keepStart <= first) {
    return { compacted: false, removed: 0, archived: 0, reason: 'nothing-to-compact' }
  }

  const sliceSeqs = nodes.slice(first, keepStart)
  const startSeq = sliceSeqs[0]
  const endSeq = sliceSeqs[sliceSeqs.length - 1]

  // ── 先把要丢的内容归档进记忆，写成功才动手丢 ──
  const lines = []
  let totalChars = 0
  let dropped = 0
  // ★ 只归档「真人在说」「模型在答」「工具结果」三类。
  //   surface 里还混着 runtime-context（工作目录/沙箱策略）、skill-catalog（技能清单）、
  //   time-context（时间快照）——这些是框架注入的，归档进去不仅没用，
  //   还会把注入块（含记忆块自身）原样抄进记忆，形成自我污染。
  const ARCHIVABLE = new Set(['user', 'model', 'tool'])
  for (const seq of sliceSeqs) {
    const ev = session.eventAt(seq)
    if (!ev) continue
    const src = (ev.data?.message ?? ev.data)?.source
    if (!ARCHIVABLE.has(src?.kind)) { dropped++; continue }
    const t = eventText(ev)
    if (!t) { dropped++; continue }
    const line = `${eventRole(ev)}: ${t}`
    if (totalChars + line.length > archiveChars) {
      // ★ 不能整段丢掉：至少保留能塞下的部分，否则归档变成一句「（还有 N 条略）」，
      //   这个 bug 在第一次上线时真实发生过（3 条空归档躺在 L1 里）。
      const room = archiveChars - totalChars
      if (room > 60) {
        lines.push(line.slice(0, room - 1) + '…')
        totalChars += room
      }
      dropped += sliceSeqs.length - lines.length
      break
    }
    lines.push(line)
    totalChars += line.length
  }
  if (dropped > 0 && lines.length) lines.push(`…（另有 ${dropped} 条系统注入或过长内容未收录）`)

  let archived = 0
  if (lines.length && mem?.writeMany) {
    try {
      const rounds = userIdx.filter((i) => i < keepStart).length
      const res = await mem.writeMany([{
        text: `[归档] 前 ${rounds} 轮对话（已被压缩出上下文）：\n${lines.join('\n')}`,
        speaker: 'archive',
        channel: 'dialog',
      }])
      archived = Array.isArray(res) ? res.length : 1
    } catch (err) {
      // ★ 归档失败就绝不压缩：宁可上下文大，也不能丢内容
      log.warn?.('[memory-tiers] 压缩前归档失败，放弃本次压缩：%s', err?.message ?? err)
      return { compacted: false, removed: 0, archived: 0, reason: 'archive-failed' }
    }
  }

  // ── 用一条 user/message 顶掉整段 ──
  const rounds = userIdx.filter((i) => i < keepStart).length
  const placeholder = `（此前 ${rounds} 轮对话已归档到长期记忆，需要细节可以让我检索）`
  try {
    session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: placeholder }],
      source: { kind: 'compaction', compactionId: `mem-tiers-${Date.now()}` },
    }, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: sliceSeqs,
    })
  } catch (err) {
    log.warn?.('[memory-tiers] 压缩替换失败：%s', err?.message ?? err)
    return { compacted: false, removed: 0, archived, reason: 'replace-failed' }
  }

  return { compacted: true, removed: sliceSeqs.length, archived }
}
