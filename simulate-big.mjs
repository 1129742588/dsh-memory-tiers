/**
 * 大规模压测 —— `node simulate-big.mjs`
 *
 * 数据来源：.dataset.json（由 build-dataset.mjs 从真实 livingmemory 生成）
 *   1806 条 / 60 天，其中 762 条是真实原子记忆和真实群聊消息，1044 条是按真实句式生成的变体。
 *
 *   node simulate-big.mjs          接模型（约 10 分钟）
 *   node simulate-big.mjs --local  不联网，只验机制（几秒）
 *
 * 这一轮要看的是"规模上来之后会不会露馅"：
 *   ① 多次分流后分层还稳不稳（L1 不超容量、DL2 不爆）
 *   ② 摘要在上百条量级还压不压得动、跨天捆绑到什么程度
 *   ③ 检索在 1800 条里还准不准（噪音会不会淹没结果）
 *   ④ 调用成本：1800 条到底花了多少往返
 *   ⑤ 90 天后深层忘掉多少
 */

import { rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createMemory5, LAYER, DAY, dayKey } from './memory5.mjs'
import { createSilicon, keyFromAstrbot } from './silicon.mjs'

const LOCAL = process.argv.includes('--local')
const DIR = LOCAL ? '.big-local' : '.big'
const DATASET = '.dataset.json'
const ASTRBOT_CFG = 'C:/Users/Anxiple/.astrbot_launcher/instances/56f66ac7-8570-41f3-82f3-91adacb6a65a/core/data/cmd_config.json'

if (!existsSync(DATASET)) {
  console.error('缺 .dataset.json，先跑 node build-dataset.mjs')
  process.exit(1)
}

const ds = JSON.parse(readFileSync(DATASET, 'utf8'))

// ──────────────────────────────────────────────────────────────
// 单实例锁
//
// ★ 为什么要有：我踩过一次——同一个命令被连着执行两遍，
//   两个进程同时往 `.big` 里写，结果 store.json 剩 86 条、
//   store_final.json 是 178 条，健康检查读到的是"另一个进程的中间态"，
//   台账检查也报 0（其实是另一个进程刚 rm 掉目录）。
//
//   两个进程抢一个目录会同时污染：数据、审计日志、统计数字。
//   这里落一个 PID 锁，第二个进程直接退出，不许写。
// ──────────────────────────────────────────────────────────────
const LOCK = `${DIR}.lock`
function acquireLock() {
  try {
    if (existsSync(LOCK)) {
      const pid = Number(readFileSync(LOCK, 'utf8').trim())
      let alive = false
      try { process.kill(pid, 0); alive = true } catch { alive = false }
      if (alive && pid !== process.pid) {
        console.log(`已有压测进程在跑（PID ${pid}），本次退出。`)
        console.log(`确认没在跑的话，删掉 ${LOCK} 再试。`)
        process.exit(2)
      }
    }
  } catch { /* 锁损坏就当没有 */ }
  writeFileSync(LOCK, String(process.pid))
  const release = () => { try { if (readFileSync(LOCK, 'utf8').trim() === String(process.pid)) rmSync(LOCK) } catch {} }
  process.on('exit', release)
  process.on('SIGINT', () => { release(); process.exit(130) })
}
acquireLock()

// 清目录要小心：目录里文件一多，环境的批量删除保护会拦下来
// （117 个文件 > 阈值 100 时报 SAFE_DELETE_BULK_CONFIRM_REQUIRED）。
// 拦下来就换个带时间戳的新目录，别让清理动作把整个压测卡死。
let OUT_DIR = DIR
try {
  rmSync(OUT_DIR, { recursive: true, force: true })
} catch {
  OUT_DIR = `${DIR}-${Date.now()}`
  console.log(`旧目录删不掉（文件太多被保护拦下），改用 ${OUT_DIR}`)
}
mkdirSync(OUT_DIR, { recursive: true })

// ──────────────────────────────────────────────────────────────
let clock = ds.items[0].at
const lines = []
const log = (x = '') => { console.log(x); lines.push(x) }
const head = (t) => log(`\n${'─'.repeat(72)}\n${t}`)

let api = null

