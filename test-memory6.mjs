/**
 * memory6（六文件布局）端到端测试
 * 跑：node test-memory6.mjs
 */
import { createMemory6, pickTurnBatch } from './memory6.mjs'
import { rmSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}
const chars = (list) => list.reduce((s, it) => s + String(it?.text || '').length, 0)
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const items = (dir, name) => readJson(`${dir}/${name}.json`).items
const layerFiles = (dir) => readdirSync(`${dir}/L1.tmp`).filter((f) => f.endsWith('.jsonl'))

// —— 假模型：只按关键词给向量，摘要按模式返回 ——
const embed = async (texts) => texts.map((t) => {
  const v = [0, 0, 0]
  if (/爬山|山/.test(t)) v[0] = 1
  if (/表情/.test(t)) v[1] = 1
  if (/项目|路径/.test(t)) v[2] = 1
  return v
})
let mode = 'citeAll'
const summarizeWithSources = async (lines) => {
  if (mode === 'keepAll') return { summaries: [], keep: lines.map((_, i) => i + 1) }
  if (mode === 'citeOne') return { summaries: [{ text: 'S:' + lines[0].slice(0, 30), sources: [1], importance: 0.9 }], keep: [] }
  if (mode === 'citeNone') return { summaries: [], keep: [] }
  return { summaries: [{ text: 'S:' + lines.join('|').slice(0, 60), sources: lines.map((_, i) => i + 1), importance: 0.9 }], keep: [] }
}
let rel = 'unrelated'
const judgeRelation = async () => rel
const rerank = async (q, docs) => docs.map((d, i) => (/爬山/.test(d) ? 0.9 : 0.1) - i * 0.01)

const baseCfg = {
  hotMaxChars: 140, hotMaxItems: 100, quietMs: 0,
  consolidateMaxChars: 100, consolidateMaxItems: 100,
  longMaxChars: 300, hotQuotaOwn: 0.7,
  organizeEveryMs: 9999999, viewRefreshMs: 9999999,
}
const mk = (dir, writer, cfg = {}) => createMemory6({
  dir, writer, embed, summarizeWithSources, judgeRelation, rerank,
  embedSignature: 'test:fake', cfg: { ...baseCfg, ...cfg },
})

// ============================================================
console.log('① 写：只进 temp，注入立刻能看见')
// ============================================================
const D = '.test-m6'
rmSync(D, { recursive: true, force: true })
const a = mk(D, 'dsh')
{
  const r = await a.writeTurn([
    { text: 'A端 爬山 讨论 ' + 'x'.repeat(40), speaker: 'user', channel: 'dialog' },
    { text: 'A端 回复 ' + 'y'.repeat(30), speaker: 'bot', channel: 'dialog' },
  ])
  ok('writeTurn 成功', r.ok === true)
  ok('temp 文件存在', existsSync(`${D}/L1.tmp/dsh.jsonl`))
  const b = mk(D, 'astrbot')
  ok('另一端注入能看到（还没整理）', b.buildBlock().includes('爬山'))
  ok('stats 把 temp 算进 L1', a.stats().count.L1 === 2, JSON.stringify(a.stats().count))
}

// ============================================================
console.log('② 合并：拿钥匙 → temp 清空 → 真 L1 有货')
// ============================================================
{
  const o = await a.organize()
  ok('organize 成功', o.ok === true, JSON.stringify(o))
  ok('temp 已清空', layerFiles(D).length === 0, layerFiles(D).join(','))
  const l1 = items(D, 'L1')
  ok('真 L1 有 2 条（没超容量，不该摘要）', l1.length === 2, String(l1.length))
  ok('合并后另一端也能看到', mk(D, 'astrbot').buildBlock().includes('爬山'))
}

