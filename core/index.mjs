/**
 * dsh-memory-tiers · dsh 适配层
 *
 * 只做「接线」，记忆逻辑在 memory.mjs，配置在 settings.mjs：
 *   ① 收：订阅 session/event，一轮结束把「问 / 答 / 工具」写进 L1
 *   ② 分 / 合 / 沉 / 忘：由 memory.organize() 做，这里只负责触发（端结束 + 定时器）
 *   ③ 喂：把记忆块交给 systemPrompt（context() 优先，section() 兜底）
 *   ④ 替：把 dsh 自己的历史压成一条占位（写成功才敢丢）
 *   ⑤ 页：注册 /dsh-memory/api/*（配置页的服务端）
 *   ⑥ 具：5 个 memory_* 工具 + /memory 命令
 *
 * ★ 装载必须分步：每一步单独 try/catch，失败写进插件日志和 status.json，
 *   绝不往外抛。上一版一个小服务名对不上就让整个插件被 dsh 回收，
 *   表现是「工具、注入、设置页全没了，但日志里只有成功记录」——查了一天。
 *   现在最坏的情况是少一个功能，其余照常工作。
 *
 * 关于「一层只做一件事」的顺序：写入 → 压缩 → 整理。
 *   写入失败就不压缩（否则历史丢了、记忆里也没有 = 真失忆）；
 *   整理是异步的，不挡下一轮输入。
 */

import {
  mkdirSync, writeFileSync, appendFileSync, renameSync, unlinkSync,
  existsSync, readdirSync, statSync, readFileSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createMemory } from './memory.mjs'
import { createLlm, createSessionCaller } from './llm.mjs'
import { layersFromMemory, buildPayload, renderHtml } from './star.mjs'
import {
  loadConfig, configPath, logPath, statusPath, contextPath, sessionsPath,
  resolveDataDir, toEngineCfg, toLlmCfg, installApi,
  loadSessions, saveSessions, resolveSessionMode, setSessionWorkMode,
  clearSessionExemption, recordSessionTurn, sessionStats,
  SCHEMA, getPath, setPath, isReloadPath,
} from './settings.mjs'

export const name = 'memory-tiers'

// 只声明「不接就什么都干不了」的那一个服务：
//   tools —— 不注入它，apply 根本不会被执行
// 其余（systemPrompt / webServer / commands）用「先 get，拿不到再 inject」的办法，
// 这样某个服务缺失只会少一个功能，不会让整个插件装不上。
export const inject = ['tools']

const LOG_MAX_BYTES = 1024 * 1024
const MAX_BUFFER_ROWS = 200
const MAX_BUFFER_CHARS = 200_000

// ============================================================
// 日志 / 状态（插件自己的，不依赖宿主日志）
// ============================================================

function makeAudit(env) {
  const p = logPath(env)
  return function audit(kind, detail = '') {
    const line = `${new Date().toISOString()} ${kind}${detail ? ' ' + String(detail).replace(/[\r\n]+/g, ' ') : ''}\n`
    try {
      mkdirSync(dirname(p), { recursive: true })
      if (existsSync(p) && statSync(p).size > LOG_MAX_BYTES) {
        try { renameSync(p, `${p}.1`) } catch { /* 轮转失败就继续追加 */ }
      }
      appendFileSync(p, line, 'utf8')
    } catch { /* 日志写不了不影响主流程 */ }
  }
}

function writeStatus(env, patch) {
  const p = statusPath(env)
  let cur = {}
  try { cur = JSON.parse(readFileSync(p, 'utf8')) || {} } catch { /* 首次 */ }
  const next = { ...cur, ...patch }
  // 值为 undefined 的键 = 删除（用于清掉上一轮留下的 stoppedAt 之类）
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]
  try {
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, p)
  } catch { /* 状态写不了没关系 */ }
  return next
}

// ============================================================
// 事件 → 文本
// ============================================================

/** 从 ContentBlock[] 里只取可见文本（reasoning 是草稿、image 是附件，都不进记忆） */
function takeText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks.trim() : ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

// ============================================================
// 历史压缩（第 7 步）
// ============================================================

/**
 * 算出「要替换掉哪一段」。
 *
 * 约束（破一条就会把对话切坏）：
 *   · 选区不能包含开头的 system/message（dsh 只允许系统提示词自己被系统消息改写）
 *   · 结束边界落在 user/message 之前（keepTurns>0 时），否则会把 tool/call 和
 *     tool/result 切开，下一次请求就出现「有调用没结果」
 *   · keepTurns=0 是显式支持的：整段替换（记忆完全替代历史），此时边界取 surface 末尾
 *
 * @returns {{startSeq:any, endSeq:any, slice:any[], rounds:number}|{reason:string}}
 */
export function planCompaction(nodes, eventAt, keepTurns) {
  if (!Array.isArray(nodes) || nodes.length < 2) return { reason: 'empty' }
  let first = 0
  while (first < nodes.length && eventAt(nodes[first])?.type === 'system/message') first++
  if (first >= nodes.length - 1) return { reason: 'only-system' }

  const userIdx = []
  for (let i = first; i < nodes.length; i++) {
    const ev = eventAt(nodes[i])
    if (ev?.type !== 'user/message') continue
    // user/message 有五种来源，只有 source.kind === 'user' 是真人在说话；
    // runtime-context / skill-catalog / time-context / compaction 都不算轮次。
    if ((ev.data?.message ?? ev.data)?.source?.kind !== 'user') continue
    userIdx.push(i)
  }

  const keep = Math.max(0, Math.trunc(Number(keepTurns) || 0))
  if (userIdx.length <= keep) return { reason: 'nothing-to-compact' }
  const keepStart = keep === 0 ? nodes.length : userIdx[userIdx.length - keep]
  if (keepStart <= first) return { reason: 'nothing-to-compact' }

  const slice = nodes.slice(first, keepStart)
  return {
    startSeq: slice[0],
    endSeq: slice[slice.length - 1],
    slice,
    rounds: userIdx.filter((i) => i < keepStart).length,
  }
}

/** 从一段 surface 里抽可归档的文本。只收真人说的 / 模型答的 / 工具结果 */
function archiveLines(session, sliceSeqs, maxChars) {
  const ARCHIVABLE = new Set(['user', 'assistant', 'model', 'tool', 'tool-result'])
  const lines = []
  let used = 0
  let dropped = 0
  for (const seq of sliceSeqs) {
    const ev = session.eventAt(seq)
    if (!ev) continue
    const msg = ev.data?.message ?? ev.data
    const kind = msg?.source?.kind ?? (ev.type === 'user/message' ? 'user' : ev.type === 'assistant/message' ? 'assistant' : 'tool')
    if (!ARCHIVABLE.has(kind)) { dropped++; continue }
    const text = takeText(msg?.content)
    if (!text) { dropped++; continue }
    const role = kind === 'user' ? '用户' : kind === 'assistant' || kind === 'model' ? '模型' : '工具'
    const line = `${role}：${text.replace(/\s+/g, ' ')}`
    if (used + line.length > maxChars) {
      const room = maxChars - used
      if (room > 60) { lines.push(line.slice(0, room - 1) + '…'); used += room }
      dropped += sliceSeqs.length - lines.length
      break
    }
    lines.push(line)
    used += line.length
  }
  return { lines, dropped }
}