// 按模型累计 token —— 跑完直接知道这一次压测花了多少，不用去翻账单。
// 注意：账单在 SiliconFlow 那边，不是 DeepSeek 官方——模型名虽然叫
// deepseek-ai/DeepSeek-V4.1-Flash，但走的是聚合平台的通道。
const usage = {}
// ★ 预算闸：--budget=300000 → 只要这次跑累计超过 30 万 token 就停掉模型调用，
//   自动降级到本地规则继续跑完（不停机、不报错，只是不再花钱）。
//   手滑重跑、误跑全量，都撞在这道闸上，不会一路烧到底。
const budgetArg = process.argv.find((a) => a.startsWith('--budget='))
const BUDGET = budgetArg ? Number(budgetArg.split('=')[1]) : 0

// ★ 分类时机：默认跟 cfg 一致（onOverflow）。--classify=onWrite 可切回老行为做对比。
const classArg = process.argv.find((a) => a.startsWith('--classify='))
const CLASSIFY_MODE = classArg ? classArg.split('=')[1] : 'onOverflow'

// ★ 分段计时：只测**网络**，不改 memory5 一行代码。
//   昨天卡在"写入计时 3.6 秒、两天之间却隔 18 秒"——
//   就是因为计时只罩住了 writeMany 那一段，罩不到里面某次调用。
//   这里在 provider 外面包一层，每个能力各自计时：
//   写入耗时 - Σ(网络耗时) = 本地计算耗时，账一下就平了。
const netMs = {}
let netDepth = 0          // 同时有几个请求在飞
let netBusyStart = 0      // 这一波网络忙碌的起点
let netBusy = 0           // 网络真正占用的墙钟时间（并发的只算一次）
const wrap = (name, fn) => async (...a) => {
  const t = Date.now()
  if (netDepth++ === 0) netBusyStart = t
  try {
    return await fn(...a)
  } finally {
    netMs[name] = (netMs[name] || 0) + (Date.now() - t)
    if (--netDepth === 0) netBusy += Date.now() - netBusyStart
  }
}
const resetNet = () => {
  for (const k of Object.keys(netMs)) delete netMs[k]
  netDepth = 0
  netBusy = 0
}
const sumNet = () => Object.values(netMs).reduce((a, b) => a + b, 0)

if (!LOCAL) {
  const cred = keyFromAstrbot(ASTRBOT_CFG)
  if (!cred) { console.log('没找到 key，改用 --local'); process.exit(1) }
  api = createSilicon({
    ...cred,
    budgetTokens: BUDGET,
    onUsage: (kind, tokens, model) => {
      const m = model || '(embed)'
      if (!usage[m]) usage[m] = { calls: 0, tokens: 0 }
      usage[m].calls++
      usage[m].tokens += Number(tokens) || 0
    },
  })
}

const mem = createMemory5({
  dir: OUT_DIR,
  now: () => clock,
  embed: api ? wrap('embed', (t) => api.embed(t)) : undefined,
  classify: api ? wrap('classify', (t) => api.classify(t)) : undefined,
  classifyBatch: api ? wrap('classifyBatch', (t) => api.classifyBatch(t)) : undefined,
  summarizeWithSources: api ? wrap('summarizeWithSources', (lines, ch, folks) => api.summarizeWithSources(lines, ch, folks)) : undefined,
  judgeRelation: api ? wrap('relation', (a, b) => api.relation(a, b)) : undefined,
  rerank: api ? wrap('rerank', (q, docs, n) => api.rerank(q, docs, n)) : undefined,
  summarize: api
    ? wrap('summarize', async (texts, channel, people) => {
        const focus = {
          dialog: '重点：谁说了什么、定了什么、聊到哪了。每句必须有主语（人名）。',
          action: '重点：做了什么、结果如何、数字变化。',
          event: '重点：发生了什么。细节可以模糊，但"发生过什么"的骨架必须留住。',
        }[channel] || '重点：发生了什么、得出什么结论。'
        return api.summarize(texts, focus, channel)
      })
    : undefined,
  compress: undefined,     // ★ 模型压缩已停用（实测一个字都减不掉），不给 provider 就走本地
  cfg: {
    // 及时层 900 字 → 每天 30 条 × 30 字 ≈ 900，等于天天溢出、天天分流。
    // 分流本身不贵，但 core 组（≥2 条）每次要调一次大模型压摘要，
    // 一天一次就是 60 次 × 6 秒。调到 1500 变成约两天一次，压测快一倍。
    hotMaxChars: 1500,           // 及时层上限
    hotMaxItems: 200,
    consolidateMaxChars: 3000,
    consolidateDays: 7,
    longMaxChars: 1500,
    // DL2 压缩每次都要调模型（一条 1-2 秒）。压测关心的是分层和检索，
    // 压缩质量不是重点，调大上限直接不触发。
    dl2MaxChars: 60000,
    dl2CompressTarget: 300,
    fusionEveryNWrites: 60,
    summarizeMode: 'deferred',   // 摘要后台跑，不卡写入
    classifyMode: CLASSIFY_MODE, // onOverflow（默认）| onWrite（老行为）
  },
})

