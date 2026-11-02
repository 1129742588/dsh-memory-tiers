/**
 * memory6.mjs —— 六层 · 六个文件（split 布局）
 *
 * 和 memory5 的区别（设计见 ARCHITECTURE.md 第 26 节）：
 *
 *   1. 六个文件六层：L1.json / L2.json / L3.json / DL1.json / DL2.json / DL3.json
 *      L1.tmp/ 是 L1 的暂存区（每端一个 append-only 文件），不算第七层。
 *   2. 端只写 L1.tmp/<自己>.jsonl（追加、不调模型）；整理者拿钥匙后才动其余文件。
 *   3. 谁先结束谁拿钥匙：open('wx') 抢锁 → rename 认领两边的 temp → 并进 L1 →
 *      按整轮溢出（L1 旧半；L2 旧半 + DL1 全部）→ L3 快照 → 放钥匙。
 *   4. attend / pin / forget 走 signals/<writer>.jsonl，整理者统一消费。
 *   5. 检索按层读文件；detail 顺着摘要的 sources 去 DL2 取原文。
 *
 * 硬约束（破一条就会丢记忆）：
 *   - L1.tmp 只追加、追完就关（不长期持有句柄，否则 rename 会失败）。
 *   - 先写目标层（L2/DL1/DL2/DL3），最后写 L1；崩了重跑靠 id 去重。
 *   - 不直接删别人的 temp：rename 认领成功才算自己的，失败就跳过。
 *   - 同一 id 只允许出现在一层（读侧也按 id 去重）。
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync,
  renameSync, unlinkSync, appendFileSync, statSync, utimesSync,
  openSync, closeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  LAYER, DEFAULTS, makeItem, heatOf, touchHeat, halfLifeOf,
  cosine, dayKey, DAY, isDeep,
} from './memory5.mjs'

// ============================================================
// 配置
// ============================================================

export const DEFAULTS6 = {
  ...DEFAULTS,

  // L1 容量：达到就触发整理（不是注入配额）。用户 2026-11-01 定。
  hotMaxChars: 3000,
  hotMaxItems: 200,
  // L1 注入按端配额：自己最多占多少，剩下的给另一端（另一端为空时自己也只到这条线）。
  hotQuotaOwn: 0.7,

  // 只整理"安静了这么久"的轮次，避免聊到一半被腰斩。
  quietMs: 10 * 60 * 1000,
  // 整理触发：一端结束 + 这个定时器补漏。
  organizeEveryMs: 5 * 60 * 1000,
  // 钥匙多久没心跳算过期（进程崩了也不至于把记忆冻结）。
  staleLockMs: 10 * 60 * 1000,
  // 单轮整理硬超时（模型卡住时别一直占着钥匙）。
  maxOrganizeMs: 5 * 60 * 1000,

  // 会话正文截断（按整轮拼起来再截，不是每条消息截）。
  botCaptureChars: 400,
  toolCaptureChars: 500,

  // 摘要批次按 (origin, scene, channel) 分组，不跨场景。
  fusionPrefilter: 0.82,
  forgetThreshold: 0.25,
  longMaxChars: 4000,
  consolidateMaxChars: 2500,
  consolidateMaxItems: 120,
  // 第二次整理（L2 溢出）时，`+` 最多留这么多条在 L2；超出的进 DL1。
  // DL2 只放"被摘要引用的原文"，`+` 永远不进 DL2。
  l2KeepMax: 10,
}

const DATA_LAYERS = ['L1', 'L2', 'DL1', 'DL2', 'DL3']
const ALL_LAYERS = ['L1', 'L2', 'L3', 'DL1', 'DL2', 'DL3']

const sanitizeWriter = (w) =>
  String(w || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'default'

const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const chars = (list) => list.reduce((s, it) => s + String(it?.text || '').length, 0)
const uniq = (a) => [...new Set(a.filter(Boolean))]

function srcKey(items) {
  const s = items.map((it) => it.id).sort().join(',')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `k${(h >>> 0).toString(36)}`
}

/**
 * 按轮次取旧的一半：从旧到新整轮拿，直到剩下的字数 ≤ cap/2。
 * 一轮特别大时会把整层取空，这是允许的（用户 2026-11-01 确认）。
 *
 * 导出是为了单测能直接验"不切断问答"这件事。
 */
export function pickTurnBatch(items, cap, { orderKey = (it) => it.createdAt, quietBefore = 0, maxItems = Infinity } = {}) {
  if (!items.length) return []
  const total = chars(items)
  if (total <= cap && items.length <= maxItems) return []
  const groups = new Map()
  for (const it of items) {
    const k = it.turnId || it.id
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(it)
  }
  const turns = [...groups.values()]
    .map((g) => ({ items: g, t: Math.min(...g.map(orderKey)) }))
    .sort((a, b) => a.t - b.t)
  // 钉住的轮次永远取不走，不能算进"剩余"里——否则它们占着额度，
  // 其余轮次会被全部取空（不丢数据，但会把 L1 白搬一遍）。
  const pinnedTurns = turns.filter((t) => t.items.some((it) => it.pinned))
  const pinnedChars = pinnedTurns.reduce((s, t) => s + chars(t.items), 0)
  const pinnedItems = pinnedTurns.reduce((s, t) => s + t.items.length, 0)
  let remaining = total - pinnedChars
  let remainingItems = items.length - pinnedItems
  const charTarget = cap / 2
  const itemTarget = maxItems === Infinity ? Infinity : Math.ceil(maxItems / 2)
  const out = []
  for (const turn of turns) {
    if (remaining <= charTarget && remainingItems <= itemTarget) break
    if (turn.items.some((it) => it.pinned)) continue   // 钉住的轮次不参与溢出
    if (quietBefore && Math.max(...turn.items.map((it) => it.createdAt)) > quietBefore) break
    out.push(...turn.items)
    remaining -= chars(turn.items)
    remainingItems -= turn.items.length
  }
  return out
}

// ============================================================
// 小工具
// ============================================================

function atomicWrite(p, body) {
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  let lastErr = null
  for (let i = 0; i < 6; i++) {
    try {
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, p)
      return true
    } catch (e) {
      lastErr = e
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(e.code)) break
      // Windows：目标正被读，等一下再试。
      // ★ 不用 while 空转：Node 是单线程，空转 30ms 会把整个进程占满（所有请求都卡住）。
      //   Atomics.wait 是同步睡眠，让出 CPU；环境不支持时退回限次空转。
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
      } catch {
        const until = Date.now() + 10
        while (Date.now() < until) { /* 退化：最多 10ms */ }
      }
    }
  }
  try { unlinkSync(tmp) } catch { /* 清不掉也无所谓 */ }
  throw new Error(`写文件失败 ${p}: ${lastErr?.message || lastErr}`)
}

function readJsonl(p) {
  let raw
  try { raw = readFileSync(p, 'utf8') } catch { return { items: [], bad: 0 } }
  const items = []
  let bad = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { items.push(JSON.parse(line)) } catch { bad++ }
  }
  return { items, bad }
}

function appendJsonl(p, items) {
  if (!items.length) return
  mkdirSync(join(p, '..'), { recursive: true })
  appendFileSync(p, items.map((it) => JSON.stringify(it)).join('\n') + '\n', 'utf8')
}

// ============================================================
// 主体
// ============================================================