/**
 * 把 dsh 的可见历史压成一条占位。
 *
 * 安全顺序（P0 修复的核心）：
 *   ① 先确认这段内容已经进了记忆（本轮 writeTurn 成功，或者这里归档成功）
 *   ② 才允许 surfaceOp: replace
 * 任何一步不成立 → 本轮不压缩，留痕 COMPACT_SKIP。
 */
export async function compactSurface(session, mem, opts = {}) {
  const audit = typeof opts.audit === 'function' ? opts.audit : () => {}
  const keepTurns = opts.keepTurns ?? 0
  const archiveChars = Math.max(100, Number(opts.archiveChars) || 1200)
  const alreadyArchived = opts.alreadyArchived === true

  const nodes = session?.surface?.nodes
  const plan = planCompaction(nodes, (s) => session.eventAt(s), keepTurns)
  if (plan.reason) return { compacted: false, reason: plan.reason }

  let archived = 0
  if (!alreadyArchived) {
    const { lines, dropped } = archiveLines(session, plan.slice, archiveChars)
    if (!lines.length) {
      // 这一段没有任何可归档的内容：宁可留着历史，也不做「删了但没记」
      audit('COMPACT_SKIP', `reason=no-archivable rounds=${plan.rounds} dropped=${dropped}`)
      return { compacted: false, reason: 'no-archivable' }
    }
    if (dropped > 0) lines.push(`…（另有 ${dropped} 条系统注入或过长内容未收录）`)
    const res = await mem.writeTurn([{
      text: `[归档] 前 ${plan.rounds} 轮对话（已被压缩出上下文）：\n${lines.join('\n')}`,
      speaker: 'archive',
      channel: 'dialog',
    }])
    if (!res?.ok) {
      audit('COMPACT_SKIP', `reason=archive-failed rounds=${plan.rounds}`)
      return { compacted: false, reason: 'archive-failed' }
    }
    archived = res.ids?.length || 0
  }

  const placeholder = `（此前 ${plan.rounds} 轮对话已归档到长期记忆，需要细节时检索即可）`
  try {
    session.append('user/message', {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: placeholder }],
      source: { kind: 'compaction', compactionId: `mem-tiers-${Date.now()}` },
    }, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: plan.slice,
    })
  } catch (e) {
    audit('COMPACT_SKIP', `reason=replace-failed ${e?.message ?? e}`)
    return { compacted: false, reason: 'replace-failed', archived }
  }
  audit('COMPACT_OK', `removed=${plan.slice.length} rounds=${plan.rounds} archived=${archived}`)
  return { compacted: true, removed: plan.slice.length, rounds: plan.rounds, archived }
}

// ============================================================
// /memory context：原样看模型这轮收到了什么
// ============================================================
// /memory context：看「模型这一轮到底收到了什么」
//
// 只报两件事：**系统提示有多少字**（不展开——它又长又基本不变），
// 然后把**其余消息原样全部打印**（用户 / 运行时上下文 / 助手 / 工具，一字不改）。
// 不列工具定义、不转储请求配置：那些东西对「记忆有没有进去 / 这轮到底说了什么」
// 没有帮助，只会把真正要看的内容顶出屏幕。
// ============================================================

function blockToText(b) {
  if (b == null) return ''
  if (typeof b === 'string') return b
  switch (b.type) {
    case 'text': return String(b.text ?? '')
    case 'reasoning': return `[思考] ${String(b.text ?? '').slice(0, 200)}`
    case 'image': return '[图片]'
    case 'file': return `[文件 ${b.name || b.filename || ''}]`
    case 'tool-call': {
      const a = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})
      return `调用 ${b.name || '?'}：${a}`
    }
    case 'tool-result': {
      const c = b.content ?? b.output ?? ''
      const out = typeof c === 'string' ? c : JSON.stringify(c)
      return `${b.isError ? '工具失败' : '工具结果'}：${out}`
    }
    default: return `[${b.type ?? '未知块'}]`
  }
}

function messageText(m) {
  const c = m?.content
  if (typeof c === 'string') return c
  return (Array.isArray(c) ? c : []).map(blockToText).join('\n')
}

/** 把消息原样展开（一行一条标题 + 正文），系统提示由调用方单独统计、不在这里 */
export function renderMessages(messages = []) {
  const out = []
  messages.forEach((m, i) => {
    const kind = m?.source?.kind ? ` · ${m.source.kind}` : ''
    const body = messageText(m)
    out.push(`【${i + 1}/${messages.length}】${m?.role || '?'}${kind} · ${body.length} 字`)
    out.push(body)
    out.push('')
  })
  return out.join('\n')
}

// ============================================================
// 主体
// ============================================================

/**
 * 插件入口。
 *
 * @param {object} ctx   dsh 的插件上下文
 * @param {object} [patchConfig] cordis 可能把 patch 里的 config 传进来；
 *   本插件的配置**只认配置文件**（<DSH_HOME>/memory-tiers/config.json），
 *   所以这里刻意不读它——免得「页面改了没生效」又多一条路径。
 */