// ──────────────────────────────────────────────────────────────
// 按天分组
// ──────────────────────────────────────────────────────────────
const byDay = new Map()
for (const it of ds.items) {
  const d = new Date(it.at).toISOString().slice(0, 10)
  if (!byDay.has(d)) byDay.set(d, [])
  byDay.get(d).push(it)
}
const ALL_DAYS = [...byDay.keys()].sort()
// --days=N 只跑前 N 天，用来测速（全量跑一次十几分钟，改完代码不方便每次全跑）
const limitArg = process.argv.find((a) => a.startsWith('--days='))
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : ALL_DAYS.length
const days = ALL_DAYS.slice(0, LIMIT)

const N_ITEMS = days.reduce((n, d) => n + byDay.get(d).length, 0)
head(`压测：${N_ITEMS} 条 / ${days.length} 天${LIMIT < ALL_DAYS.length ? '（测速模式）' : ''}（${LOCAL ? '本地规则' : '真实模型'}）`)
log(`  真实 ${ds.meta.real} 条（原子记忆 ${ds.meta.realAtoms} + 群聊消息）× 生成 ${ds.meta.gen} 条`)
log(`  说话人 ${ds.meta.speakers.length} 个`)

let totalWrite = 0
let totalSum = 0
const timeline = []
let lastDayMs = Date.now()

// ──────────────────────────────────────────────────────────────
// 心跳文件
//
// ★ 为什么要有：跑 60 天要二十来分钟，中间如果卡住（网络抽风、429 退避、
//   死循环），光看 stdout 是看不出来的——它是一个 200 行的滚动日志，
//   而且我（和用户）都不是一直盯着。
//
//   每天写一次 progress.json，里面带**时间戳**。判断"是不是卡了"不用看内容，
//   只看这个文件的 mtime 有多久没动：超过 3 分钟没更新就是卡住了。
//
//   同时 stdout 每天打一行，用户用 tail 就能看到进度。
// ──────────────────────────────────────────────────────────────
const PROGRESS = join(OUT_DIR, 'progress.json')
const runStart = Date.now()
let doneItems = 0

function beat(stage, extra = {}) {
  const now = Date.now()
  const elapsed = now - runStart
  const pct = N_ITEMS ? doneItems / N_ITEMS : 0
  const eta = pct > 0.02 ? Math.round((elapsed / pct) * (1 - pct) / 1000) : null
  const tok = Object.values(usage).reduce((n, u) => n + u.tokens, 0)
  const snap = {
    pid: process.pid,
    at: new Date(now).toISOString(),
    stage,
    day: extra.day || null,
    dayIndex: extra.dayIndex ?? null,
    totalDays: days.length,
    doneItems,
    totalItems: N_ITEMS,
    pct: Number((pct * 100).toFixed(1)),
    elapsedSec: Math.round(elapsed / 1000),
    etaSec: eta,
    tokens: tok,
    budget: BUDGET || 0,
    // 卡住时能看出卡在哪一段：write = 写入，summary = 摘要队列
    lastWriteMs: extra.writeMs ?? null,
    lastSumMs: extra.sumMs ?? null,
    ...(extra.extra || {}),
  }
  try { writeFileSync(PROGRESS, JSON.stringify(snap, null, 2)) } catch { /* 写不进去不影响主流程 */ }
}

beat('start')

