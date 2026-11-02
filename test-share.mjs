/**
 * 多写者：一个数据目录给多个程序共用（dsh + astrbot）
 *
 * 关注四件事：
 *   1. 两个写者同时写，互不覆盖
 *   2. 读的时候能看见对方的条目（检索 / 注入 / 统计）
 *   3. 自动处理（分流、遗忘）只动自己的
 *   4. 旧库 store.json 只被认领一次，不会被第二个写者领成双份
 *
 * 跑：node test-share.mjs
 */
import { createMemory5, createStore, makeItem, LAYER } from './memory5.mjs'
import { rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

const D = '.test-share'
rmSync(D, { recursive: true, force: true })
mkdirSync(D, { recursive: true })
const now = Date.now()

console.log('① 两个写者交替写入，互不覆盖')
{
  const a = createStore(D, { writer: 'dsh', signature: 'none' })
  const b = createStore(D, { writer: 'astrbot', signature: 'none' })
  for (let i = 1; i <= 5; i++) {
    a.items.push(makeItem({ text: `dsh 写的第 ${i} 条` })); a.save()
    b.items.push(makeItem({ text: `astrbot 写的第 ${i} 条` })); b.save()
  }
  const ad = JSON.parse(readFileSync(`${D}/store-dsh.json`, 'utf8'))
  const bd = JSON.parse(readFileSync(`${D}/store-astrbot.json`, 'utf8'))
  ok('dsh 分片 5 条', ad.items.length === 5, String(ad.items.length))
  ok('astrbot 分片 5 条', bd.items.length === 5, String(bd.items.length))

  const a2 = createStore(D, { writer: 'dsh', signature: 'none' })
  ok('重新打开能看到 10 条', a2.items.length === 10, String(a2.items.length))
  ok('自己的只有 5 条', a2.ownItems.length === 5, String(a2.ownItems.length))
  a2.save()
  const ad2 = JSON.parse(readFileSync(`${D}/store-dsh.json`, 'utf8'))
  ok('再落盘不把别人的收进来', ad2.items.length === 5, String(ad2.items.length))

  const b2 = createStore(D, { writer: 'astrbot', signature: 'none' })
  b2.items.push(makeItem({ text: 'astrbot 后来补的一条' }))
  b2.save()
  a2.save()
  ok('对方新增后能立刻看到', a2.items.some((it) => it.text.includes('后来补的')))
}

console.log('② 检索 / 注入 / 统计看全库')
{
  const E = '.test-share2'
  rmSync(E, { recursive: true, force: true })
  const dsh = createMemory5({ dir: E, writer: 'dsh', embedSignature: 'none' })
  const bot = createMemory5({ dir: E, writer: 'astrbot', embedSignature: 'none' })
  dsh._seed(makeItem({ text: 'dsh 记的：项目路径是 D:/lung', layer: LAYER.DL_LONG, at: now }))
  bot._seed(makeItem({ text: 'astrbot 记的：用户不喜欢表情包', layer: LAYER.DL_LONG, at: now }))
  dsh._seed(makeItem({ text: 'dsh 的即时记忆：刚才在改存储层', layer: LAYER.HOT, at: now }))
  bot._seed(makeItem({ text: 'astrbot 的即时记忆：群里有人问部署', layer: LAYER.HOT, at: now }))
  dsh._store.save(); bot._store.save()

  const r = await dsh.search('表情包')
  ok('能检索到 astrbot 写的', r.hits.length === 1 && r.hits[0].text.includes('表情包'), String(r.hits.length))

  const block = dsh.buildBlock(0)
  ok('注入块含自己的 L1', block.includes('刚才在改存储层'))
  ok('注入块含对方的 L1', block.includes('群里有人问部署'))

  const st = dsh.stats()
  ok('统计 L1 算两边（2 条）', st.count.L1 === 2, String(st.count.L1))
  ok('统计 DL3 算两边（2 条）', st.count.DL3 === 2, String(st.count.DL3))

  console.log('③ 自动处理只动自己的')
  // L1 容量 2000 字，要真的灌满才会分流
  const filler = '这条是用来把即时层灌满的填充内容，重复重复重复重复重复重复重复，'.repeat(4)
  for (let i = 0; i < 20; i++) {
    dsh._seed(makeItem({ text: `dsh 灌的第 ${i} 条：${filler}`, layer: LAYER.HOT, at: now }))
  }
  await dsh.sweep?.({ now })
  const hot = dsh.list(LAYER.HOT)
  const mine = hot.filter((it) => dsh._store.isOwn(it))
  const other = hot.filter((it) => !dsh._store.isOwn(it))
  ok('对方的 L1 原封不动（1 条）', other.length === 1, String(other.length))
  ok('自己该分流的分流了', mine.length < 21, String(mine.length))

  dsh._store.save()
  const j = JSON.parse(readFileSync(`${E}/store-dsh.json`, 'utf8'))
  ok('落盘不含对方条目', j.items.every((it) => !it.__foreign))
  rmSync(E, { recursive: true, force: true })
}

console.log('④ 旧库 store.json 只认领一次')
{
  const F = '.test-share3'
  rmSync(F, { recursive: true, force: true }); mkdirSync(F, { recursive: true })
  writeFileSync(`${F}/store.json`, JSON.stringify({ version: 5, seq: 3, items: [{ id: 'old1', text: '旧库的一条' }] }))
  const w1 = createStore(F, { writer: 'dsh', signature: 'none' })
  w1.save()
  ok('第一个写者认领 1 条', w1.ownItems.length === 1, String(w1.ownItems.length))
  ok('写成 store-dsh.json', readdirSync(F).includes('store-dsh.json'))
  const w2 = createStore(F, { writer: 'astrbot', signature: 'none' })
  ok('第二个写者不重复认领', w2.ownItems.length === 0, String(w2.ownItems.length))
  ok('但能看到旧数据', w2.items.length === 1, String(w2.items.length))
  rmSync(F, { recursive: true, force: true })
}

console.log('⑤ 融合只在自己的分片里做（跨文件不合并、不取代）')
{
  const G = '.test-share4'
  rmSync(G, { recursive: true, force: true })
  // 同一个向量 = 相似度为 1，只要有候选就一定会被判成重复
  const V = [1, 0, 0]
  const stub = (writer) => createMemory5({
    dir: G,
    writer,
    embedSignature: 'none',
    embed: async (ts) => ts.map(() => V),
    judgeRelation: async () => 'duplicate',
  })
  const dsh = stub('dsh')
  const bot = stub('astrbot')

  bot._seed(makeItem({ text: '群里不要发表情包', layer: LAYER.DL_LONG, kind: 'summary', at: now }), V)
  bot._store.save()
  dsh._store.refreshForeign()

  const foreign = dsh._store.items.find((it) => !dsh._store.isOwn(it))
  ok('能看到对方的摘要', !!foreign && foreign.text.includes('表情包'))
  const snap = (it) => JSON.stringify({ t: it.text, l: it.layer, h: it.heat, s: it.supersededBy, f: it.fusionCount })
  const before = snap(foreign)

  const mine = dsh._seed(makeItem({ text: '群里不要发表情包（dsh 自己记的）', layer: LAYER.DL_LONG, kind: 'summary', at: now }), V)
  const r = await dsh.fuseDL3(mine, now)
  ok('不跟对方的摘要合并', r === null, JSON.stringify(r))
  ok('自己这条还在（不会被判重删掉）', dsh._store.items.includes(mine))
  ok('对方的条目一字未改', snap(foreign) === before, snap(foreign))

  const mine2 = dsh._seed(makeItem({ text: '群里不要发表情包（第二次）', layer: LAYER.DL_LONG, kind: 'summary', at: now }), V)
  const r2 = await dsh.fuseDL3(mine2, now)
  ok('自己库内的重复照样合并', !!r2 && r2.type === 'duplicate' && !dsh._store.items.includes(mine2))
  ok('合并后对方的还是没动', snap(foreign) === before)

  dsh._store.save()
  bot._store.save()
  const jd = JSON.parse(readFileSync(`${G}/store-dsh.json`, 'utf8'))
  const jb = JSON.parse(readFileSync(`${G}/store-astrbot.json`, 'utf8'))
  ok('各自落盘仍只含自己的', jd.items.every((it) => !it.__foreign) && jb.items.length === 1)
  rmSync(G, { recursive: true, force: true })
}

rmSync(D, { recursive: true, force: true })
console.log(`\n  ${pass} / ${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