export function apply(ctx, patchConfig = {}) {
  void patchConfig
  const env = process.env
  const audit = makeAudit(env)
  const boot = { startedAt: new Date().toISOString(), steps: {}, errors: [] }
  const t0 = Date.now()

  /** 一步一个坑：失败只记不炸（上一版就是炸了整个插件的命） */
  const step = (label, fn, fallback = null) => {
    try {
      const r = fn()
      boot.steps[label] = 'ok'
      audit('BOOT_OK', label)
      return r
    } catch (e) {
      boot.steps[label] = 'fail'
      boot.errors.push({ step: label, error: String(e?.message ?? e) })
      audit('BOOT_FAIL', `${label} ${e?.message ?? e}`)
      return fallback
    }
  }

  /**
   * 某个服务：先直接取，取不到再等它注入；两条路都失败就记一笔，不影响别的。
   * fn 收到 (ctx, 服务实例)——服务实例可能来自 ctx.get，也可能来自 inject 回调。
   */
  const withService = (serviceName, fn) => {
    let done = false
    const once = (c, svc) => {
      if (done) return
      done = true
      step(serviceName, () => fn(c, svc))
    }
    const fetchService = (c) => {
      try {
        if (typeof c?.get === 'function') return c.get(serviceName)
        return c?.[serviceName] ?? null
      } catch { return null }
    }
    try {
      const svc = fetchService(ctx)
      if (svc) { once(ctx, svc); return true }
    } catch { /* 没注册过，走 inject */ }
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject([serviceName], (c) => once(c, fetchService(c)))
        boot.steps[`inject:${serviceName}`] = 'waiting'
        // 看门狗：等太久还没来就记一笔。
        // 没有它，「设置页接口永远是 404」这种事就又要靠猜（上一版就是这样丢的）。
        const waitMs = Number(process.env.MEMORY_TIERS_BOOT_WAIT_MS) || 2000
        const timer = setTimeout(() => {
          if (done) return
          boot.steps[`inject:${serviceName}`] = 'missing'
          boot.errors.push({ step: serviceName, error: `等了 ${waitMs}ms 还没就绪` })
          audit('BOOT_MISSING', serviceName)
          writeStatus(env, { boot })
        }, waitMs)
        if (timer.unref) timer.unref()
        return true
      }
    } catch (e) {
      boot.errors.push({ step: `inject:${serviceName}`, error: String(e?.message ?? e) })
      audit('BOOT_FAIL', `inject:${serviceName} ${e?.message ?? e}`)
    }
    boot.errors.push({ step: serviceName, error: '服务不可用' })
    audit('BOOT_MISSING', serviceName)
    return false
  }

  // ── ① 配置 ──
  const loaded = step('config', () => loadConfig({ env, log: audit }), null)
  // runCfg = 运行中实际生效的配置：热改字段保存后就地替换，需重载字段保留旧值。
  let runCfg = loaded?.config || loadConfig({ env, log: () => {} }).config
  const dataDir = resolveDataDir(runCfg, env)
  const writer = String(runCfg.writer || 'dsh')

  // ── ①.5 会话状态（工作模式按会话 + 接管豁免）──
  const sessionState = step('sessions', () => loadSessions({ env, log: audit }), {
    version: 1, updatedAt: 0, sessions: {}, path: sessionsPath(env),
  })
  let sessionsTimer = null
  const flushSessions = () => {
    if (sessionsTimer) { clearTimeout(sessionsTimer); sessionsTimer = null }
    saveSessions(sessionState, { env, log: audit })
  }
  const scheduleSessions = () => {
    if (sessionsTimer) return
    sessionsTimer = setTimeout(() => { sessionsTimer = null; saveSessions(sessionState, { env, log: audit }) }, 1000)
    if (sessionsTimer.unref) sessionsTimer.unref()
  }

  const globalWorkDefault = () => runCfg.workMode?.enabled === true
  const modeOf = (sid) => resolveSessionMode(sessionState, sid, globalWorkDefault())
  const isWorkLike = (sid) => {
    const m = modeOf(sid)
    return m === 'work' || m === 'exempt'
  }
  /** 共享 L1：只要有一个会话处于工作模式/已豁免，就启用工作模式的大容量 */
  const anyWorkLike = () => {
    if (globalWorkDefault()) return true
    for (const sid of Object.keys(sessionState.sessions || {})) if (isWorkLike(sid)) return true
    return false
  }
  const sessionModeLabel = (sid) => {
    const mode = modeOf(sid)
    if (mode === 'work') return '工作模式'
    if (mode === 'exempt') return '工作模式 · 已豁免'
    const inject = runCfg.inject?.enabled !== false
    const compaction = runCfg.compaction?.enabled !== false
    return inject && compaction ? '记忆接管' : '普通'
  }
  if (globalWorkDefault()) audit('WORK_MODE', 'global-default=on')

  // ── ①.8 人格槽位 ──
  // 配置正文 + 其它插件注册的片段；按 (order, id) 确定性拼接，逐字稳定。
  // 关掉 persona.enabled 时两者都不生效；空文本不产生任何注入。
  const personaParts = new Map()
  const personaApi = {
    register({ id, order = 100, text } = {}) {
      const key = String(id || '').trim()
      const body = String(text || '').trim()
      if (!key || !body) throw new Error('persona.register 需要非空 id 与 text')
      const part = { id: key, order: Number.isFinite(Number(order)) ? Number(order) : 100, text: body }
      personaParts.set(key, part)
      return () => { if (personaParts.get(key) === part) personaParts.delete(key) }
    },
    list() {
      const cmp = (a, b) => (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      return [...personaParts.values()].map((x) => ({ ...x })).sort(cmp)
    },
  }
  try { ctx.provide?.('memoryTiersPersona', personaApi) } catch (e) {
    boot.errors.push({ step: 'persona-api', error: String(e?.message ?? e) })
    audit('BOOT_FAIL', `persona-api ${e?.message ?? e}`)
  }
  function personaText() {
    if (runCfg.persona?.enabled === false) return ''
    const parts = []
    const own = String(runCfg.persona?.text || '').trim()
    if (own) parts.push({ id: 'config', order: 0, text: own })
    for (const p of personaApi.list()) parts.push(p)
    const out = parts.map((p) => p.text.trim()).filter(Boolean).join('\n\n')
    if (out.length <= 8000) return out
    audit('PERSONA_TRUNCATED', `${out.length}→8000`)
    return out.slice(0, 8000)
  }

  // ── ② 引擎 + 模型 ──
  const session = createSessionCaller(() => ctx, { log: (k, d) => audit(k, d) })
  const llm = step('model', () => createLlm({
    ...toLlmCfg(runCfg),
    getSession: () => {
      const info = session.info()
      return info.available ? { ...info, call: session.call } : info
    },
    // 人格只在分流/分类时作为临时 system 前缀；读运行中配置，默认关。
    getPersona: () => personaText(),
    personaInSummary: () => runCfg.persona?.inSummary === true,
    onLog: (kind, detail) => audit(kind, detail),
  }), null)

  const caps = (() => {
    try { return llm?.capabilities?.() ?? {} } catch { return {} }
  })()

  // 向量指纹：换 embed 模型后旧向量不可比较，要能被识别出来（不是静默变乱）
  const embedSig = caps.embed ? `api:${caps.embedModel || 'unknown'}` : 'none'

  let engineCfg = toEngineCfg(runCfg, { workMode: anyWorkLike() })
  const mem = step('memory', () => {
    mkdirSync(dataDir, { recursive: true })
    relocateLegacyFiles(dataDir, audit)
    return createMemory({
      dir: dataDir,
      writer,
      logFile: logPath(env),
      embedSignature: embedSig,
      cfg: engineCfg,
      ...(caps.embed ? { embed: (t) => llm.embed(t) } : {}),
      ...(caps.rerank ? { rerank: (q, d) => llm.rerank(q, d) } : {}),
      ...(caps.summary ? {
        summarizeWithSources: (lines, ch, folks, hint, opts) => llm.summarizeWithSources(lines, ch, folks, hint, opts),
      } : {}),
      ...(caps.chat ? {
        classify: (t) => llm.classify(t),
        classifyBatch: (t) => llm.classifyBatch(t),
        judgeRelation: (a, b) => llm.relation(a, b),
      } : {}),
    })
  }, null)

  if (!mem) {
    // 引擎起不来就没什么可做的了：把原因写清楚，别静默
    audit('BOOT_DEGRADED', 'memory engine unavailable')
    writeStatus(env, { loadedAt: boot.startedAt, boot, dataDir, configPath: loaded?.path ?? configPath(env) })
    return
  }

  const stats = () => { try { return mem.stats() } catch { return null } }
  // 抓取截断：普通模式与工作模式两套；工作模式按会话取，豁免会话也用工作模式那套。
  const normalCap = () => ({
    user: Number(runCfg.capture?.userChars) || 2000,
    bot: Number(runCfg.capture?.botChars) || 400,
    tool: Number(runCfg.capture?.toolChars) || 500,
  })
  const workCap = () => ({
    user: Number(runCfg.workMode?.userChars) || 4000,
    bot: Number(runCfg.workMode?.botChars) || 800,
    tool: Number(runCfg.workMode?.toolChars) || 1200,
  })
  const capFor = (sid) => (isWorkLike(sid) ? workCap() : normalCap())
  // 配置页接口：挂载后记下端口（dsh 的 webServer 有 get port()，listen 之后才有值），
  // 取证工具靠 status.json 里的 baseUrl 自动找到它（端口每次重启都会变）。
  let api = null
  let webServerSvc = null
  const apiPort = () => {
    try { return Number(webServerSvc?.port) || null } catch { return null }
  }
  const apiInfo = () => {
    const port = apiPort()
    return { mounted: api?.mounted || [], port, baseUrl: port ? `http://127.0.0.1:${port}` : null }
  }
  // 状态接口每几秒被页面拉一次，stats() 只算一次（它会读 5 层 + 两个目录）
  const runState = () => {
    const s = stats()
    return {
      loadedAt: boot.startedAt,
      configPath: loaded?.path ?? configPath(env),
      dataDir,
      writer,
      layers: s ? { count: s.count, chars: s.chars, bytes: s.bytes } : null,
      pending: s?.pending ?? null,
      vectors: s?.vectors ?? null,
      lock: s?.lock ?? null,
      last: s?.last ?? null,
      boot: { steps: boot.steps, errors: boot.errors },
      capabilities: caps,
      // 四个阶段各自实际用什么（页面开头一眼看清；问题 3 的根因就是这里缺了它）
      stages: (() => {
        const names = ['summary', 'chat', 'embed', 'rerank']
        const out = {}
        for (const n of names) {
          try { out[n] = llm.resolveStage(n) } catch { out[n] = null }
        }
        return out
      })(),
      workMode: {
        enabled: globalWorkDefault(),
        perSession: true,
        hotChars: engineCfg.hotMaxChars,
        consolidateChars: engineCfg.consolidateMaxChars,
        capture: { ...workCap() },
        captureNormal: { ...normalCap() },
        sessions: sessionStats(sessionState),
      },
      persona: { enabled: runCfg.persona?.enabled !== false, chars: personaText().length, inSummary: runCfg.persona?.inSummary === true },
      sessions: sessionStats(sessionState),
      api: apiInfo(),
      star: { url: apiPort() ? `http://127.0.0.1:${apiPort()}/dsh-memory/star` : null },
      session: (() => { try { return session.info() } catch { return null } })(),
      config: {
        inject: runCfg.inject.enabled !== false,
        injectReason: injection.reason,
        capture: runCfg.capture.enabled !== false,
        compaction: { enabled: runCfg.compaction.enabled !== false, keepTurns: Number(runCfg.compaction.keepTurns) || 0 },
      },
    }
  }

  // ── ③ 工具 ──
  const textRender = (_args, value) => [{ type: 'text', text: String(value ?? '') }]
  const output = { schema: {}, render: textRender }
  const tools = [
    {
      name: 'memory_write',
      description:
        '把值得长期记住的信息写入记忆。适用于：用户的偏好/习惯、已确定的决定、'
        + '项目背景、踩过的坑与结论。不要用来记临时性的中间过程。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '一条独立可读的结论，别用代词' },
          importance: { type: 'number', description: '0~1，默认由模型判断；用户明确强调的给 0.8 以上' },
          channel: { type: 'string', description: 'dialog / action / event，默认 dialog' },
        },
        required: ['text'],
      },
      output,
      async execute(args = {}) {
        const text = String(args.text || '').trim()
        if (!text) return '写入失败：text 不能为空'
        const r = await mem.write({
          text,
          speaker: 'user',
          channel: args.channel || 'dialog',
          importance: Number.isFinite(Number(args.importance)) ? Number(args.importance) : null,
        })
        return r?.ok ? `已记住 [${r.ids?.[0] || '?'}]（L1）` : `写入失败：${r?.error || '未知原因'}`
      },
    },
    {
      name: 'memory_search',
      description:
        '检索长期记忆。当用户提到过去聊过的事、旧约定、项目历史时调用。'
        + 'depth：summary（只搜摘要，默认）/ detail（摘要+原文）/ full（再加流水账）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词或短句，别写整段问题' },
          depth: { type: 'string', description: 'summary / detail / full，默认 summary' },
          limit: { type: 'number', description: '返回条数，默认 6' },
        },
        required: ['query'],
      },
      output,
      async execute(args = {}) {
        const q = String(args.query || '').trim()
        if (!q) return '检索失败：query 不能为空'
        const r = await mem.search(q, {
          depth: args.depth || 'summary',
          limit: Math.min(20, Number(args.limit) || 6),
        })
        if (!r.hits.length) return '没有找到相关记忆。'
        const lines = r.hits.map((h) => `- [${h.id}] (${h.layer} ${h.when}) ${h.text}`)
        lines.push('', `（${r.advice}）`)
        lines.push('（确认这些确实相关后，请调用 memory_attend 传 id 列表；只搜到不算数）')
        return lines.join('\n')
      },
    },
    {
      name: 'memory_attend',
      description:
        '确认哪些检索结果真的相关。被确认的记忆热度 +1，冷层条目会回到观察层。'
        + '搜到但不调用它，热度不会涨——这是防止回音室的设计。',
      parameters: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' }, description: '相关的记忆 id 列表' } },
        required: ['ids'],
      },
      output,
      async execute(args = {}) {
        const ids = Array.isArray(args.ids) ? args.ids : (args.ids ? [args.ids] : [])
        if (!ids.length) return '没有提供 id'
        const n = mem.attend(ids)
        return `已提交 ${n} 条关注（下次整理生效）`
      },
    },
    {
      name: 'memory_forget',
      description: '删除一条记错的记忆。发现记忆与用户实际说法冲突时，先 forget 再 write，不要硬留。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '要删除的记忆 id' } },
        required: ['id'],
      },
      output,
      async execute(args = {}) {
        if (!args.id) return '删除失败：id 不能为空'
        mem.forget(String(args.id))
        return `已提交删除 ${args.id}（下次整理生效）`
      },
    },
    {
      name: 'memory_stats',
      description: '查看六层记忆分布、调用统计和待整理队列。排查"为什么它想不起来"时先调这个。',
      parameters: { type: 'object', properties: {} },
      output,
      async execute() {
        const s = stats()
        if (!s) return '记忆系统未就绪。'
        const layers = Object.entries(s.count).map(([k, v]) => `${k}=${v}`).join(' ')
        const calls = Object.entries(s.calls || {})
          .filter(([, v]) => v && v.rounds)
          .map(([k, v]) => `${k}:${v.rounds}`)
          .join(' ')
        return [
          `总条数 ${s.total} · 向量 ${s.vectors}`,
          `分层 ${layers}`,
          `待整理 ${s.pending ?? 0} 条 · 调用 ${calls || '（无）'}`,
          `整理 ${s.lock?.held ? `进行中（${s.lock.owner || '?'}）` : '空闲'}`,
          `数据目录 ${dataDir}`,
        ].join('\n')
      },
    },
  ]

  step('tools', () => {
    let n = 0
    for (const t of tools) {
      try { ctx.tools.register(t); n++ } catch (e) {
        boot.errors.push({ step: `tool:${t.name}`, error: String(e?.message ?? e) })
        audit('BOOT_FAIL', `tool:${t.name} ${e?.message ?? e}`)
      }
    }
    boot.steps.tools = `ok(${n})`
    return n
  })

  // ── ④ 抓取：session/event → L1 ──
  const captureEnabled = () => runCfg.capture?.enabled !== false
  const buffers = new Map()

  // 相关旧事（可选）：注入走的是同步取值，而检索是异步的。
  // 所以收到用户消息时先起一次检索，注入时读已经完成的结果；带 TTL，
  // 免得把隔夜的话题塞进这一轮。配置热改时这里每次现读。
  const semanticOn = () => runCfg.capture?.semantic?.enabled === true && !!caps.embed
  const semanticCfg = () => ({
    topK: Number(runCfg.capture?.semantic?.topK) || 5,
    minSim: Number(runCfg.capture?.semantic?.minSim) ?? 0.35,
    ttlMs: (Number(runCfg.capture?.semantic?.ttlMin) || 3) * 60 * 1000,
  })
  let semCache = { text: '', at: 0 }
  let semBusy = false

  function prefetchSemantic(query) {
    if (!semanticOn() || semBusy) return
    const q = String(query || '').trim()
    if (!q) return
    const sc = semanticCfg()
    semBusy = true
    Promise.resolve()
      .then(() => mem.search(q.slice(0, 200), { limit: sc.topK }))
      .then((res) => {
        const keep = (res?.hits || []).filter((h) => Number(h.rel ?? h.score ?? 0) >= sc.minSim)
        semCache = keep.length
          ? { text: ['## 相关的旧事', ...keep.map((h) => `- ${h.when} [${h.layer}] ${String(h.text).replace(/\s+/g, ' ')}`)].join('\n'), at: Date.now() }
          : { text: '', at: 0 }
      })
      .catch((e) => { audit('SEMANTIC_FAIL', String(e?.message ?? e)); semCache = { text: '', at: 0 } })
      .finally(() => { semBusy = false })
  }

  const semanticExtra = () => {
    if (!semanticOn() || !semCache.text) return null
    if (Date.now() - semCache.at > semanticCfg().ttlMs) return null
    return semCache.text
  }

  const bufOf = (sid) => {
    if (!buffers.has(sid)) buffers.set(sid, { user: [], bot: [], tools: new Map(), chars: 0, cwd: '' })
    return buffers.get(sid)
  }

  const writeRows = async (rows, stat) => {
    if (!rows.length) { audit('WRITE_TURN_SKIP', `user=${stat.user} bot=${stat.bot} tool=${stat.tool}`); return false }
    const res = await mem.writeTurn(rows)
    const l1 = stats()?.count?.L1 ?? '?'
    if (res?.ok) {
      audit('WRITE_TURN', `user=${stat.user} bot=${stat.bot} tool=${stat.tool} rows=${rows.length} L1=${l1}`)
      return true
    }
    audit('WRITE_TURN_FAIL', `${res?.error || 'unknown'} rows=${rows.length}`)
    return false
  }

  const tidy = (s) => String(s || '')
    .replace(/```[\s\S]*?```/g, '[代码]')
    .replace(/\s+/g, ' ')
    .trim()

  /**
   * 工作模式骨架：一条轮次只留「地点 / 事件 / 做了什么 / 结论」。
   * 时间由条目 createdAt 承载（注入与摘要都会渲染日期时间），不重复写进正文。
   */
  const makeSkeletonRows = (buf, { sid, at }) => {
    const sk = runCfg.workMode?.skeleton || {}
    const userChars = Math.max(20, Number(sk.userChars) || 240)
    const botChars = Math.max(20, Number(sk.botChars) || 200)
    const userText = tidy(buf.user.join(' ')).slice(0, userChars)
    const botText = tidy(buf.bot[buf.bot.length - 1] || buf.bot.join('\n')).slice(0, botChars)
    const tools = [...buf.tools.values()].map((c) => {
      const head = c.err ? '失败' : (c.done ? '完成' : '未完成')
      return `${c.name} ${head}`
    })
    const place = buf.cwd ? `@${basename(buf.cwd)} ` : ''
    const bits = [`${place}用户提出：${userText || '（本轮没有文字请求）'}`]
    if (tools.length) bits.push(`做了什么：${tools.join('、')}`)
    if (botText) bits.push(`结论（模型）：${botText}`)
    const turnId = `${writer}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    audit('SKELETON', `session=${sid} chars=${bits.join(' ').length} tools=${tools.length}`)
    return [{
      text: bits.join('；'),
      speaker: 'user', channel: 'event', scene: 'work', turnId,
    }]
  }

  const makeRows = (buf, { sid, at } = {}) => {
    const turnId = `${writer}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const workLike = isWorkLike(sid)
    if (workLike && runCfg.workMode?.skeleton?.enabled !== false) {
      return makeSkeletonRows(buf, { sid, at: at || Date.now() })
    }
    const cap = capFor(sid)
    const rows = []
    for (const t of buf.user) rows.push({ text: t, speaker: 'user', channel: 'dialog', scene: workLike ? 'work' : 'dsh', turnId })
    if (buf.bot.length) {
      const botText = buf.bot.join('\n').trim()
      if (botText) rows.push({ text: botText.slice(0, cap.bot), speaker: 'bot', channel: 'dialog', scene: workLike ? 'work' : 'dsh', turnId })
    }
    for (const c of buf.tools.values()) {
      const out = c.done ? (c.out || '（无输出）') : '（被中断，无结果）'
      const head = c.err ? '失败' : (c.done ? '完成' : '未完成')
      rows.push({
        text: `运行 ${c.name}「${String(c.args || '').slice(0, 120)}」→ ${head}：${out}`,
        speaker: 'bot', channel: 'action', scene: workLike ? 'work' : 'dsh', turnId,
      })
    }
    return rows
  }

  /** 压缩：单飞 + 只在本轮已进 L1 时才做 */
  let compacting = false
  const compactTurn = async (sessionObj, { alreadyArchived }) => {
    const sid = sessionObj?.id || 'default'
    const mode = modeOf(sid)
    // 工作模式 / 已豁免：会话表现保持正常 —— 历史一点都不动
    if (mode === 'work' || mode === 'exempt') {
      audit('COMPACT_SKIP', `reason=session-${mode}`)
      return null
    }
    if (runCfg.compaction.enabled === false) return null
    if (!sessionObj) return null
    if (runCfg.inject.enabled === false && (Number(runCfg.compaction.keepTurns) || 0) === 0) {
      // 历史全替 + 不注入 = 模型什么都看不到，宁可不替
      audit('COMPACT_SKIP', 'reason=inject-disabled')
      return null
    }
    // 兜底：全替之前确认「记忆块」真的不是空的（没模型、库是空的、全在 DL1 等模型时，
    // 替掉历史就等于让模型失忆）。
    if ((Number(runCfg.compaction.keepTurns) || 0) === 0) {
      let block = ''
      try { block = mem.buildBlock(Number(runCfg.inject.maxChars) || 0, {}) } catch { block = '' }
      if (!block) { audit('COMPACT_SKIP', 'reason=no-context'); return null }
    }
    if (compacting) return null
    compacting = true
    try {
      return await compactSurface(sessionObj, mem, {
        keepTurns: Number(runCfg.compaction.keepTurns) || 0,
        archiveChars: Number(runCfg.compaction.archiveChars) || 1200,
        alreadyArchived,
        audit,
      })
    } finally {
      compacting = false
    }
  }

  const flushBuffer = async (sid) => {
    const buf = buffers.get(sid)
    if (!buf) return false
    buffers.delete(sid)
    const rows = makeRows(buf, { sid, at: Date.now() })
    return writeRows(rows, { user: buf.user.length, bot: buf.bot.length, tool: buf.tools.size })
  }

  const captureOff = step('capture', () => {
    if (typeof ctx.on !== 'function') throw new Error('ctx.on 不可用')
    if (!captureEnabled()) audit('CAPTURE_OFF')

    const handler = (sessionObj, event) => {
      const d = event?.data || {}
      const sid = sessionObj?.id || 'default'
      if (!captureEnabled()) {
        // 关掉自动记录：不要留着半轮缓冲；下次打开后从新轮次开始
        if (event.type === 'turn/end') buffers.delete(sid)
        return
      }
      const buf = bufOf(sid)
      const cwd = sessionObj?.header?.cwd || sessionObj?.cwd
      if (cwd) buf.cwd = cwd

      if (event.type === 'user/message') {
        // 只记真人输入：agent.inject / skill / cron 也走这个事件，但它们 source.kind 不是 'user'
        if (d.source?.kind !== 'user') return
        const t = takeText(d.content)
        if (!t) return
        buf.user.push(t.slice(0, capFor(sid).user))
        buf.chars += t.length
        prefetchSemantic(t.slice(0, 200))
        return
      }

      if (event.type === 'assistant/message') {
        // 一轮里可能有多条（工具循环），先全收，turn/end 时拼起来再截断
        const t = takeText(d.content ?? d.message?.content)
        if (t) { buf.bot.push(t); buf.chars += t.length }
        return
      }

      if (event.type === 'tool/call') {
        const cid = d.callId ?? d.id ?? d.message?.toolCallId
        if (cid) buf.tools.set(cid, { name: String(d.name || 'tool'), args: String(d.arguments ?? '') })
        return
      }

      if (event.type === 'tool/result') {
        // callId / isError 在 message 里，不在 data 顶层（踩过：写成 d.callId 会让所有 action 静默消失）
        const cid = d.callId ?? d.message?.toolCallId ?? d.message?.source?.callId
        const c = cid ? buf.tools.get(cid) : undefined
        if (c) {
          c.out = takeText(d.message?.content).slice(0, capFor(sid).tool)
          c.err = !!(d.isError ?? d.message?.isError)
          c.done = true
        }
        return
      }

      if (event.type !== 'turn/end') return

      // 缓冲上限：被遗弃的会话不该无限涨
      if (buf.chars > MAX_BUFFER_CHARS || buf.user.length + buf.bot.length + buf.tools.size > MAX_BUFFER_ROWS) {
        audit('BUFFER_TRUNCATED', `session=${sid} chars=${buf.chars}`)
        buf.user.length = Math.min(buf.user.length, 50)
      }

      // 确实产生过真人轮次才记 turns；工作模式/已豁免时置 everWorked（豁免的依据）。
      // 写在压缩之前：即使写 L1 失败，这个会话的历史也不该被压掉。
      if (buf.user.length > 0) {
        const rec = recordSessionTurn(sessionState, sid, { wasWorkLike: isWorkLike(sid) })
        if (rec) scheduleSessions()
      }

      const rows = makeRows(buf, { sid, at: Date.now() })
      const stat = { user: buf.user.length, bot: buf.bot.length, tool: buf.tools.size }
      buffers.delete(sid)

      Promise.resolve()
        .then(async () => {
          const ok = await writeRows(rows, stat)
          // 写入没成功就不压缩：历史丢了、记忆里又没有 = 真失忆
          if (!ok) return
          await compactTurn(sessionObj, { alreadyArchived: true })
        })
        .catch((e) => audit('WRITE_TURN_FAIL', String(e?.message ?? e)))
        // 端结束顺手试一次整理（拿不到钥匙会自己跳过；没有变化不会重写文件）
        .then(() => { Promise.resolve().then(() => mem.organize()).catch(() => {}) })
    }

    const off = ctx.on('session/event', handler)
    audit('CAPTURE_ON', `normal=${JSON.stringify(normalCap())} work=${JSON.stringify(workCap())}`)
    return () => { try { off?.() } catch { /* 已卸 */ } }
  })

  // ── ⑤ 注入 ──
  // injection.reason：最近一次没注入的原因（work-mode / session-exempt / inject-disabled），页面和 /memory 用得到
  const injection = { mode: 'none', ok: false, reason: null }

  const sidFromAssembly = (asm) => {
    const id = asm?.agent?.session?.id ?? asm?.agent?.sessionId ?? asm?.sessionId ?? null
    return id ? String(id) : null
  }

  /**
   * 本轮会注入的记忆块（插件自己按当前库实时构建）。
   *
   * ★ 为什么不从 deriveMessages() 里找：dsh 的 systemPrompt.context() 贡献会被合成
   *   一条 runtime-context 消息，由 agent-loop **在请求组装时**才追加；
   *   而命令执行在组装之前，加上 keepTurns=0 的压缩把上一轮快照替换成了占位，
   *   所以会话消息里必然看不到本轮的块。要「看注入内容」只能自己构建。
   */
  const buildInjectedBlock = (asm = null, forcedSid = null) => {
    const sid = forcedSid || sidFromAssembly(asm)
    const mode = sid ? modeOf(sid) : (globalWorkDefault() ? 'work' : 'normal')
    if (mode === 'work') { injection.reason = 'work-mode'; return '' }
    if (mode === 'exempt') { injection.reason = 'session-exempt'; return '' }
    if (runCfg.inject.enabled === false) { injection.reason = 'inject-disabled'; return '' }
    injection.reason = null
    try {
      return mem.buildBlock(Number(runCfg.inject.maxChars) || 0, {
        notice: Number(runCfg.compaction.keepTurns) === 0 && runCfg.compaction.enabled !== false
          ? '（当前会话的对话历史已由记忆替代；需要原话细节请调用 memory_search）'
          : '',
        extra: semanticExtra(),
      })
    } catch (e) {
      audit('INJECT_FAIL', String(e?.message ?? e))
      return ''
    }
  }

  const injectBlock = (c, svcArg) => {
    const svc = svcArg || c?.systemPrompt || ctx.systemPrompt
    if (!svc) throw new Error('没有 systemPrompt 服务')
    // 始终注册：工作模式/注入关闭都由 provider 返回空串决定。
    // 这样按会话切换、保存配置热改都能立刻生效，不需要重载插件。
    const personaFn = () => personaText()
    if (typeof svc.context === 'function') {
      svc.context({ name: 'memory-tiers-persona', order: 200, text: personaFn, interpolate: false })
      svc.context({ name: 'memory-tiers', order: 250, text: (asm) => buildInjectedBlock(asm), interpolate: false })
      injection.mode = 'context'
    } else if (typeof svc.section === 'function') {
      svc.section({ name: 'memory-tiers-persona', order: 10150, text: personaFn, interpolate: false })
      svc.section({ name: 'memory-tiers', order: 10300, text: (asm) => buildInjectedBlock(asm), interpolate: false })
      injection.mode = 'section'
    } else {
      throw new Error('systemPrompt 既没有 context() 也没有 section()')
    }
    injection.ok = true
    // 挂载状态落一次；具体会话为什么没注入由 /session 与 /memory context 查。
    writeStatus(env, { inject: { enabled: true, mode: injection.mode, ok: true, reason: null } })
    audit('INJECT_ON', injection.mode)
  }
  withService('systemPrompt', injectBlock)

  // ── ⑤.5 热改 + 会话接口的公共逻辑 ──
  /** 把保存后的配置里「能热改的字段」换进运行态；重载字段保留旧值，交给页面标「待重载」。 */
  const applyLiveConfig = (next) => {
    const merged = JSON.parse(JSON.stringify(next || {}))
    for (const f of SCHEMA) {
      if (isReloadPath(f.path)) setPath(merged, f.path, getPath(runCfg, f.path))
    }
    runCfg = merged
    recomputeWorkCapacity()
    audit('CONFIG_APPLIED', `live=${SCHEMA.filter((f) => !isReloadPath(f.path)).length} reload=${SCHEMA.filter((f) => isReloadPath(f.path)).length}`)
  }
  function recomputeWorkCapacity() {
    const next = toEngineCfg(runCfg, { workMode: anyWorkLike() })
    try { mem.updateConfig(next) } catch (e) { audit('ENGINE_CFG_FAIL', String(e?.message ?? e)) }
    engineCfg = next
  }
  const sessionInfo = (sid) => {
    const rec = sessionState.sessions?.[String(sid)] || null
    const mode = modeOf(sid)
    return {
      sessionId: String(sid),
      mode,
      label: sessionModeLabel(sid),
      workMode: rec?.workMode ?? null,
      everWorked: rec?.everWorked === true,
      turns: rec?.turns || 0,
      lastActiveAt: rec?.lastActiveAt || 0,
      exempt: mode === 'exempt',
      globalWorkMode: globalWorkDefault(),
    }
  }
  const sessionsApi = {
    list() {
      const rows = Object.keys(sessionState.sessions || {})
        .map((sid) => sessionInfo(sid))
        .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
      return { sessions: rows, globalWorkMode: globalWorkDefault(), counts: sessionStats(sessionState) }
    },
    get(sid) { return sessionInfo(sid) },
    setMode(sid, on) {
      const id = String(sid || '').trim()
      if (!id) throw new Error('缺 sessionId')
      setSessionWorkMode(sessionState, id, on === true)
      flushSessions()
      recomputeWorkCapacity()
      audit('SESSION_MODE', `${id} workMode=${on === true}`)
      return sessionInfo(id)
    },
    clearExemption(sid) {
      const id = String(sid || '').trim()
      if (!id) throw new Error('缺 sessionId')
      clearSessionExemption(sessionState, id)
      flushSessions()
      recomputeWorkCapacity()
      audit('SESSION_EXEMPT_CLEAR', id)
      return sessionInfo(id)
    },
  }

  // ── ⑥ 配置页接口 ──
  withService('webServer', (c, wsSvc) => {
    webServerSvc = wsSvc || c?.webServer || ctx.webServer || null
    api = installApi(c || ctx, {
      env,
      log: audit,
      webServer: webServerSvc,
      getMem: () => mem,
      getDataDir: () => dataDir,
      // 运行中实际生效的配置（页面用来对比文件值、标「待重载」）
      getEffectiveConfig: () => runCfg,
      onConfigSaved: (next) => applyLiveConfig(next),
      getRunState: () => ({ ...runState(), injection: { ...injection } }),
      sessions: sessionsApi,
      star: {
        payload: () => buildPayload({ dir: dataDir, layers: layersFromMemory(mem) }),
        render: (payload) => renderHtml(payload, dataDir),
      },
    })
    if (!api) throw new Error('webServer 不支持 register')
  })

  // ── ⑦ 命令 ──
  withService('commands', (c, commandsSvc) => {
    const reg = commandsSvc || c?.commands || ctx.commands
    if (!reg?.register) throw new Error('commands.register 不可用')
    reg.register({
      name: 'memory',
      description: '记忆：/memory context 导出模型收到的上下文 · list 看六层记忆',
      input: { hint: '[context [all] | list]' },
      async handler(invocation) {
        const raw = String(invocation?.rawInput || '').trim()

        if (raw === 'context' || raw.startsWith('context ')) {
          const ses = invocation?.agent?.session
          if (!ses || typeof ses.deriveMessages !== 'function') {
            return { kind: 'error', text: '取不到当前会话对象（这个版本没把 agent.session 传进来）。' }
          }
          let messages = []
          try { messages = ses.deriveMessages() || [] } catch (e) {
            return { kind: 'error', text: `读会话消息失败：${e?.message ?? e}` }
          }
          if (!messages.length) return { kind: 'success', text: '会话里还没有内容（还没发出过请求）。' }

          // 分类三条规则：
          //   · 主系统提示（system-prompt）→ 按字数报 + 全文写入
          //   · 含 <memory_context> 的消息（历史里残留的旧快照）→ 不重复写，只计数
          //   · 其余 system 消息（工具注册、请求配置之类）→ 只在头部提示条数，不写入
          const isInj = (m) => messageText(m).includes('<memory_context>')
          const isSysPrompt = (m) => String(m?.role || '') === 'system'
            && !isInj(m) && (!m?.source?.kind || m.source.kind === 'system-prompt')
          const isReg = (m) => String(m?.role || '') === 'system' && !isSysPrompt(m) && !isInj(m)
          const sysMsgs = messages.filter(isSysPrompt)
          const regMsgs = messages.filter(isReg)
          const historyInj = messages.filter(isInj)
          const rest = messages.filter((m) => !isSysPrompt(m) && !isReg(m) && !isInj(m))
          const sysChars = sysMsgs.reduce((s, m) => s + messageText(m).length, 0)
          const restChars = rest.reduce((s, m) => s + messageText(m).length, 0)
          const sysText = sysMsgs.map(messageText).join('\n')

          // ★ 注入块由插件自己按当前库实时构建（deriveMessages 里没有它，原因见 buildInjectedBlock 的注释）。
          const sid = ses?.id ? String(ses.id) : null
          const persona = personaText()
          const block = buildInjectedBlock(null, sid)
          const blockReason = injection.reason
          const reasonText = blockReason === 'work-mode'
            ? '工作模式开启：不注入记忆'
            : blockReason === 'session-exempt'
              ? '该会话已豁免记忆接管：不注入记忆'
              : blockReason === 'inject-disabled'
                ? '注入已关闭'
                : '注入开着，但库里还没有可注入的内容'
          const blockNote = block
            ? `${block.length.toLocaleString()} 字`
            : `0 字（${reasonText}）`
          const histNote = historyInj.length
            ? ` · 历史里另有 ${historyInj.length} 条旧记忆块（不重复写入）`
            : ''
          const regNote = regMsgs.length
            ? ` · 注册/配置类 ${regMsgs.length} 条（不写入）`
            : ''
          const modeNote = sid ? ` · 当前会话 ${sessionModeLabel(sid)}` : ''
          const head = `系统提示 ${sysChars.toLocaleString()} 字 · 本轮人格 ${persona.length.toLocaleString()} 字 · 本轮记忆块 ${blockNote} · 其余 ${rest.length} 条 / ${restChars.toLocaleString()} 字${modeNote}${histNote}${regNote}`
          // 文件里完整呈现：系统提示全文 + 人格 + 记忆块 + 历史残留 + 其余消息原样。
          // 注册类只在头部提示，不写入。
          const dump = [
            `【系统提示 · ${sysChars.toLocaleString()} 字】`,
            sysText,
            '',
            `【本轮将注入的人格 · ${persona.length.toLocaleString()} 字】`,
            persona || '（未配置人格）',
            '',
            `【本轮将注入的记忆块 · ${block.length.toLocaleString()} 字】`,
            block || `（${reasonText}）`,
            '',
            ...(historyInj.length
              ? [
                `【历史里残留的旧记忆块 · ${historyInj.length} 条（本轮请求会被新快照替换）】`,
                historyInj.map(messageText).join('\n\n'),
                '',
              ]
              : []),
            `【其余消息 · ${rest.length} 条】`,
            renderMessages(rest),
          ].join('\n')
          const sub = raw.slice(7).trim().toLowerCase()

          if (sub === 'all') {
            // 强制刷屏（调试时想直接在聊天里看的场合）
            const capped = dump.length > 300000 ? dump.slice(0, 300000) + '\n…（超过 30 万字，已截断）' : dump
            return { kind: 'success', text: `${head}\n\n${capped}` }
          }
          // 默认写成文本文件：完整、可翻、不刷屏。内容 = 发给模型的原样。
          try {
            writeFileSync(contextPath(env), `${head}\n\n${dump}`, 'utf8')
            return { kind: 'success', text: `${head}\n\n已写成文本：\n${contextPath(env)}\n（要在聊天里直接看就 /memory context all）` }
          } catch (e) { return { kind: 'error', text: `${head}\n\n导出失败：${e?.message ?? e}` } }
        }

        if (raw === 'list') {
          const all = mem.list()
          if (!all.length) return { kind: 'success', text: '还没有任何记忆。' }
          const byLayer = {}
          for (const it of all) (byLayer[it.layer] = byLayer[it.layer] || []).push(it)
          // 每条：id · 时间 · 通道首字母 · 重要度 · 正文（放宽到 120 字，空白压成单空格）
          const CH = { dialog: '话', action: '作', event: '事', note: '记' }
          const fmt = (it) => {
            const d = new Date(it.createdAt || Date.now())
            const ts = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
              + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
            const ch = CH[it.channel] || it.channel || '?'
            const imp = typeof it.importance === 'number' ? it.importance.toFixed(2) : '--'
            const text = String(it.text || '').replace(/\s+/g, ' ').trim()
            const shown = text.length > 120 ? text.slice(0, 120) + '…' : text
            return `- [${it.id}] ${ts} ${ch} ${imp} ${shown}`
          }
          const body = Object.entries(byLayer).map(([l, rows]) => [
            `### ${l}（${rows.length}）`,
            ...rows.slice(0, 12).map(fmt),
            rows.length > 12 ? `（还有 ${rows.length - 12} 条，更早的在前）` : '',
          ].filter(Boolean).join('\n')).join('\n\n')
          return {
            kind: 'success',
            text: body + '\n\n（通道：话=dialog 作=action 事=event 记=note；每条最多显示 120 字）',
          }
        }

        // 其余输入不再注册 search / organize / 概览：检索与整理走模型工具和配置页，命令只留调试用的两个。
        return {
          kind: 'success',
          text: '可用子命令：/memory context [all]（导出模型收到的上下文） · /memory list（看六层记忆）',
        }
      },
    })
  })

  // ── ⑧ 定时整理 + 卸载清理 ──
  step('timers', () => {
    mem.start()
    return true
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try { captureOff?.() } catch { /* 已卸 */ }
      try { mem.stop() } catch { /* 已停 */ }
      try { api?.dispose?.() } catch { /* 已卸 */ }
      try { flushSessions() } catch { /* 已写 */ }
      for (const sid of [...buffers.keys()]) {
        Promise.resolve().then(() => flushBuffer(sid)).catch(() => {})
      }
      writeStatus(env, { stoppedAt: new Date().toISOString() })
      audit('SHUTDOWN', '')
    }, 'memory-tiers: lifecycle')
  }

  // ── ⑨ 状态落盘 + 一句总结 ──
  const finalStatus = {
    loadedAt: boot.startedAt,
    // 这个文件的格式版本（不是插件版本）：以后字段形状变了再 +1
    statusVersion: 1,
    configPath: loaded?.path ?? configPath(env),
    dataDir,
    writer,
    boot,
    inject: { enabled: runCfg.inject.enabled !== false, mode: injection.mode, ok: injection.ok, reason: injection.reason },
    capture: captureEnabled(),
    compaction: { enabled: runCfg.compaction.enabled !== false, keepTurns: Number(runCfg.compaction.keepTurns) || 0 },
    workMode: {
      enabled: globalWorkDefault(),
      perSession: true,
      hotChars: engineCfg.hotMaxChars,
      consolidateChars: engineCfg.consolidateMaxChars,
      capture: { ...workCap() },
      captureNormal: { ...normalCap() },
      sessions: sessionStats(sessionState),
    },
    persona: { enabled: runCfg.persona?.enabled !== false, chars: personaText().length, inSummary: runCfg.persona?.inSummary === true },
    sessions: { path: sessionState.path || sessionsPath(env), ...sessionStats(sessionState) },
    semantic: { embed: !!caps.embed, rerank: !!caps.rerank, model: caps.embedModel || null },
    session: (() => { try { return session.info() } catch { return null } })(),
    stages: (() => {
      const out = {}
      for (const n of ['summary', 'chat', 'embed', 'rerank']) {
        try { out[n] = llm.resolveStage(n) } catch { out[n] = null }
      }
      return out
    })(),
    // 端口可能还没 listen（OS 分配），先写 null，定时器补一次
    api: apiInfo(),
    // 上一轮进程留下的 stoppedAt 不算本轮状态，清掉（status 是「现在」的快照，不是历史）
    stoppedAt: undefined,
  }
  writeStatus(env, finalStatus)
  // 端口补写：webServer.listen 通常在插件装载之后才完成，这里等 1.5 秒再看一眼
  {
    const timer = setTimeout(() => {
      const now = apiInfo()
      // ★ 同时补 star.url：首次写 status 时端口还是 0，url 只能是 null；
      //   不补的话 status 里永远没有星图地址，设置页/脚本都拿不到入口。
      if (now.port) {
        writeStatus(env, {
          api: now,
          star: { url: `http://127.0.0.1:${now.port}/dsh-memory/star` },
        })
      }
    }, 1500)
    if (timer.unref) timer.unref()
  }
  audit('BOOT_DONE', `ms=${Date.now() - t0} steps=${JSON.stringify(boot.steps)} errors=${boot.errors.length}`)
  if (boot.errors.length) audit('BOOT_DEGRADED', JSON.stringify(boot.errors).slice(0, 800))
  ctx.logger?.info?.('[memory-tiers] 装载完成：注入=%s 工具=%d 接口=%d 错误=%d',
    injection.mode, tools.length, api?.mounted?.length || 0, boot.errors.length)
  return { boot, mem, llm, cfg: runCfg, dataDir }
}

/**
 * 旧版本在记忆库根目录留下的文件：向量和遗忘台账现在有子目录了。
 * 只搬不删——认不出来就原样留着，绝不因为「看着像垃圾」丢数据。
 */
export function relocateLegacyFiles(dir, audit = () => {}) {
  try {
    const files = readdirSync(dir)
    const vecDir = join(dir, 'vectors')
    const graveDir = join(dir, 'graveyard')
    let moved = 0
    for (const f of files) {
      const src = join(dir, f)
      try {
        if (/^deep-(meta|part-\d+)\.json$/.test(f)) {
          mkdirSync(vecDir, { recursive: true })
          renameSync(src, join(vecDir, f))
          moved++
        } else if (f === 'forgotten.jsonl') {
          mkdirSync(graveDir, { recursive: true })
          const dst = join(graveDir, 'forgotten.jsonl')
          const body = readFileSync(src, 'utf8')
          if (body.trim()) appendFileSync(dst, body.endsWith('\n') ? body : body + '\n', 'utf8')
          unlinkSync(src)
          moved++
        }
      } catch { /* 单个文件搬不动就算了 */ }
    }
    if (moved) audit('RELOCATE_LEGACY', `${moved} 个文件归位`)
    return moved
  } catch { return 0 }
}