for (let i = 0; i < days.length; i++) {
  const d = days[i]
  const list = byDay.get(d)
  clock = Math.max(...list.map((x) => x.at))

  resetNet()
  const dayStart = Date.now()
  beat('write', { day: d, dayIndex: i + 1 })

  const t0 = Date.now()
  await mem.writeMany(list)
  const ms = Date.now() - t0
  const netWrite = sumNet()
  totalWrite += ms
  doneItems += list.length
  beat('summary', { day: d, dayIndex: i + 1, writeMs: ms })

  const pending = mem.pendingSummaries()
  const netBeforeSum = sumNet()
  const t1 = Date.now()
  await mem.flushSummaries()
  const msSum = Date.now() - t1
  const netSum = sumNet() - netBeforeSum
  totalSum += msSum

  const dayMs = Date.now() - dayStart
  const netAll = sumNet()
  // ★ 本地耗时要用"网络占用的墙钟时间"来减，不能用"各请求耗时之和"。
  //   并发请求时后者会被重复累加（两个 1.5 秒的并发摘要 = 和 3 秒，实际只过了 1.5 秒），
  //   减出来就是负数——上一版就是这么算出 -843ms 的。
  const localMs = dayMs - netBusy

  const s = mem.stats()
  timeline.push({
    day: d, add: list.length, ms, msSum, dayMs, localMs,
    net: { ...netMs },
    count: { ...s.count }, chars: { ...s.chars }, total: s.total,
  })
  beat('day-done', { day: d, dayIndex: i + 1, writeMs: ms, sumMs: msSum })

  // 每天都打一行（原来每 5 天，结果卡住时一分钟没输出，看不出是慢还是死）
  {
    const elapsed = ((Date.now() - lastDayMs) / 1000).toFixed(0)
    const net = Object.entries(netMs)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(' ')
    log(
      `  ${d.slice(5)} (${i + 1}/${days.length}) +${list.length} ` +
      `写 ${String(ms).padStart(4)}ms` +
      (msSum ? ` 摘 ${String(msSum).padStart(5)}ms(${pending})` : '            ') +
      ` | L1=${String(s.count.L1).padStart(3)} L2=${String(s.count.L2).padStart(2)} L3=${String(s.count.L3).padStart(2)} ` +
      `DL1=${String(s.count.DL1).padStart(3)} DL2=${String(s.count.DL2).padStart(2)} DL3=${String(s.count.DL3).padStart(2)} ` +
      `共${String(s.total).padStart(4)} | ${elapsed}s`
    )
    // ★ 分段账：网络 vs 本地。这两个加起来必须等于当天总耗时，对不上就是有漏网的
    log(`        当天 ${dayMs}ms = 网络忙 ${netBusy}ms(请求累计 ${netAll}ms) + 本地 ${localMs}ms   明细: ${net || '无网络调用'}`)
    lastDayMs = Date.now()
  }
}

const sEnd = mem.stats()

// ──────────────────────────────────────────────────────────────
head('最终分布')
log(`  ${JSON.stringify(sEnd.count)}`)
log(`  通道：${JSON.stringify(sEnd.byChannel)}`)
log(`  字数：${JSON.stringify(sEnd.chars)}`)
log(`  总条数 ${sEnd.total}，向量 ${sEnd.vectors}`)

head('调用统计')
log('  ' + '能力'.padEnd(12) + '请求'.padEnd(8) + '波次'.padEnd(8) + '条目')
let roundsAll = 0
for (const [k, v] of Object.entries(sEnd.calls)) {
  if (!v.rounds) continue
  roundsAll += v.rounds
  log(`  ${k.padEnd(12)}${String(v.rounds).padEnd(8)}${String(v.waves).padEnd(8)}${v.items}`)
}
log(`  合计 ${roundsAll} 次调用`)
log(`  写入总耗时 ${(totalWrite / 1000).toFixed(0)}s（平均每条 ${(totalWrite / N_ITEMS).toFixed(0)}ms）`)
log(`  摘要总耗时 ${(totalSum / 1000).toFixed(0)}s（后台）`)
log(`  平均每天 ${(totalWrite / days.length / 1000).toFixed(1)}s 写入`)