// ============================================================
console.log('③ L1 溢出：按整轮取，剩下的 ≤ 一半')
// ============================================================
{
  mode = 'citeAll'
  for (let i = 0; i < 4; i++) {
    await a.writeTurn([
      { text: `第${i}轮 爬山 ` + 'z'.repeat(45), speaker: 'user', channel: 'dialog', turnId: `t${i}` },
      { text: `第${i}答 ` + 'w'.repeat(35), speaker: 'bot', channel: 'dialog', turnId: `t${i}` },
    ])
  }
  const o = await a.organize()
  ok('organize 成功', o.ok === true, JSON.stringify(o))
  const l1 = items(D, 'L1')
  ok('L1 剩下的字数 ≤ 一半', chars(l1) <= 70, String(chars(l1)))
  const dl2 = items(D, 'DL2')
  const dl3 = items(D, 'DL3')
  ok('产物进了 DL3（摘要）', dl3.length >= 1, String(dl3.length))
  ok('被引用的原文进了 DL2', dl2.length >= 6, String(dl2.length))
  // 整轮不拆：每个 turnId 要么全在 L1，要么全不在
  const l1Turns = new Set(l1.map((it) => it.turnId || it.id))
  const dl2Turns = new Set(dl2.map((it) => it.turnId || it.id))
  const split = [...l1Turns].some((t) => dl2Turns.has(t))
  ok('没有轮次被 L1/DL2 拆开', !split)
}

// ============================================================
console.log('④ 检索：summary 命中摘要，detail 顺着 sources 取原文')
// ============================================================
{
  const s1 = await a.search('爬山', { depth: 'summary' })
  ok('summary 有命中', s1.hits.length >= 1, String(s1.hits.length))
  ok('命中的是摘要', s1.hits[0].kind === 'summary', s1.hits[0].kind)
  const s2 = await a.search('爬山', { depth: 'detail' })
  ok('detail 带出原文', s2.hits.some((h) => h.layer === 'DL2'), JSON.stringify(s2.hits.map((h) => h.layer)))
  ok('原文标了 via（顺着 sources）', s2.hits.some((h) => h.via), '')
}

// ============================================================
console.log('⑤ 两端：另一端写入也能被合并、看见')
// ============================================================
{
  mode = 'citeAll'
  const b = mk(D, 'astrbot')
  await b.writeTurn([{ text: 'B端 表情包 ' + 'q'.repeat(30), speaker: 'user', channel: 'dialog' }])
  await a.organize()
  ok('两个 temp 都清空', layerFiles(D).length === 0, layerFiles(D).join(','))
  ok('dsh 注入能看到 B 端', a.buildBlock().includes('表情包'))
  ok('astrbot 注入能看到 A 端', b.buildBlock().includes('爬山'))
}

// ============================================================
console.log('⑥ 钥匙：别人拿着时，本轮不整理，但写入不受影响')
// ============================================================
{
  writeFileSync(`${D}/organize.lock`, JSON.stringify({ pid: 1, writer: 'x', at: Date.now() }))
  const o = await a.organize()
  ok('拿不到钥匙 → 跳过', o.skipped === 'busy', JSON.stringify(o))
  const w = await a.writeTurn([{ text: '锁着也能写 ' + 'k'.repeat(20), speaker: 'user' }])
  ok('写入不受影响', w.ok === true)
  rmSync(`${D}/organize.lock`, { force: true })
  ok('lock 释放后能整理', (await a.organize()).ok === true)
}

// ============================================================
console.log('⑦ 轮次算法：整轮、不切断')
// ============================================================
{
  const mkRow = (id, tid, t, n = 20) => ({ id, turnId: tid, text: 'x'.repeat(n), createdAt: t })
  const list = [
    mkRow('a1', 't1', 100), mkRow('a2', 't1', 101),
    mkRow('b1', 't2', 200), mkRow('b2', 't2', 201),
    mkRow('c1', 't3', 300), mkRow('c2', 't3', 301),
    mkRow('d1', 't4', 400), mkRow('d2', 't4', 401),
  ]
  const out = pickTurnBatch(list, 100, { quietBefore: 0 })
  const tids = new Set(out.map((it) => it.turnId))
  const remaining = chars(list.filter((it) => !out.includes(it)))
  ok('取出来的是整轮', [...tids].every((t) => out.filter((x) => x.turnId === t).length === 2), [...tids].join(','))
  ok('剩下的字数 ≤ 一半', remaining <= 50, String(remaining))
  const quiet = pickTurnBatch(list, 100, { quietBefore: 150 })
  ok('安静窗口：只取安静的轮次', quiet.every((it) => it.turnId === 't1'), [...new Set(quiet.map((i) => i.turnId))].join(','))

  // 条数兜底：字数没超、但条数超了，也要能溢出
  const many = Array.from({ length: 300 }, (_, i) => ({ id: 'x' + i, turnId: 't' + i, text: 'x', createdAt: i }))
  const byCount = pickTurnBatch(many, 10000, { maxItems: 200 })
  ok('条数超限也会取（剩 ≤ 一半条数）', many.length - byCount.length <= 100, String(many.length - byCount.length))
}