export function createMemory6(o = {}) {
  const cfg = { ...DEFAULTS6, ...(o.cfg || {}) }
  const dir = o.dir || '.memory6'
  const writer = sanitizeWriter(o.writer)
  const tick = o.now || (() => Date.now())
  const embed = typeof o.embed === 'function' ? o.embed : null
  const vectorsDisabled = !embed

  const paths = {
    L1: join(dir, 'L1.json'),
    L2: join(dir, 'L2.json'),
    L3: join(dir, 'L3.json'),
    DL1: join(dir, 'DL1.json'),
    DL2: join(dir, 'DL2.json'),
    DL3: join(dir, 'DL3.json'),
  }
  const tmpDir = join(dir, 'L1.tmp')
  const sigDir = join(dir, 'signals')
  const vecDir = join(dir, 'vectors')
  const vecPath = join(vecDir, 'deep-part-0000.json')
  const vecMetaPath = join(vecDir, 'deep-meta.json')
  const lockPath = join(dir, 'organize.lock')
  const statePath = join(dir, 'organize.state.json')
  const appliedPath = join(sigDir, 'applied.json')
  const auditPath = join(dir, 'audit.log')
  const gravePath = join(dir, 'graveyard', 'forgotten.jsonl')

  for (const p of [dir, tmpDir, sigDir, vecDir, join(dir, 'graveyard')]) {
    try { mkdirSync(p, { recursive: true }) } catch { /* 已存在 */ }
  }

  // —— 模型调用计数（三个数分开记，和 memory5 同口径） ——
  const calls = {
    embed: { rounds: 0, items: 0 },
    summarize: { rounds: 0, items: 0 },
    relation: { rounds: 0, items: 0 },
    rerank: { rounds: 0, items: 0 },
  }
  const bump = (k, n = 1) => { calls[k].rounds++; calls[k].items += n }

  function audit(line) {
    const safe = String(line).replace(/[\r\n]+/g, ' ')
    try { appendFileSync(auditPath, `${new Date().toISOString()} ${safe}\n`, 'utf8') } catch { /* 审计失败不挡主流程 */ }
  }

  // ============================================================
  // 文件读写
  // ============================================================

  function readLayer(name, { strict = false } = {}) {
    const p = paths[name]
    let raw
    try { raw = readFileSync(p, 'utf8') } catch (e) {
      if (e.code === 'ENOENT') return []
      if (strict) throw e
      audit(`READ_FAIL ${name} ${e.message}`)
      return []
    }
    try {
      const j = JSON.parse(raw)
      return Array.isArray(j?.items) ? j.items : []
    } catch (e) {
      // 读侧绝不把损坏的层当空：抛出去，调用方决定降级
      if (strict) throw new Error(`层文件损坏 ${name}: ${e.message}`)
      audit(`READ_CORRUPT ${name} ${e.message}`)
      throw e
    }
  }

  function writeLayer(name, items) {
    atomicWrite(paths[name], JSON.stringify({ version: 2, at: Date.now(), items }, null, 1))
  }

  function tempPath(w = writer) { return join(tmpDir, `${w}.jsonl`) }

  function readTempsAll() {
    const out = []
    let files = []
    try { files = readdirSync(tmpDir) } catch { return { items: out, bad: 0 } }
    let bad = 0
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const r = readJsonl(join(tmpDir, f))
      out.push(...r.items)
      bad += r.bad
    }
    return { items: out, bad }
  }

  /** 把当前所有 temp（含上次遗留的 claimed）改名认领。失败=对方正在写，下一轮再试 */
  function claimTemps() {
    const claimed = []
    let files = []
    try { files = readdirSync(tmpDir) } catch { return claimed }
    const now = Date.now()
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const from = join(tmpDir, f)
      const to = join(tmpDir, `${f.replace(/\.jsonl$/, '')}.claimed-${now}-${Math.random().toString(36).slice(2, 6)}.jsonl`)
      try { renameSync(from, to); claimed.push(to) } catch { /* 被打开/正在写，跳过 */ }
    }
    return claimed
  }

  function claimSignals() {
    const claimed = []
    let files = []
    try { files = readdirSync(sigDir) } catch { return claimed }
    const now = Date.now()
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const from = join(sigDir, f)
      const to = join(sigDir, `${f.replace(/\.jsonl$/, '')}.claimed-${now}-${Math.random().toString(36).slice(2, 6)}.jsonl`)
      try { renameSync(from, to); claimed.push(to) } catch { /* 被打开，跳过 */ }
    }
    return claimed
  }

  // ============================================================
  // 向量
  // ============================================================

  let vectors = new Map()
  let vectorsDirty = false
  let vecSig = ''

  function vecFileSig() {
    try { const st = statSync(vecPath); return `${st.mtimeMs}:${st.size}` } catch { return '' }
  }

  /** 别的进程可能刚写了新向量；文件变了就重读（不重读会一直用启动时那份） */
  function maybeReloadVectors() {
    if (vectorsDisabled) return
    const s = vecFileSig()
    if (s === vecSig) return
    loadVectors()
  }

  function loadVectors() {
    if (vectorsDisabled) return
    vecSig = vecFileSig()
    vectorsDirty = false
    vectors = new Map()
    let meta = null
    try { meta = JSON.parse(readFileSync(vecMetaPath, 'utf8')) } catch { /* 老库没 meta */ }
    if (meta && typeof meta.sig === 'string' && o.embedSignature && meta.sig !== o.embedSignature) {
      // 嵌入模型换了：旧向量不可比较。数据不重要，直接不用（文件留着，不删）。
      audit(`VEC_STALE ${meta.sig} → ${o.embedSignature}，忽略旧向量`)
      vectors = new Map()
      return
    }
    let raw
    try { raw = JSON.parse(readFileSync(vecPath, 'utf8')) } catch { return }
    for (const [id, b64] of Object.entries(raw || {})) {
      try {
        const buf = Buffer.from(b64, 'base64')
        vectors.set(id, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
      } catch { /* 单条坏了不连累别人 */ }
    }
  }

  function saveVectors() {
    if (vectorsDisabled || !vectorsDirty) return
    const out = {}
    for (const [id, v] of vectors) out[id] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
    atomicWrite(vecPath, JSON.stringify(out))
    const first = vectors.values().next().value
    atomicWrite(vecMetaPath, JSON.stringify({
      sig: o.embedSignature || '', dim: first ? first.length : 0, count: vectors.size, at: new Date().toISOString(),
    }, null, 1))
    vectorsDirty = false
    vecSig = vecFileSig()
  }

  async function embedInto(items, chunk = 32) {
    if (!embed || !items.length) return 0
    // ★ 已经有向量的不重算。L2 溢出时这一批里带着「DL1 全部」，
    //   它们早就 embed 过了；不过滤等于每次 L2 溢出都把整个 DL1 重算一遍（白花钱）。
    const todo = items.filter((it) => it && it.id && !vectors.has(it.id))
    if (!todo.length) return 0
    items = todo
    let n = 0
    for (let i = 0; i < items.length; i += chunk) {
      const slice = items.slice(i, i + chunk)
      const texts = slice.map((it) => String(it.text || '').slice(0, 512))
      bump('embed', slice.length)
      try {
        const res = await embed(texts)
        for (let j = 0; j < slice.length; j++) {
          if (res?.[j]) { vectors.set(slice[j].id, Float32Array.from(res[j])); n++; vectorsDirty = true }
        }
      } catch { /* 这一块失败，缺向量只影响语义检索，不挡落库 */ }
    }
    return n
  }

  async function embedOne(text) {
    if (!embed) return null
    bump('embed', 1)
    try { const r = await embed([String(text || '').slice(0, 512)]); return r?.[0] ? Float32Array.from(r[0]) : null } catch { return null }
  }

  // ============================================================
  // 写：只追加自己的 temp
  // ============================================================

  let turnCounter = 0
  const newTurnId = () => `${writer}-${Date.now().toString(36)}-${(++turnCounter).toString(36)}-${Math.random().toString(36).slice(2, 5)}`

  function writeTurn(rows = []) {
    const list = (rows || []).filter((r) => r && String(r.text || '').trim())
    if (!list.length) return { ok: false, error: '内容为空' }
    const turnId = list[0].turnId || newTurnId()
    const now = tick()
    const items = list.map((r) => {
      const it = makeItem({
        text: String(r.text).trim(),
        channel: r.channel || 'dialog',
        speaker: r.speaker || '',
        people: r.people || [],
        scene: r.scene || '',
        importance: Number.isFinite(Number(r.importance)) ? Number(r.importance) : 0.5,
        kind: r.kind || 'raw',
        at: r.at ?? now,
      })
      it.layer = 'L1'
      it.turnId = turnId
      it.origin = writer
      if (r.impRough) it.impRough = true
      return it
    })
    appendJsonl(tempPath(), items)
    audit(`WRITE_TURN ${turnId} ${items.length} 条`)
    return { ok: true, turnId, ids: items.map((it) => it.id), layer: 'L1' }
  }

  const write = (args = {}) => writeTurn([args])
  const writeMany = (list = []) => writeTurn(list)

  // ============================================================
  // 读：L1 视图（真 L1 + 所有 temp），按 id 去重
  // ============================================================

  function dedupe(items) {
    const seen = new Set()
    const out = []
    for (const it of items) {
      if (!it || !it.id || seen.has(it.id)) continue
      seen.add(it.id)
      out.push(it)
    }
    return out
  }

  /**
   * L1 视图 = 真 L1 + 所有 temp，按 id 去重。
   *
   * ★ 不再自己读 DL1/DL2/DL3 做"已下沉"比对（2026-11-02）。
   *   原来每轮注入都要全量解析三个深层文件——DL1 上千条时是 10~30ms 的同步 IO，
   *   Node 单线程，这段时间整个进程是卡住的。而正常流程下 L1 根本不含深层条目：
   *   `saveDb` 特意"先写目标层、最后写 L1"，`reconcile` 整理时还会再对一次账。
   *   只有崩溃后才可能出现交叉，那时重复显示一条（不是丢），下一次整理就清掉。
   *
   * @param {{placed?: Set<string>}} [opts] 已确认在别的层里的 id（调用方手上有就传，
   *   比如 buildBlock 已经读过 L2，顺手给出，不用再读一次）
   */
  function readL1View({ placed = null } = {}) {
    const temp = readTempsAll()
    const base = (() => { try { return readLayer('L1') } catch { return [] } })()
    const all = dedupe([...base, ...temp.items])
    try { for (const it of readLayer('L2')) placed.add(it.id) } catch { /* 忽略 */ }
    return { items: placed ? all.filter((it) => !placed.has(it.id)) : all, bad: temp.bad }
  }

  // ============================================================
  // 整理：钥匙 + 合并 + 分流
  // ============================================================

  let lockHeld = false
  let lockWriter = ''
  let lockToken = ''

  function readLock() {
    try { return JSON.parse(readFileSync(lockPath, 'utf8')) } catch { return null }
  }

  function acquireLock() {
    try {
      const fd = openSync(lockPath, 'wx')
      lockToken = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, writer, at: Date.now(), tab: lockToken, phase: 'start' }))
      } finally { closeSync(fd) }
      lockHeld = true
      lockWriter = writer
      return true
    } catch (e) {
      if (e.code !== 'EEXIST') { audit(`LOCK_FAIL ${e.message}`); return false }
      let st = null
      try { st = statSync(lockPath) } catch { return acquireLock() }
      if (Date.now() - st.mtimeMs < cfg.staleLockMs) return false
      // 心跳过期：把旧锁改名（原子），再抢一次
      try { renameSync(lockPath, `${lockPath}.stale-${Date.now()}`) } catch { return false }
      return acquireLock()
    }
  }

  /**
   * 持锁期间确认"这把钥匙还是我的"。
   * 如果整理卡在模型调用里超过 staleLockMs，另一端会接管；接管后这边必须停手，
   * 否则两个写者同时改深层文件，会互相覆盖。
   */
  function checkLock() {
    if (!lockHeld) throw new Error('没有钥匙')
    const cur = readLock()
    if (!cur || cur.tab !== lockToken) throw new Error('钥匙被接管，放弃本轮')
  }

  function heartbeat() {
    if (!lockHeld) return
    const cur = readLock()
    if (cur && cur.tab && cur.tab !== lockToken) { lockHeld = false; return }  // 已被接管
    try { utimesSync(lockPath, new Date(), new Date()) } catch { /* 锁没了就下次再抢 */ }
  }

  function releaseLock() {
    if (!lockHeld) return
    const cur = readLock()
    // 只删自己的锁；被接管后不能把新主人的锁删掉
    if (!cur || !cur.tab || cur.tab === lockToken) {
      try { unlinkSync(lockPath) } catch { /* 已没 */ }
    }
    lockHeld = false
  }

  function loadDb() {
    const db = {}
    for (const l of DATA_LAYERS) db[l] = readLayer(l, { strict: true })
    return db
  }

  /**
   * 每层内部去重 + 跨层去重（深层的 id 为准，L1/L2 里的副本丢掉）。
   * 顺带保证"同一事件只存在一层"。
   */
  function reconcile(db) {
    // 返回"清掉了多少条"。调用方用它决定要不要落盘——不返回的话，
    // 崩溃残留的交叉条目虽然被清出内存了，却可能因为"本轮没有别的变化"而写不回去。
    let removed = 0
    const deep = new Map()
    for (const l of ['DL3', 'DL2', 'DL1']) {
      const before = db[l].length
      db[l] = dedupe(db[l])
      removed += before - db[l].length
      for (const it of db[l]) if (!deep.has(it.id)) deep.set(it.id, l)
    }
    const l1Before = db.L1.length
    db.L1 = dedupe(db.L1).filter((it) => !deep.has(it.id))
    const l2Before = db.L2.length
    db.L2 = dedupe(db.L2).filter((it) => !deep.has(it.id))
    // 已经进了 L2 的，也不能还留在 L1（崩在"L2 写完、L1 没改"时会这样）
    const inL2 = new Set(db.L2.map((it) => it.id))
    db.L1 = db.L1.filter((it) => !inL2.has(it.id))
    removed += (l1Before - db.L1.length) + (l2Before - db.L2.length)

    // 同一个 id 出现在两个深层：保留更靠后的（DL2 > DL1；DL3 只放摘要，理论上不会撞）
    const seen = new Set()
    for (const l of ['DL3', 'DL2', 'DL1']) {
      db[l] = db[l].filter((it) => {
        if (seen.has(it.id)) { audit(`RECONCILE_DUP ${it.id} ${l}`); removed++; return false }
        seen.add(it.id)
        return true
      })
    }

    // DL2 不变式：每一条都必须被某条 DL3 摘要引用。
    // 摘要被删/被合并后留下的孤儿，移到 DL1（快忘），不让它冒充"重要原文"。
    const refs = new Set()
    for (const s of db.DL3) for (const id of s.sources || []) refs.add(id)
    const orphans = db.DL2.filter((it) => !refs.has(it.id))
    if (orphans.length) {
      db.DL2 = db.DL2.filter((it) => refs.has(it.id))
      for (const it of orphans) {
        if (db.DL1.some((x) => x.id === it.id)) continue
        it.layer = 'DL1'
        delete it.consolidatedAt
        db.DL1.push(it)
      }
      audit(`RECONCILE_DL2_ORPHAN ${orphans.length} 条 → DL1（DL2 只放被引用的原文）`)
      removed += orphans.length      // 不算丢，只是换层；但文件确实变了，要写回
    }
    return removed
  }

  function sortDb(db) {
    db.L1.sort((a, b) => (a.createdAt - b.createdAt) || cmpId(a.id, b.id))
    db.L2.sort((a, b) => ((a.consolidatedAt ?? a.createdAt) - (b.consolidatedAt ?? b.createdAt)) || cmpId(a.id, b.id))
    for (const l of ['DL1', 'DL2', 'DL3']) db[l].sort((a, b) => (a.createdAt - b.createdAt) || cmpId(a.id, b.id))
  }

  /**
   * 按层写回。**先写目标层，最后写 L1**：
   * 崩在中间时 L1 里还有原文，靠 id 去重不会重复、不会丢。
   */
  function saveDb(db, { skip = [] } = {}) {
    sortDb(db)
    const skipSet = new Set(skip)
    for (const l of ['L2', 'DL1', 'DL2', 'DL3', 'L1']) {
      // 跳过只对"已经存在"的层生效：文件都还没有时得先建出来，
      // 否则第一次整理遇到"内容没变"就少建一个文件，读侧会 ENOENT。
      if (skipSet.has(l) && existsSync(paths[l])) continue
      writeLayer(l, db[l])
    }
  }

  function mergeTemps(db) {
    const claimed = claimTemps()
    if (!claimed.length) return { merged: 0, claimed }
    const have = new Set(db.L1.map((it) => it.id))
    for (const l of ['L2', 'DL1', 'DL2', 'DL3']) for (const it of db[l]) have.add(it.id)
    let merged = 0
    let bad = 0
    for (const p of claimed) {
      const r = readJsonl(p)
      bad += r.bad
      for (const it of r.items) {
        if (!it || !it.id || have.has(it.id)) continue
        if (!it.origin) it.origin = it.id.startsWith('m5_') ? '?' : writer
        if (!it.turnId) it.turnId = it.id
        it.layer = 'L1'
        have.add(it.id)
        db.L1.push(it)
        merged++
      }
    }
    if (bad) audit(`MERGE_TEMP_BAD ${bad} 行（写到一半崩溃留下的半行，已跳过）`)
    return { merged, claimed }
  }

  function moveItem(db, it, target, now) {
    if (it.layer === target) {
      if (!db[target].some((x) => x.id === it.id)) db[target].push(it)
      return
    }
    for (const l of DATA_LAYERS) db[l] = db[l].filter((x) => x.id !== it.id)
    it.layer = target
    if (target === 'L2') it.consolidatedAt = now
    db[target].push(it)
  }

  function groupOf(it) {
    return `${it.origin || '?'}\u0001${it.scene || ''}\u0001${it.channel || 'dialog'}`
  }

  function commonScene(items) {
    const s = [...new Set(items.map((it) => it.scene || '').filter(Boolean))]
    return s.length === 1 ? s[0] : ''
  }

  function mergeSummaries(target, src, now) {
    if (String(src.text || '').length > String(target.text || '').length) target.text = src.text
    const tFrom = target.spanFrom ?? target.createdAt
    const tTo = target.spanTo ?? target.createdAt
    const sFrom = src.spanFrom ?? src.createdAt
    const sTo = src.spanTo ?? src.createdAt
    target.spanFrom = Math.min(tFrom, sFrom)
    target.spanTo = Math.max(tTo, sTo)
    target.people = uniq([...(target.people || []), ...(src.people || [])]).slice(0, 10)
    target.sources = uniq([...(target.sources || []), ...(src.sources || [])])
    target.importance = Math.max(Number(target.importance) || 0, Number(src.importance) || 0)
    target.heat = Math.max(heatOf(target, now, cfg), heatOf(src, now, cfg))
    target.lastMentionedAt = now
    target.repeatStrength = Math.max(target.repeatStrength || 1, src.repeatStrength || 1)
    target.fusionCount = (target.fusionCount || 0) + 1
  }

  async function fuseSummary(db, sum, now) {
    const sv = vectors.get(sum.id)
    if (sv && typeof o.judgeRelation === 'function') {
      const cands = []
      for (const it of db.DL3) {
        if (it.id === sum.id || it.kind !== 'summary' || it.supersededBy) continue
        const v = vectors.get(it.id)
        if (!v) continue
        const sim = cosine(sv, v)
        if (sim >= cfg.fusionPrefilter) cands.push({ it, sim })
      }
      if (cands.length) {
        cands.sort((a, b) => b.sim - a.sim)
        const top = cands[0]
        bump('relation', 1)
        let type = null
        try { type = await o.judgeRelation(top.it.text, sum.text) } catch { type = null }
        if (type === true) type = 'duplicate'
        if (type === false) type = null
        if (type === 'duplicate') {
          mergeSummaries(top.it, sum, now)
          vectors.delete(sum.id)
          await embedInto([top.it])
          l3Dirty = true
          audit(`FUSE_DUP ${sum.id} → ${top.it.id}`)
          return 'merged'
        }
        if (type === 'contradiction') {
          sum.supersedes = top.it.id
          top.it.supersededBy = sum.id
          sum.heat = Math.max(Number(sum.heat) || 1, Number(top.it.heat) || 1)
          sum.repeatStrength = Math.max(Number(sum.repeatStrength) || 1, Number(top.it.repeatStrength) || 1)
          db.DL3.push(sum)
          l3Dirty = true
          audit(`SUPERSEDE ${top.it.id} ← ${sum.id}`)
          return 'superseded'
        }
      }
    }
    db.DL3.push(sum)
    l3Dirty = true
    return 'added'
  }

  /**
   * 一批原文 → 摘要 + 路由。成功才搬；模型失败则整批回 L2（不丢）。
   *
   * ★ DL2 的唯一入口是"被摘要引用"：`cited` → DL2。
   *   `+`（keep）永远只回 L2，绝不进 DL2——DL2 是 DL3 摘要的原文库，不是第二缓冲层。
   */
  async function digest(db, batch, { secondChance = false } = {}) {
    const groups = new Map()
    for (const it of batch) {
      const k = groupOf(it)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(it)
    }
    const now = tick()
    let made = 0
    let keptTotal = 0   // 第二次整理：本轮最多留这么多 `+` 在 L2，其余进 DL1
    for (const [key, group] of groups) {
      const [origin, scene, channel] = key.split('\u0001')
      const folks = uniq(group.flatMap((it) => (it.people?.length ? it.people : (it.speaker ? [it.speaker] : [])))).slice(0, 10)
      const lines = group.map((it) => `${it.speaker ? `${it.speaker}：` : ''}${it.text}`)
      const hint = [
        scene ? `这一段来自场景「${scene}」，摘要不要和别的场景混在一起。` : '',
        secondChance
          ? `这是第二次整理：+ 最多 ${cfg.l2KeepMax} 条，其余不要再标 +（它们会进流水账，这是正常的）。`
          : '',
      ].filter(Boolean).join(' ')
      let res = null
      if (typeof o.summarizeWithSources === 'function') {
        bump('summarize', group.length)
        try {
          res = await o.summarizeWithSources(lines, channel, folks, hint)
        } catch { res = null }
      }
      if (!res || (!res.summaries?.length && !res.keep?.length)) {
        // 无模型 / 失败：整批回 L2。下轮还有机会再压；绝不进 DL2（那里只放被引用的原文）。
        for (const it of group) moveItem(db, it, 'L2', now)
        audit(`DIGEST_FALLBACK ${channel} ${group.length} 条 → L2`)
        continue
      }

      let sums = res.summaries || []
      if (!secondChance) sums = sums.filter((s) => (Number(s.importance) || 0) >= 0.9)
      const cited = new Set()

      // 先把这一组的摘要全部造出来，再批量 embed、批量融合。
      // 逐条 embed 是 N 次往返（10 条摘要 = 10 次），批量只要 1 次。
      const planned = []
      for (const s of sums) {
        const srcs = (s.sources || []).map((i) => group[i - 1]).filter(Boolean)
        if (!srcs.length) continue
        const k = srcKey(srcs)
        if (db.DL3.some((x) => x.srcKey === k)) { for (const it of srcs) cited.add(it.id); continue }
        const sum = makeItem({
          text: String(s.text || '').trim(),
          channel,
          kind: 'summary',
          speaker: '',
          people: folks,
          scene: commonScene(srcs),
          importance: Number(s.importance) || 0.7,
          at: now,
        })
        sum.layer = 'DL3'
        sum.spanFrom = Math.min(...srcs.map((it) => it.createdAt))
        sum.spanTo = Math.max(...srcs.map((it) => it.createdAt))
        sum.sources = srcs.map((it) => it.id)
        sum.heat = 2
        sum.origin = origin
        sum.srcKey = k
        planned.push({ sum, srcs })
      }
      // fuseSummary 要靠向量做预筛，所以向量必须先算完（一次批量）
      if (planned.length) await embedInto(planned.map((p) => p.sum))
      for (const { sum, srcs } of planned) {
        await fuseSummary(db, sum, now)
        for (const it of srcs) cited.add(it.id)
        made++
      }

      const keep = new Set((res.keep || []).map((i) => group[i - 1]?.id).filter(Boolean))
      for (const it of group) {
        if (cited.has(it.id)) {
          moveItem(db, it, 'DL2', now)
        } else if (keep.has(it.id)) {
          if (!secondChance) {
            moveItem(db, it, 'L2', now)
          } else if (keptTotal < cfg.l2KeepMax) {
            // 第二次的 + 留在 L2（不是 DL2），但限量；给它新的 consolidatedAt，
            // 排到 L2 队尾，下一轮不会又第一个被挑出来。
            if (it.layer === 'L2') it.consolidatedAt = now
            else moveItem(db, it, 'L2', now)
            keptTotal++
          } else {
            moveItem(db, it, 'DL1', now)
          }
        } else {
          moveItem(db, it, 'DL1', now)
        }
      }
      await embedInto(group)
      audit(`DIGEST ${origin}/${scene || '-'}/${channel} ${group.length} 条 → 摘要 ${made}（引用 ${cited.size}）`)
    }
    return made
  }

  /** 一轮整理超时就放弃（钥匙别被一个卡住的模型带走） */
  function checkTimeout(started) {
    if (tick() - started > cfg.maxOrganizeMs) throw new Error('整理超时')
  }

  /**
   * 按轮次取旧的一半（实现在模块顶部 pickTurnBatch，导出给单测）。
   */
  const pickTurns = (items, cap, opts) => pickTurnBatch(items, cap, opts)

  async function organizeL1(db, started) {
    if (chars(db.L1) <= cfg.hotMaxChars && db.L1.length <= cfg.hotMaxItems) return 0
    const batch = pickTurns(db.L1, cfg.hotMaxChars, {
      orderKey: (it) => it.createdAt,
      quietBefore: tick() - cfg.quietMs,
      maxItems: cfg.hotMaxItems,
    })
    if (!batch.length) { audit('L1_FULL_NO_QUIET 都在聊，等安静了再整理'); return 0 }
    checkTimeout(started)
    await digest(db, batch, { secondChance: false })
    return batch.length
  }

  async function organizeL2(db, started) {
    if (chars(db.L2) <= cfg.consolidateMaxChars && db.L2.length <= cfg.consolidateMaxItems) return 0
    const due = pickTurns(db.L2, cfg.consolidateMaxChars, {
      orderKey: (it) => it.consolidatedAt ?? it.createdAt,
      maxItems: cfg.consolidateMaxItems,
    })
    if (!due.length) return 0
    checkTimeout(started)
    // DL1 全部一起送进去（用户定：DL1 与 L2 旧半融合处理）
    const batch = [...due, ...db.DL1]
    await digest(db, batch, { secondChance: true })
    return batch.length
  }

  // ============================================================
  // 信号：attend / pin / forget
  // ============================================================

  const newOpId = () => `${writer}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  function signal(op) {
    const rec = { ...op, opId: op.opId || newOpId(), at: tick() }
    appendJsonl(join(sigDir, `${writer}.jsonl`), [rec])
    return rec
  }

  const attend = (ids) => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
    if (!list.length) return 0
    signal({ op: 'attend', ids: list })
    return list.length
  }
  const pin = (id, v = true) => { signal({ op: 'pin', ids: [String(id)], v: !!v }); return { ok: true, id, pinned: !!v } }
  const forget = (id) => { signal({ op: 'forget', ids: [String(id)] }); return { ok: true, id, queued: true } }

  function findAny(db, id) {
    for (const l of ['DL3', 'DL2', 'DL1', 'L2', 'L1']) {
      const it = db[l].find((x) => x.id === id)
      if (it) return it
    }
    return null
  }

  function writeForgotten(it, now, retention) {
    const rec = {
      id: it.id,
      layer: it.layer,
      channel: it.channel,
      text: String(it.text || '').slice(0, 240),
      importance: it.importance,
      created_local: new Date(it.createdAt).toLocaleString('zh-CN'),
      forgotten_local: new Date(now).toLocaleString('zh-CN'),
      lifespan_days: Math.round((now - it.createdAt) / DAY),
      retention: retention === null ? null : Number(retention.toFixed(3)),
      reason: '遗忘',
    }
    try { appendFileSync(gravePath, JSON.stringify(rec) + '\n', 'utf8'); return true } catch { return false }
  }

  function applySignals(db) {
    const claimed = claimSignals()
    if (!claimed.length) return { ops: 0, claimed }
    let applied = { ops: [] }
    try { applied = JSON.parse(readFileSync(appliedPath, 'utf8')) } catch { /* 首次 */ }
    const done = new Set(applied.ops || [])
    let n = 0
    const now = tick()
    for (const p of claimed) {
      const r = readJsonl(p)
      for (const op of r.items) {
        if (!op || !op.opId || done.has(op.opId)) continue
        const ids = Array.isArray(op.ids) ? op.ids : []
        if (op.op === 'attend') {
          for (const id of ids) {
            const it = findAny(db, id)
            if (!it) continue
            touchHeat(it, now, cfg)
            it.recallCount = (Number(it.recallCount) || 0) + 1
            if (it.layer === 'DL1') moveItem(db, it, 'L2', now)
            if (it.layer === 'DL3') l3Dirty = true   // 热度变了，L3 排序要跟着变
            n++
          }
        } else if (op.op === 'pin') {
          for (const id of ids) { const it = findAny(db, id); if (it) { it.pinned = !!op.v; n++ } }
        } else if (op.op === 'forget') {
          for (const id of ids) {
            const it = findAny(db, id)
            if (!it) continue
            if (!writeForgotten(it, now, null)) { audit(`FORGET_FAIL ${id} 台账写不进去，不删`); continue }
            if (it.layer === 'DL3') l3Dirty = true
            for (const l of DATA_LAYERS) db[l] = db[l].filter((x) => x.id !== id)
            vectors.delete(id); vectorsDirty = true
            n++
          }
        }
        done.add(op.opId)
      }
    }
    applied.ops = [...done].slice(-2000)
    // 落盘 / 记 applied / 删 claimed 由 organize 统一做（顺序：先存数据，再记账，再删源）
    return { ops: n, claimed, applied }
  }

  // ============================================================
  // 遗忘 + L3 快照
  // ============================================================

  function retentionOf(it, now) {
    const last = it.lastMentionedAt ?? it.createdAt
    const t = Math.max(0, (now - last) / DAY)
    return Math.exp(-t / halfLifeOf(it, cfg))
  }

  function forgetDL1(db) {
    const now = tick()
    const keep = []
    let n = 0
    for (const it of db.DL1) {
      if (it.pinned) { keep.push(it); continue }
      const r = retentionOf(it, now)
      if (r >= cfg.forgetThreshold) { keep.push(it); continue }
      if (!writeForgotten(it, now, r)) { keep.push(it); continue }   // 台账写不进去就不删
      vectors.delete(it.id); vectorsDirty = true
      n++
    }
    db.DL1 = keep
    if (n) audit(`FORGET ${n} 条（DL1 保持率低于 ${cfg.forgetThreshold}）`)
    return n
  }

  function scoreOf(it, now) {
    return (Number(it.importance) || 0) * heatOf(it, now, cfg)
  }

  // L3 快照只在"内容真的变了"或"到刷新间隔"时重写：
  // 它排在注入块最前面，每 5 分钟重排一次会把后面的前缀缓存全打断。
  let l3Dirty = false
  let lastL3At = 0

  /**
   * DL3 的版本指纹（mtime + size）。
   *
   * ★ 为什么需要：`l3Dirty` 是**进程内**变量。A 端整理出新摘要、刷新了 L3.json，
   *   B 端拿钥匙时自己的 l3Dirty 是 false、lastL3At 也没到点 —— 它不会重写快照，
   *   新摘要要等 B 的下一个 viewRefreshMs（30 分钟）才进上下文。
   *   把"这份快照基于哪个版本的 DL3"写进 L3.json，跨进程才判断得出来过期没有。
   */
  function dl3Version() {
    try { const st = statSync(paths.DL3); return `${st.mtimeMs}:${st.size}` } catch { return '0:0' }
  }

  /** 从 DL3 按 importance×heat 截前 N 条（纯计算，不写盘） */
  function computeL3(db = null, now = tick()) {
    const pool = (db && db.DL3) ? db.DL3 : (() => { try { return readLayer('DL3') } catch { return [] } })()
    const scored = pool
      .filter((it) => !it.supersededBy)
      .map((it) => ({ it, s: scoreOf(it, now) }))
      .sort((a, b) => b.s - a.s)
    const out = []
    let used = 0
    for (const { it } of scored) {
      const len = String(it.text || '').length
      if (used + len > cfg.longMaxChars) break
      out.push(it)
      used += len
    }
    return out
  }

  function refreshL3(db) {
    const now = tick()
    const out = computeL3(db, now)
    atomicWrite(paths.L3, JSON.stringify({ version: 3, at: now, dl3v: dl3Version(), items: out }, null, 1))
    lastL3At = now
    l3Dirty = false
    return out.length
  }

  /**
   * 读快照：只有「快照记的 DL3 版本 == 当前 DL3 版本」才算新鲜。
   * 过期（对方刚整理完）返回 null，调用方现算一份——不写盘，写盘是整理者的活。
   */
  function readL3Snapshot() {
    try {
      const snap = JSON.parse(readFileSync(paths.L3, 'utf8'))
      if (snap && typeof snap.dl3v === 'string' && snap.dl3v === dl3Version()) {
        return Array.isArray(snap.items) ? snap.items : []
      }
      return null
    } catch { return null }
  }

  // ============================================================
  // 整理主流程
  // ============================================================

  let organized = 0
  let busy = false

  async function organize() {
    if (busy) return { ok: false, skipped: 'running' }
    if (!acquireLock()) return { ok: false, skipped: 'busy' }
    busy = true
    const started = tick()
    const hb = setInterval(heartbeat, 30 * 1000)
    let claimed = []
    try {
      const db = loadDb()
      // 整理时对账（注入路径不再做这件事，见 readL1View 的说明）：
      // 清理崩溃留下的跨层交叉、DL2 孤儿。清掉的条目要能写回去，
      // 所以这里记下条数，最后并进 changed。
      const rec1 = reconcile(db)
      // DL3 的内容快照：用来判断"这轮到底动没动摘要"，没动就别重写文件。
      // 重写会让 mtime 变、让 L3 快照被判过期，白白打断一次前缀缓存。
      const dl3Before = JSON.stringify(db.DL3)
      const m = mergeTemps(db)
      claimed = m.claimed
      maybeReloadVectors()
      // 先消费信号：attend 可能把 DL1 升回 L2，别让 L2 摘要先把这条吃掉。
      const sg = applySignals(db)
      // 信号可能刚删了摘要；再对一次账，DL2 孤儿同轮就归位到 DL1。
      const rec2 = reconcile(db)
      checkTimeout(started)
      const n1 = await organizeL1(db, started)
      checkTimeout(started)
      const n2 = await organizeL2(db, started)
      checkTimeout(started)
      const nf = forgetDL1(db)
      checkLock()          // 卡太久可能被接管；不是我的钥匙就不许写
      // ★ 没变化就不落盘：turn/end 之后每轮都会调一次 organize，
      //   无条件写五个文件会把"每轮尝试整理"变成"每轮全量重写"。
      const changed = m.merged > 0 || (sg?.ops || 0) > 0 || n1 > 0 || n2 > 0 || nf > 0 ||
        rec1 > 0 || rec2 > 0
      if (changed) {
        const dl3Changed = JSON.stringify(db.DL3) !== dl3Before
        saveDb(db, { skip: dl3Changed ? [] : ['DL3'] })
      }
      // 先存数据，再记 applied，再删源文件（崩在中间最多重放一次，不会丢）
      if (sg?.applied) atomicWrite(appliedPath, JSON.stringify(sg.applied, null, 1))
      for (const p of claimed) { try { unlinkSync(p) } catch { /* 已没 */ } }
      for (const p of sg?.claimed || []) { try { unlinkSync(p) } catch { /* 已没 */ } }
      if (changed) saveVectors()
      // L3 快照：内容变了 / 快照过期 / 到了刷新间隔 才重写
      // （每 5 分钟无条件重排会打断前缀缓存，所以平时不动它）
      const l3Every = Number(cfg.viewRefreshMs) || 0
      const needL3 = l3Dirty || !l3Every || (tick() - lastL3At >= l3Every) || readL3Snapshot() === null
      const l3 = needL3
        ? refreshL3(db)
        : (() => { try { return readLayer('L3').length } catch { return 0 } })()
      organized++
      const state = {
        at: tick(), writer, elapsedMs: tick() - started,
        merged: m.merged, l1Moved: n1, l2Moved: n2, l3,
        count: { L1: db.L1.length, L2: db.L2.length, DL1: db.DL1.length, DL2: db.DL2.length, DL3: db.DL3.length },
        chars: { L1: chars(db.L1), L2: chars(db.L2), DL1: chars(db.DL1), DL2: chars(db.DL2), DL3: chars(db.DL3) },
        vectors: vectors.size,
      }
      atomicWrite(statePath, JSON.stringify(state, null, 1))
      audit(`ORGANIZE ok merged=${m.merged} L1=${n1} L2=${n2} L3=${l3} ${state.elapsedMs}ms`)
      return { ok: true, ...state }
    } catch (e) {
      audit(`ORGANIZE_FAIL ${e.message}`)
      return { ok: false, error: e.message }
    } finally {
      clearInterval(hb)
      busy = false
      releaseLock()
    }
  }

  // ============================================================
  // 注入
  // ============================================================

  function pack(list, limit) {
    const out = []
    let used = 0
    for (const it of list) {
      const l = lineOf(it)
      if (used + l.length + 1 > limit) {
        if (!out.length && limit > 40) {
          const cut = l.slice(0, Math.max(20, limit - 1))
          out.push(cut + '…')
        }
        break
      }
      out.push(l)
      used += l.length + 1
    }
    return out
  }

  function lineOf(it) {
    const isSum = it.kind === 'summary' || !!it.spanFrom
    const tag = isSum && it.spanFrom
      ? `${dayKey(it.spanFrom).slice(5)}~${dayKey(it.spanTo || it.createdAt).slice(5)} `
      : `${dayKey(it.createdAt).slice(5)} `
    const who = isSum
      ? '[摘要] '
      : `[${it.origin || '?'}${it.speaker ? '·' + it.speaker : ''}] `
    const mark = it.supersededBy ? '（已作废）' : ''
    return `- ${mark}${tag}${who}${String(it.text || '').replace(/\s+/g, ' ').trim()}`
  }

  function buildBlock(budget = 0) {
    // ★ 不再"读快照 → 空就现算"，而是"版本对得上才用快照"：
    //   对方刚整理完（DL3 变了、快照还没轮到它写）时，这里会现算一份，
    //   保证「对方写的东西，我下一轮注入就能看见」，不用等 30 分钟的刷新周期。
    //   现算不写盘——写快照是拿钥匙那一方的职责，否则又变成两个写者。
    let l3 = readL3Snapshot()
    if (l3 === null) l3 = computeL3(null)
    l3 = l3.filter((it) => !it.supersededBy)
    // L2 只读一次：既用来拼"最近沉淀的"，顺手当"已下沉"的 id 集合给 L1 视图去重
    let l2raw = []
    try { l2raw = readLayer('L2') } catch { l2raw = [] }
    const l2 = l2raw.filter((it) => !it.supersededBy)
    const l1r = readL1View({ placed: new Set(l2raw.map((it) => it.id)) })
    const l1 = l1r.items.filter((it) => !it.supersededBy)

    l2.sort((a, b) => ((a.consolidatedAt ?? a.createdAt) - (b.consolidatedAt ?? b.createdAt)) || cmpId(a.id, b.id))
    l1.sort((a, b) => (b.createdAt - a.createdAt) || cmpId(b.id, a.id))

    const longLines = pack(l3, Infinity)
    const consLines = pack(l2, cfg.consolidateMaxChars)

    // L1：按端配额。自己最多 hotQuotaOwn；剩下的给另一端（另一端空着时自己也只能到这条线）。
    const cap = cfg.hotMaxChars
    // 自己最多占 quotaOwn；另一端空着时，自己也只能到这条线（配额是"上限"不是"平分"）
    const ownLimit = Math.max(1, Math.floor(cap * cfg.hotQuotaOwn))
    const mine = pack(l1.filter((it) => it.origin === writer), ownLimit)
    const mineUsed = mine.reduce((s, l) => s + l.length + 1, 0)
    const other = pack(l1.filter((it) => it.origin !== writer), Math.max(0, cap - mineUsed))

    const parts = []
    if (longLines.length) parts.push('## 一直记得的', ...longLines)
    if (consLines.length) parts.push('## 最近沉淀的', ...consLines)
    if (mine.length || other.length) parts.push('## 刚发生的', ...mine, ...other)
    const shown = mine.length + other.length
    if (shown < l1.length) parts.push(`（即时层还有 ${l1.length - shown} 条未显示）`)
    const out = parts.join('\n')
    if (budget > 0 && out.length > budget) return out.slice(0, budget)
    return out
  }

  // ============================================================
  // 检索
  // ============================================================

  const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '和', '就', '都', '也', '吗', '呢', '啊', '这', '那', '什么', '怎么', '那事', '事情'])

  function keywords(q) {
    const s = String(q || '').toLowerCase()
    const out = new Set()
    for (const w of s.split(/[\s,，。！？!?、；;:：""''（）()\[\]]+/)) {
      if (w.length >= 2 && !STOP.has(w)) out.add(w)
    }
    const zh = s.replace(/[^\u4e00-\u9fa5]/g, '')
    for (let i = 0; i < zh.length - 1; i++) {
      const bg = zh.slice(i, i + 2)
      if (!STOP.has(bg)) out.add(bg)
    }
    return out
  }

  function parseTime(q, now) {
    const d0 = new Date(now)
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const today = startOfDay(d0)
    const map = {
      刚刚: [now - 2 * 3600e3, now],
      今天: [today, today + DAY],
      昨天: [today - DAY, today],
      前天: [today - 2 * DAY, today - DAY],
      这周: [today - 6 * DAY, today + DAY],
      上周: [today - 13 * DAY, today - 6 * DAY],
      最近: [today - 7 * DAY, today + DAY],
      之前: [0, now],
    }
    for (const [k, v] of Object.entries(map)) {
      if (String(q).includes(k)) return { from: v[0], to: v[1], word: k }
    }
    return null
  }

  const DETAIL_HINTS = /具体|原话|细节|怎么说的|怎么讲|当时|原原本本|哪一句|逐条|列一下|都做了|分别|多少|几号/
  const DEPTH_LAYERS = { summary: ['DL3'], detail: ['DL3', 'DL2'], full: ['DL3', 'DL2', 'DL1'] }
  const layerBoost = (l) => (l === 'DL3' ? 1 : l === 'DL2' ? 0.8 : 0.6)

  async function search(query, opts = {}) {
    maybeReloadVectors()
    const q = String(query || '').trim()
    let depth = opts.depth || 'auto'
    if (depth === 'auto') depth = DETAIL_HINTS.test(q) ? 'detail' : 'summary'
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 6
    const scene = opts.scene || null
    const now = tick()

    const win = parseTime(q, now)
    const kw = keywords(win ? q.replace(win.word, '') : q)
    const qVec = await embedOne(q)

    const layers = DEPTH_LAYERS[depth] || DEPTH_LAYERS.summary
    const pool = []
    for (const l of layers) {
      try { for (const it of readLayer(l)) pool.push(it) } catch { /* 单层坏了不影响别层 */ }
    }

    const scored = []
    for (const it of pool) {
      if (it.supersededBy && !/以前|之前/.test(q)) continue
      if (scene && it.scene !== scene) continue
      const from = it.spanFrom ?? it.createdAt
      const to = it.spanTo ?? it.createdAt
      if (win && !(to >= win.from && from <= win.to)) continue

      const body = [String(it.text || ''), it.speaker || '', (it.people || []).join(' '), it.scene || ''].join(' ')
      let hit = 0
      for (const k of kw) if (body.includes(k)) hit++
      const coverage = kw.size ? hit / kw.size : 0
      const v = vectors.get(it.id)
      const sem = qVec && v ? cosine(qVec, v) : 0
      if (kw.size && hit === 0 && sem < 0.2 && !win) continue

      const timeScore = win ? 0.9 : 0.5
      const imp = Number(it.importance) || 0
      const score = qVec
        ? 0.42 * sem + 0.22 * coverage + 0.20 * timeScore + 0.10 * imp + 0.06 * layerBoost(it.layer)
        : 0.55 * coverage + 0.25 * timeScore + 0.12 * imp + 0.08 * layerBoost(it.layer)
      scored.push({ it, score, sem, coverage })
    }

    scored.sort((a, b) => b.score - a.score)
    let top = scored.slice(0, Math.max(limit * 2, limit))

    // 精排：候选 > 1 才跑；失败就用原分
    let reranked = false
    if (opts.useRerank !== false && typeof o.rerank === 'function' && top.length > 1) {
      try {
        bump('rerank', top.length)
        const rs = await o.rerank(q, top.map((x) => x.it.text))
        // silicon.rerank 返回 [{ index, score }]，不是裸数字；两种都兼容
        if (Array.isArray(rs) && rs.length) {
          const rel = new Map()
          rs.forEach((x, i) => {
            if (x && typeof x === 'object') rel.set(Number(x.index), Number(x.score) || 0)
            else rel.set(i, Number(x) || 0)
          })
          const minRel = Number(cfg.minRerank ?? 0.02)
          const ranked = top
            .map((x, i) => ({ ...x, rel: rel.has(i) ? rel.get(i) : 0 }))
            .filter((x) => x.rel >= minRel)
            .map((x) => ({ ...x, score: 0.55 * x.rel + 0.45 * x.score }))
            .sort((a, b) => b.score - a.score)
          // 精排把结果全滤光了，通常是模型/网络降级 → 保留原分，宁可多给几条
          if (ranked.length) { top = ranked; reranked = true }
        }
      } catch { /* 降级：用原分 */ }
    }

    const hits = top.slice(0, limit).map((x) => ({
      id: x.it.id, text: x.it.text, layer: x.it.layer, channel: x.it.channel,
      when: dayKey(x.it.createdAt),
      scene: x.it.scene || '', createdAt: x.it.createdAt, spanFrom: x.it.spanFrom ?? null,
      importance: x.it.importance, score: Number(x.score.toFixed(4)),
      rel: x.rel ?? null, kind: x.it.kind, sources: x.it.sources || [],
    }))

    // detail/full：顺着摘要的 sources 去 DL2/DL1 取原文（比拿查询扫 DL2 准）
    if (depth !== 'summary' && opts.followSources !== false) {
      const byId = new Map()
      for (const it of pool) byId.set(it.id, it)
      for (const l of ['DL2', 'DL1']) {
        if (byId.has(`__loaded_${l}`)) continue
        try { for (const it of readLayer(l)) if (!byId.has(it.id)) byId.set(it.id, it) } catch { /* 忽略 */ }
        byId.set(`__loaded_${l}`, true)
      }
      const seen = new Set(hits.map((h) => h.id))
      const extra = []
      for (const h of hits) {
        if (h.kind !== 'summary' || !h.sources?.length) continue
        for (const id of h.sources) {
          if (seen.has(id)) continue
          const it = byId.get(id)
          if (!it) continue
          seen.add(id)
          extra.push({
            id: it.id, text: it.text, layer: it.layer, channel: it.channel,
            when: dayKey(it.createdAt), scene: it.scene || '',
            createdAt: it.createdAt, spanFrom: it.spanFrom ?? null, importance: it.importance,
            score: Number((h.score * 0.9).toFixed(4)), rel: h.rel ?? null, kind: it.kind, via: h.id,
          })
        }
      }
      hits.push(...extra.slice(0, 6))
    }

    const relMax = hits.reduce((m, h) => Math.max(m, h.rel ?? h.score ?? 0), 0)
    const advice = !hits.length
      ? '没有找到相关记忆。可以换 depth="full" 再搜一次，或确认这件事确实没记过。'
      : relMax >= 0.5
        ? '相关度较高，可以直接用。'
        : relMax >= 0.1
          ? '相关度中等，用之前自己核一下是不是真的在说这件事。'
          : '相关度偏低（可能只是字面擦边）。如果跟当前话题无关，换 depth="full" 再搜一次。'
    return { hits, confidence: Number(relMax.toFixed(3)), advice, depth, reranked, stages: layers }
  }

  // ============================================================
  // 观测 / 维护
  // ============================================================

  function stats() {
    const count = {}
    const charsBy = {}
    // L1 用"视图"统计（真 L1 + 所有 temp），否则整理前永远是 0
    try {
      const v = readL1View()
      count.L1 = v.items.length
      charsBy.L1 = chars(v.items)
    } catch { count.L1 = 0; charsBy.L1 = 0 }
    for (const l of ['L2', 'DL1', 'DL2', 'DL3']) {
      let items = []
      try { items = readLayer(l) } catch { /* 损坏的层按 0 展示，但 audit 里有记录 */ }
      count[l] = items.length
      charsBy[l] = chars(items)
    }
    let l3 = []
    try { l3 = readLayer('L3') } catch { /* 忽略 */ }
    count.L3 = l3.length
    charsBy.L3 = chars(l3)
    const temp = readTempsAll()
    let last = null
    try { last = JSON.parse(readFileSync(statePath, 'utf8')) } catch { /* 未跑过 */ }
    return {
      count, chars: charsBy,
      total: count.L1 + count.L2 + count.DL1 + count.DL2 + count.DL3,
      vectors: vectors.size, temp: temp.items.length, calls,
      lock: existsSync(lockPath), last,
    }
  }

  function list(layer = null) {
    if (layer === 'L3') { try { return readLayer('L3') } catch { return [] } }
    if (layer === 'L1') return readL1View().items
    if (layer) { try { return readLayer(layer) } catch { return [] } }
    const out = [...readL1View().items]
    for (const l of ['L2', 'DL1', 'DL2', 'DL3']) { try { out.push(...readLayer(l)) } catch { /* 忽略 */ } }
    return out
  }

  function graveyard({ limit = 50 } = {}) {
    let raw = ''
    try { raw = readFileSync(gravePath, 'utf8') } catch { return [] }
    return raw.split(/\r?\n/).filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }

  function dumpVectors(p) {
    const out = {}
    for (const [id, v] of vectors) out[id] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
    writeFileSync(p, JSON.stringify(out), 'utf8')
  }

  let timer = null
  function start(opts = {}) {
    stop()
    const every = Number(opts.organizeEveryMs || cfg.organizeEveryMs) || 5 * 60 * 1000
    // 只有这一个定时器：整理里会按 viewRefreshMs 判断要不要重写 L3。
    // 不再单开一个 L3 定时器——那会在没拿钥匙时写 L3，等于第二个写者。
    timer = setInterval(() => { organize().catch(() => {}) }, every)
    if (timer.unref) timer.unref()
    // 启动补一轮（异步，不阻塞加载）
    Promise.resolve().then(() => organize()).catch(() => {})
  }
  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  loadVectors()

  return {
    // 写
    write, writeMany, writeTurn,
    // 读
    buildBlock, search, list, stats,
    // 维护
    organize, sweep: organize, start, stop,
    refreshL3, graveyard, dumpVectors,
    // 信号
    attend, pin, forget,
    // 兼容旧调用：split 布局没有"待摘要队列"，整理统一由 organize() 做
    flushSummaries: async () => 0,
    pendingSummaries: () => 0,
    // 常量 / 调试
    LAYER, cfg, dir, writer, _paths: paths, _readLayer: readLayer,
  }
}