// ── 模型调用闸门 ──
// 每一次**没调**模型都记了原因。这张表就是"凭什么不用调"的账。
head('模型调用闸门')
let savedCalls = 0
for (const [k, g] of Object.entries(sEnd.gates)) {
  const skips = Object.entries(g.skipped).sort((a, b) => b[1] - a[1])
  const skipTotal = skips.reduce((n, [, v]) => n + v, 0)
  savedCalls += skipTotal
  log(`  ${k.padEnd(10)} 调用 ${String(g.called).padStart(4)} 次  跳过 ${String(skipTotal).padStart(4)} 次`)
  for (const [r, v] of skips) log(`    · ${r} — ${v} 次`)
}
log(`  合计跳过 ${savedCalls} 次模型调用`)
log(`  分类时机：${CLASSIFY_MODE}`)

// ── token 记账 ──
// 这个数字比账单可靠：账单在 SiliconFlow 上，还混着你机器人平时跑的量，
// 分不清哪部分是压测花的。这里只统计本次进程实际消耗的。
const tokTotal = Object.values(usage).reduce((n, u) => n + u.tokens, 0)
if (tokTotal) {
  log('')
  log('  token 消耗（本次压测）：')
  for (const [m, u] of Object.entries(usage).sort((a, b) => b[1].tokens - a[1].tokens)) {
    log(`    ${m.padEnd(34)} ${String(u.calls).padStart(4)} 次  ${String(u.tokens).padStart(8)} token`)
  }
  log(`    合计 ${tokTotal} token，平均每条 ${(tokTotal / N_ITEMS).toFixed(0)} token`)
}
if (api) {
  const u = api.usage()
  log(`    预算 ${u.limit || '不限'}，已用 ${u.used}，剩余 ${u.limit ? u.remaining : '—'}${u.exhausted ? '  ★ 已撞预算上限，后续降级为本地规则' : ''}`)
}

// ──────────────────────────────────────────────────────────────
head('分层健康度')
const chk = []
const add = (name, ok, detail) => { chk.push({ name, ok, detail }); log(`  ${ok ? '✓' : '✗'} ${name.padEnd(26)} ${detail}`) }

add('L1 不超容量', sEnd.chars.L1 <= mem.cfg.hotMaxChars, `${sEnd.chars.L1} 字 / ${mem.cfg.hotMaxChars}`)
add('L2 不超容量', sEnd.chars.L2 <= 3000, `${sEnd.chars.L2} 字 / 3000`)
add('L3 视图不超', sEnd.chars.L3 <= 1500, `${sEnd.chars.L3} 字 / 1500`)
add('DL2 不超容量', sEnd.chars.DL2 <= mem.cfg.dl2MaxChars, `${sEnd.chars.DL2} 字 / ${mem.cfg.dl2MaxChars}`)
add('向量与条目一致', sEnd.vectors === sEnd.total, `${sEnd.vectors} / ${sEnd.total}`)

// 摘要质量
const sums = mem.list().filter((it) => it.kind === 'summary')
const badSpan = sums.filter((it) => !it.spanFrom || !it.spanTo || it.spanFrom > it.spanTo)
const noPeople = sums.filter((it) => !(it.people || []).length)
const longSpan = sums.filter((it) => (it.spanTo - it.spanFrom) / DAY > 14)
add('摘要都带 span', badSpan.length === 0, `${sums.length} 条，异常 ${badSpan.length}`)
add('摘要都带 people', noPeople.length === 0, `缺 ${noPeople.length}`)
add('跨天超过 14 天的摘要', longSpan.length <= sums.length * 0.2, `${longSpan.length} / ${sums.length}`)

// 作废条
const dead = mem.list().filter((it) => it.supersededBy)
add('有作废条（矛盾检测在工作）', dead.length > 0, `${dead.length} 条`)
const deadInActive = dead.filter((it) => it.layer === LAYER.HOT || it.layer === LAYER.CONSOLIDATE)
add('作废条不在活跃层', deadInActive.length === 0, `${deadInActive.length} 条残留`)

// 台账
const gy = mem.graveyard({ limit: 500 })
add('台账有内容', gy.length > 0, `${gy.length} 条遗忘记录`)