// ============================================================
console.log('⑧ 信号：attend / pin / forget')
// ============================================================
{
  const E = '.test-m6-sig'
  rmSync(E, { recursive: true, force: true })
  mode = 'citeOne'
  const c = mk(E, 'dsh', { hotMaxChars: 60, consolidateMaxChars: 99999, consolidateMaxItems: 999 })
  await c.writeTurn([
    { text: '甲 ' + 'a'.repeat(40), speaker: 'user', turnId: 't1', channel: 'dialog' },
    { text: '乙 ' + 'b'.repeat(40), speaker: 'bot', turnId: 't1', channel: 'dialog' },
  ])
  await c.organize()
  const dl1 = items(E, 'DL1')
  ok('DL1 有 1 条', dl1.length === 1, String(dl1.length))
  const target = dl1[0].id

  c.cfg.hotMaxChars = 999999
  c.cfg.consolidateMaxChars = 999999
  c.attend([target])
  await c.organize()
  ok('attend 把它升回 L2', items(E, 'L2').some((it) => it.id === target))
  const after = items(E, 'L2').find((it) => it.id === target)
  ok('attend 涨了热度', after.heat > 1 || after.recallCount > 0, JSON.stringify({ heat: after.heat, recall: after.recallCount }))

  c.pin(target)
  await c.organize()
  ok('pin 生效', items(E, 'L2').find((it) => it.id === target)?.pinned === true)

  c.forget(target)
  await c.organize()
  const all = ['L1', 'L2', 'DL1', 'DL2', 'DL3'].flatMap((l) => items(E, l))
  ok('forget 删干净了', !all.some((it) => it.id === target))
  ok('台账里有记录', c.graveyard({ limit: 20 }).some((g) => g.id === target))
}

// ============================================================
console.log('⑨ L2 溢出：旧半（整轮）+ DL1 全部；+ 留 L2，绝不进 DL2')
// ============================================================
{
  const F = '.test-m6-l2'
  rmSync(F, { recursive: true, force: true })
  mode = 'keepAll'
  const c = mk(F, 'dsh', { hotMaxChars: 60, consolidateMaxChars: 999999, consolidateMaxItems: 999, l2KeepMax: 1 })
  for (let i = 0; i < 3; i++) {
    await c.writeTurn([
      { text: `轮${i}甲 ` + 'a'.repeat(30), turnId: `t${i}`, channel: 'dialog' },
      { text: `轮${i}乙 ` + 'b'.repeat(30), turnId: `t${i}`, channel: 'dialog' },
    ])
  }
  await c.organize()
  const l2before = items(F, 'L2')
  ok('L2 有货（keep 落缓冲层）', l2before.length > 0, String(l2before.length))

  // 再造一批 DL1 + 一条被引用的 DL2
  mode = 'citeOne'
  for (let i = 3; i < 5; i++) {
    await c.writeTurn([
      { text: `轮${i}甲 ` + 'a'.repeat(30), turnId: `t${i}`, channel: 'dialog' },
      { text: `轮${i}乙 ` + 'b'.repeat(30), turnId: `t${i}`, channel: 'dialog' },
    ])
  }
  await c.organize()
  const dl1before = items(F, 'DL1')
  ok('DL1 有货', dl1before.length > 0, String(dl1before.length))
  const dl2Before = items(F, 'DL2').length
  ok('DL2 里只有被引用的原文', dl2Before > 0, String(dl2Before))

  // 触发 L2 溢出：第二次的 + 只能留在 L2，超出的进 DL1，DL2 一条都不加
  c.cfg.hotMaxChars = 999999
  c.cfg.consolidateMaxChars = 10
  c.cfg.consolidateMaxItems = 1
  c.cfg.l2KeepMax = 1
  mode = 'keepAll'
  await c.organize()

  const dl2After = items(F, 'DL2')
  ok('第二次的 + 没有进 DL2', dl2After.length === dl2Before, `${dl2Before} → ${dl2After.length}`)
  ok('超出的 + 进了 DL1', items(F, 'DL1').length > 0, String(items(F, 'DL1').length))

  // 不变式：DL2 的每一条，都必须被某条 DL3 摘要引用
  const cited = new Set(items(F, 'DL3').flatMap((s) => s.sources || []))
  ok('DL2 全部有摘要引用', dl2After.every((it) => cited.has(it.id)), dl2After.map((i) => i.id).join(','))

  // 删掉摘要后，它的原文不能还留在 DL2（应归位 DL1）
  const sum = items(F, 'DL3')[0]
  if (sum?.sources?.length) {
    c.forget(sum.id)
    await c.organize()
    const dl2Ids = new Set(items(F, 'DL2').map((it) => it.id))
    ok('摘要删了之后 DL2 不留孤儿', sum.sources.every((id) => !dl2Ids.has(id)), sum.sources.join(','))
    ok('孤儿原文回到 DL1', sum.sources.every((id) => items(F, 'DL1').some((x) => x.id === id)), sum.sources.join(','))
  }
}