// ──────────────────────────────────────────────────────────────
head('摘要抽样（看压得对不对）')
const byCh = new Map()
for (const it of sums) {
  if (!byCh.has(it.channel)) byCh.set(it.channel, [])
  byCh.get(it.channel).push(it)
}
for (const [ch, list] of byCh) {
  log(`\n  [${ch}] ${list.length} 条`)
  for (const it of list.slice(0, 2)) {
    const from = dayKey(it.spanFrom).slice(5)
    const to = dayKey(it.spanTo).slice(5)
    const spanDays = ((it.spanTo - it.spanFrom) / DAY).toFixed(0)
    log(`    ${from}~${to}（${spanDays}天，来源${(it.sources || []).length}条）`)
    for (const line of String(it.text).split('\n').slice(0, 4)) log(`      ${line}`)
  }
}

// ──────────────────────────────────────────────────────────────
head('检索实测（在 1800 条里翻）')

clock = Math.max(...ds.items.map((x) => x.at)) + DAY

// ★ 两个模式对照：概要（只查摘要层）vs 细节（摘要层 + 原文层）
const queries = [
  ['之前群里聊了什么', { depth: 'brief' }],
  ['我做过哪些事', { depth: 'brief' }],
  ['主人说过什么规矩', { depth: 'detail' }],
  ['奶龙', {}],
  ['表情包互换', { depth: 'detail' }],
  ['星鲸说过什么', { person: '星鲸' }],
  ['谁提过传送僵尸', {}],
  ['刷到什么了', {}],
  ['完全不存在的话题', {}],
]

const searchResults = []
for (const [q, opt] of queries) {
  const t0 = Date.now()
  const r = await mem.search(q, opt)
  const ms = Date.now() - t0
  searchResults.push({ q, n: r.hits.length, ms, depth: r.depth, stages: r.stages, top: r.hits.slice(0, 3) })
  log(`\n  「${q}」 ${r.hits.length} 条 ${ms}ms  [${r.depth}] 扫了 ${(r.stages || []).join(' → ')}  conf=${r.confidence ?? '-'}${r.timeWindow ? `  窗 ${r.timeWindow.from}~${r.timeWindow.to}` : ''}`)
  log(`    建议：${r.advice || '-'}`)
  for (const h of r.hits.slice(0, 3)) {
    log(`    [${h.layer}/${h.channel}] ${h.when.slice(5, 16)} ${String(h.text).replace(/\s+/g, ' ').slice(0, 54)}`)
  }
  if (!r.hits.length) log('    （无命中）')
}

// ──────────────────────────────────────────────────────────────
head('最终注入样例（2000 字预算）')
const block = mem.buildBlock(2000)
log(block)
log(`\n  注入块 ${block.length} 字`)

// ──────────────────────────────────────────────────────────────
// 快照 + 衰减
// ──────────────────────────────────────────────────────────────
copyFileSync(join(OUT_DIR, 'store.json'), join(OUT_DIR, 'store_final.json'))
mem.dumpVectors(join(OUT_DIR, 'vectors_final.json'))   // 向量已分片，导出合并快照

head('快进衰减（不写入，只看深层忘掉多少）')
const before = mem.stats()
for (const step of [30, 90, 180]) {
  clock += step * DAY
  await mem.flushSummaries()
  await mem.sweep(clock)
  const s = mem.stats()
  log(`  +${step} 天：DL1 ${before.count.DL1}→${s.count.DL1}  DL2 ${before.count.DL2}→${s.count.DL2}  DL3 ${before.count.DL3}→${s.count.DL3}  L3视图 ${mem.list(LAYER.LONG).length}`)
  before.count = { ...s.count }
}

// ──────────────────────────────────────────────────────────────
// 报告
// ──────────────────────────────────────────────────────────────
const passRate = chk.filter((c) => c.ok).length

const report = [
  `# 大规模压测报告（${LOCAL ? '本地规则' : '真实模型'}）`,
  '',
  `- 数据：\`.dataset.json\` —— ${ds.items.length} 条 / ${days.length} 天`,
  `- 真实 ${ds.meta.real} 条（原子记忆 ${ds.meta.realAtoms} + 群聊消息），生成 ${ds.meta.gen} 条变体`,
  `- 说话人 ${ds.meta.speakers.length} 个`,
  `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
  '',
  '## 一、检查项',
  '',
  '| 项 | 结果 | 详情 |',
  '|---|---|---|',
  ...chk.map((c) => `| ${c.name} | ${c.ok ? '✓' : '✗'} | ${c.detail} |`),
  '',
  `**${passRate} / ${chk.length} 通过**`,
  '',
  '## 二、分层演进',
  '',
  '| 天 | 新增 | 写入 | 摘要 | L1 | L2 | L3 | DL1 | DL2 | DL3 | 总 |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...timeline.map((x) =>
    `| ${x.day.slice(5)} | ${x.add} | ${x.ms}ms | ${x.msSum ? x.msSum + 'ms' : '—'} | ${x.count.L1} | ${x.count.L2} | ${x.count.L3} | ${x.count.DL1} | ${x.count.DL2} | ${x.count.DL3} | ${x.total} |`
  ),
  '',
  '## 三、最终分布',
  '',
  '```json',
  JSON.stringify({ count: sEnd.count, byChannel: sEnd.byChannel, chars: sEnd.chars, total: sEnd.total, vectors: sEnd.vectors }, null, 2),
  '```',
  '',
  '## 四、调用成本',
  '',
  '| 能力 | 请求 | 波次 | 条目 |',
  '|---|---|---|---|',
  ...Object.entries(sEnd.calls).filter(([, v]) => v.rounds).map(([k, v]) => `| ${k} | ${v.rounds} | ${v.waves} | ${v.items} |`),
  '',
  '### token 消耗（本次压测实测）',
  '',
  '| 模型 | 次数 | token |',
  '|---|---|---|',
  ...Object.entries(usage).sort((a, b) => b[1].tokens - a[1].tokens).map(([m, u]) => `| ${m} | ${u.calls} | ${u.tokens} |`),
  '',
  `合计 **${tokTotal} token**，平均每条 ${(tokTotal / Math.max(N_ITEMS, 1)).toFixed(0)} token`,
  '',
  '> 账单在 SiliconFlow 那边（模型虽叫 deepseek-ai/DeepSeek-V4.1-Flash，走的是聚合平台通道），',
  '> 且和机器人平时的调用混在一起。这个数字只统计本次进程实际消耗的。',
  '',
  `- 合计 ${roundsAll} 次调用`,
  `- 写入 ${(totalWrite / 1000).toFixed(0)}s（平均每条 ${(totalWrite / ds.items.length).toFixed(0)}ms）`,
  `- 摘要 ${(totalSum / 1000).toFixed(0)}s（后台）`,
  '',
  '## 五、检索结果',
  '',
  '| 查询 | 命中 | 耗时 |',
  '|---|---|---|',
  ...searchResults.map((r) => `| ${r.q} | ${r.n} | ${r.ms}ms |`),
  '',
  '## 六、摘要抽样',
  '',
  ...byCh.entries().flatMap(([ch, list]) => [
    `### ${ch}（${list.length} 条）`,
    '',
    ...list.slice(0, 4).map((it) => {
      const from = dayKey(it.spanFrom).slice(5)
      const to = dayKey(it.spanTo).slice(5)
      return `**${from}~${to}**（来源 ${(it.sources || []).length} 条）\n\n\`\`\`\n${it.text}\n\`\`\`\n`
    }),
  ]),
  '',
  '## 七、最终注入',
  '',
  '```',
  block,
  '```',
  '',
].join('\n')

writeFileSync(join(OUT_DIR, '报告.md'), report, 'utf8')
writeFileSync(join(OUT_DIR, '完整输出.txt'), lines.join('\n'), 'utf8')
// ★ timeline 落盘：analyze-scale.mjs 靠它算「库大小 vs 各阶段耗时」的趋势。
//   不落盘的话只能从文本报告里正则抠，容易错。
writeFileSync(join(OUT_DIR, 'timeline.json'), JSON.stringify(timeline, null, 1), 'utf8')

console.log(`\n${'='.repeat(72)}`)
console.log(`  ${passRate} / ${chk.length} 检查项通过`)
console.log(`  报告：${OUT_DIR}/报告.md`)
console.log(`  快照：${OUT_DIR}/store_final.json（最终的完整状态）`)
console.log('='.repeat(72))