// ============================================================
console.log('⑩ 崩溃恢复：遗留 claimed 会被认领并合进 L1')
// ============================================================
{
  const G = '.test-m6-crash'
  rmSync(G, { recursive: true, force: true })
  mkdirSync(`${G}/L1.tmp`, { recursive: true })
  const now = Date.now()
  writeFileSync(`${G}/L1.tmp/dsh.claimed-1-abcd.jsonl`, JSON.stringify({
    id: 'crash1', text: '崩后恢复的一条', layer: 'L1', createdAt: now, turnId: 't9',
    origin: 'dsh', kind: 'raw', channel: 'dialog', importance: 0.5, heat: 1,
    lastMentionedAt: now, repeatStrength: 1,
  }) + '\n')
  const c = mk(G, 'dsh', { hotMaxChars: 999999 })
  const o = await c.organize()
  ok('organize 成功', o.ok === true, JSON.stringify(o))
  ok('claimed 被并进 L1', items(G, 'L1').some((it) => it.id === 'crash1'))
  ok('claimed 文件已删', !readdirSync(`${G}/L1.tmp`).some((f) => f.includes('claimed')))
}

// ============================================================
console.log('⑪ L1 注入配额：自己 ≤ 70%，剩下的给另一端')
// ============================================================
{
  const H = '.test-m6-quota'
  rmSync(H, { recursive: true, force: true })
  const cfg = { hotMaxChars: 500, hotQuotaOwn: 0.5, quietMs: 0 }
  const me = mk(H, 'dsh', cfg)
  const other = mk(H, 'astrbot', cfg)
  for (let i = 0; i < 2; i++) {
    await me.writeTurn([{ text: `我${i} ` + 'a'.repeat(95), speaker: 'user', turnId: `m${i}` }])
    await other.writeTurn([{ text: `他${i} ` + 'b'.repeat(95), speaker: 'user', turnId: `o${i}` }])
  }
  await me.organize()
  const block = me.buildBlock()
  const mineLines = block.split('\n').filter((l) => l.includes('[dsh'))
  const otherLines = block.split('\n').filter((l) => l.includes('[astrbot'))
  ok('自己的行 ≤ 50%（配额 0.5）', chars(mineLines.map((l) => ({ text: l }))) <= 260, String(chars(mineLines.map((l) => ({ text: l })))))
  ok('另一端的行也进得来', otherLines.length > 0, String(otherLines.length))
}

// ============================================================
console.log('⑫ 过期钥匙：心跳停了可以接管')
// ============================================================
{
  const now = Date.now()
  writeFileSync(`${D}/organize.lock`, JSON.stringify({ pid: 1, writer: 'dead', at: now - 20 * 60000, tab: 'old' }))
  utimesSync(`${D}/organize.lock`, new Date(now - 20 * 60000), new Date(now - 20 * 60000))
  const o = await a.organize()
  ok('过期钥匙能接管', o.ok === true, JSON.stringify(o))
  ok('用完释放', !existsSync(`${D}/organize.lock`))
}

// ============================================================
console.log('⑬ L3 快照：DL3 变了，没拿钥匙的那端注入也能立刻看见')
// ============================================================
{
  const H = '.test-m6-l3'
  rmSync(H, { recursive: true, force: true })
  mode = 'citeAll'          // 前面的用例把全局模式改成了 keepAll，这里要恢复
  const a = mk(H, 'dsh')
  const b = mk(H, 'astrbot')

  a.writeTurn([
    { text: '爬山' + 'x'.repeat(120), speaker: 'user', channel: 'dialog', turnId: 't1' },
    { text: '爬山回来' + 'y'.repeat(120), speaker: 'bot', channel: 'dialog', turnId: 't1' },
  ])
  const o1 = await a.organize()
  ok('dsh 整理成功', o1.ok === true, JSON.stringify(o1))
  ok('DL3 有摘要', items(H, 'DL3').length >= 1, String(items(H, 'DL3').length))
  ok('astrbot 能看到摘要', b.buildBlock().includes('一直记得的'))
  const snap1 = readJson(`${H}/L3.json`)
  ok('快照记了 DL3 版本', typeof snap1.dl3v === 'string' && snap1.dl3v.length > 0, JSON.stringify(snap1.dl3v))

  // 模拟"另一端刚整理完、快照还没轮到"：手工往 DL3 加一条，L3.json 不动
  const dl3 = readJson(`${H}/DL3.json`)
  const at = Date.now()
  dl3.items.push({
    id: 'manual1', text: '手动加的摘要', kind: 'summary', layer: 'DL3', channel: 'dialog',
    importance: 0.9, heat: 5, createdAt: at, lastMentionedAt: at, repeatStrength: 1,
    spanFrom: at, spanTo: at, sources: [], people: [],
  })
  writeFileSync(`${H}/DL3.json`, JSON.stringify(dl3))
  const before = readJson(`${H}/L3.json`)
  ok('快照里本来没有这条', !before.items.some((x) => x.id === 'manual1'))
  ok('注入现算能看到（不等 30 分钟）', b.buildBlock().includes('手动加的摘要'))
  ok('读的人没改写快照', !readJson(`${H}/L3.json`).items.some((x) => x.id === 'manual1'))
  rmSync(H, { recursive: true, force: true })
}

// ============================================================
console.log('⑭ 没变化时 organize 不重写文件')
// ============================================================
{
  const I = '.test-m6-noop'
  rmSync(I, { recursive: true, force: true })
  const a = mk(I, 'dsh')
  a.writeTurn([{ text: '短句一', speaker: 'user', channel: 'dialog', turnId: 'n1' }])
  await a.organize()
  const t1 = readFileSync(`${I}/DL3.json`, 'utf8')
  const o = await a.organize()      // 没有新 temp、没有信号、没超容量
  const t2 = readFileSync(`${I}/DL3.json`, 'utf8')
  ok('第二次 organize 成功', o.ok === true, JSON.stringify(o))
  ok('DL3 内容没被重写', t1 === t2)
  ok('没有新摘要就不刷新 L3', o.l3 === readJson(`${I}/L3.json`).items.length)
  rmSync(I, { recursive: true, force: true })
}

rmSync('.test-m6', { recursive: true, force: true })
rmSync('.test-m6-sig', { recursive: true, force: true })
rmSync('.test-m6-l2', { recursive: true, force: true })
rmSync('.test-m6-crash', { recursive: true, force: true })
rmSync('.test-m6-quota', { recursive: true, force: true })

console.log(`\n  ${pass} / ${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
