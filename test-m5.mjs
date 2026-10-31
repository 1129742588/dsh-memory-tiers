/**
 * memory5 端到端测试 —— `node test-m5.mjs`
 *
 * 不联网：用"字符分布"当假向量，用规则判矛盾。
 * 目的：验证完整链路能跑通，不验证语义质量（那个交给接模型的 simulate）。
 *
 * 覆盖：
 *   写入 → 初始分层 → 判重合并 → 矛盾取代 → 及时层分流
 *   → 巩固层到期 → 长久层溢出 → 检索 → 注入 → 遗忘 → 台账
 */

import { rmSync } from 'node:fs'
import { createMemory5, LAYER, DAY, makeItem } from './memory5.mjs'

const DIR = '.test-m5'
rmSync(DIR, { recursive: true, force: true })

// ──────────────────────────────────────────────────────────────
// 假模型：字符分布向量 + 规则判矛盾
// ──────────────────────────────────────────────────────────────
const DIM = 96
function fakeEmbed(texts) {
  return texts.map((t) => {
    const v = new Array(DIM).fill(0)
    const s = String(t)
    for (let i = 0; i < s.length; i++) {
      v[s.charCodeAt(i) % DIM] += 1
      if (i < s.length - 1) v[(s.charCodeAt(i) * 31 + s.charCodeAt(i + 1)) % DIM] += 0.5
    }
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
    return v.map((x) => x / n)
  })
}

function fakeJudgeRelation(a, b) {
  const aNeg = /不|别|禁止|不要/.test(String(a))
  const bNeg = /不|别|禁止|不要/.test(String(b))
  if (aNeg !== bNeg) return 'contradiction'
  return 'duplicate'
}

// ──────────────────────────────────────────────────────────────
// 时钟
// ──────────────────────────────────────────────────────────────
const BASE = new Date('2026-09-01T12:00:00+08:00').getTime()
const clock = { t: BASE }
const at = (d) => BASE + d * DAY

const mem = createMemory5({
  dir: DIR,
  now: () => clock.t,
  embed: fakeEmbed,
  judgeRelation: fakeJudgeRelation,
  // 模拟"只压缩字数不改写"：砍到六成
  compress: async (text) => String(text).slice(0, Math.max(10, Math.floor(String(text).length * 0.6))),
  cfg: {
    hotMaxChars: 120,          // 压得很小，逼出分流
    hotMaxItems: 20,
    consolidateMaxChars: 3000, // 够大，让它按时间到期而不是按容量
    consolidateDays: 7,
    longMaxChars: 180,         // 压小，逼出溢出
    dl2MaxChars: 150,          // 压小，逼出 DL2 压缩
    dl2CompressTarget: 10,
  },
})

// ──────────────────────────────────────────────────────────────
let failed = 0
const checks = []
function check(name, cond, detail = '') {
  if (!cond) failed++
  checks.push({ name, ok: !!cond, detail })
}
const head = (s) => console.log(`\n${'═'.repeat(66)}\n  ${s}\n${'═'.repeat(66)}`)
const log = (s = '') => console.log(s)

const show = (label, layer) => {
  const list = mem.list(layer)
  log(`  ${label}（${list.length} 条）`)
  for (const it of list.slice(0, 8)) {
    log(`    [${it.layer}] heat=${mem.heatOf(it).toFixed(2)} imp=${it.importance} 「${String(it.text).slice(0, 32)}」`)
  }
}

// ──────────────────────────────────────────────────────────────
head('① 写入：初始分层（0.85 直通长久层，其余进及时层）')

await mem.write({ text: '先把手头的分割跑通，分类的事下周再说', speaker: '主人', channel: 'dialog', importance: 0.6, at: at(0) })
await mem.write({ text: '把预处理改成按 1.5mm 重采样，Dice 从 0.86 涨到 0.88', speaker: '我', channel: 'action', importance: 0.6, at: at(0) })
await mem.write({ text: '刷到一个讲肺结节早筛的视频', speaker: '我', channel: 'event', importance: 0.3, at: at(0) })
await mem.write({ text: '最怕的是漏诊，宁可多报几个', speaker: '主人', channel: 'dialog', importance: 0.9, at: at(0) })

let s = mem.stats()
log(`  L1及时=${s.count.L1}  L2巩固=${s.count.L2}  L3长久=${s.count.L3}  DL1=${s.count.DL1}  DL3=${s.count.DL3}`)
check('全部先进及时层（不直通）', s.count.L1 === 4, `L1=${s.count.L1}`)
check('长久层一开始是空的', s.count.L3 === 0, `L3=${s.count.L3}`)
show('及时层', LAYER.HOT)

// ──────────────────────────────────────────────────────────────
head('② 写入不判重：相似的话也各自成条（重复度留给摘要判断）')

const before = mem.stats().total
await mem.write({ text: '把预处理改成按1.5mm重采样，Dice从0.86涨到0.88', speaker: '我', channel: 'action', importance: 0.6, at: at(1) })
const after = mem.stats().total
log(`  写入前 ${before} 条 → 写入后 ${after} 条`)

// ★ 语义变了（2026-10-31 用户方案）：写入**不做任何判重**。
//   理由：重复度本身就是重要性信号——同样的话说了 2 次 vs 10 次，
//   模型压摘要时分得出「反复叮嘱」和「刷屏」。提前去重会把这信号抹掉。
check('相似条目不再合并（写入不判重）', after === before + 1, `${before}→${after}`)
check('写入不动 fusionCount', !mem.list().some((it) => (it.fusionCount || 0) > 0), '无')

// ──────────────────────────────────────────────────────────────
head('③ 矛盾：写入时不判定，留到摘要入 DL3 时融合')

await mem.write({ text: '群里不要发表情包', speaker: '主人', channel: 'dialog', importance: 0.6, at: at(2) })
await mem.write({ text: '群里要发表情包', speaker: '主人', channel: 'dialog', importance: 0.6, at: at(3) })

const all = mem.list()
const superseded = all.filter((it) => it.supersededBy)
log(`  写入后作废条 ${superseded.length} 条（应为 0：判重已挪到 DL3 融合）`)
check('写入时不标作废', superseded.length === 0, `${superseded.length}`)
check('矛盾的两条都还在', all.filter((it) => it.text.includes('表情包')).length >= 2,
  `${all.filter((it) => it.text.includes('表情包')).length} 条`)

// ──────────────────────────────────────────────────────────────
head('③b DL3 融合：矛盾以新的为主，热度也转给新的')

// 直接造两条摘要（同向量 → 余弦 1，必然命中候选）
const V1 = Float32Array.from({ length: DIM }, (_, i) => Math.sin(1 * 7 + i))
const oldCmd = mem._seed(makeItem({
  text: '主人要求：群里不要发表情包', layer: LAYER.DL_LONG, kind: 'summary',
  channel: 'dialog', importance: 0.7, at: at(4),
}), V1)
oldCmd.spanFrom = at(4)
oldCmd.spanTo = at(4)
oldCmd.people = ['主人']
oldCmd.sources = ['s1']
oldCmd.heat = 5
oldCmd.fusionCount = 3
oldCmd.recallCount = 2

const newCmd = mem._seed(makeItem({
  text: '主人要求：群里要发表情包', layer: LAYER.DL_LONG, kind: 'summary',
  channel: 'dialog', importance: 0.7, at: at(5),
}), V1)
newCmd.spanFrom = at(5)
newCmd.spanTo = at(5)
newCmd.people = ['主人']
newCmd.sources = ['s2']

const fuseRes = await mem.fuseDL3(newCmd, at(5))
log(`  融合判定：${fuseRes ? fuseRes.type : '（无候选，没判）'}`)

const oldNow = mem.list().find((it) => it.id === oldCmd.id)
const newNow = mem.list().find((it) => it.id === newCmd.id)
check('旧的被标作废', !!oldNow?.supersededBy, oldNow?.supersededBy ? '是' : '否')
check('新的仍在库里', !!newNow, newNow ? '是' : '否')
check('热度以新的为主（不被排到截断线外）', (Number(newNow?.heat) || 0) >= 5, `heat=${newNow?.heat}`)
check('关注次数以新的为主', (Number(newNow?.recallCount) || 0) >= 2, `recall=${newNow?.recallCount}`)
check('矛盾不增加融合次数', (Number(newNow?.fusionCount) || 0) === 3,
  `fusion=${newNow?.fusionCount}（继承旧的，不 +1）`)

// ──────────────────────────────────────────────────────────────
head('④ 及时层装满 → 分流')

const DAILY = [
  ['星鲸', '食堂今天的菜太咸了', 0.3],
  ['艾小', '地铁上有人外放音乐，很吵', 0.3],
  ['星鲸', '天气突然降温，得加衣服', 0.6],
  ['艾小', '楼下那只橘猫又蹲在门口', 0.3],
  ['封魔', '快递被放错了柜子，跑了两趟', 0.3],
  ['星鲸', '周末想去爬山，看天气再说', 0.6],
  ['艾小', '新买的耳机左声道有杂音', 0.3],
  ['Ugly', '公司楼下的咖啡涨价了', 0.6],
  ['星鲸', '昨天熬夜看球，今天很困', 0.3],
  ['封魔', '打印机又卡纸，修了半天', 0.3],
  ['艾小', '小区门口的超市在打折', 0.6],
  ['星鲸', '手机屏幕摔裂了一道缝', 0.3],
  ['Ugly', '空调遥控器找不到了', 0.3],
  ['艾小', '楼下装修吵得没法午睡', 0.3],
]
for (let i = 0; i < DAILY.length; i++) {
  const [who, txt, imp] = DAILY[i]
  clock.t = at(4 + Math.floor(i / 4))
  await mem.write({ text: txt, speaker: who, channel: 'dialog', importance: imp, at: clock.t })
}
s = mem.stats()
log(`  L1=${s.count.L1} L2=${s.count.L2} L3=${s.count.L3} DL1=${s.count.DL1} DL3=${s.count.DL3}`)
log(`  及时层 ${s.chars.L1} 字 / 上限 120`)
check('及时层被压到容量内', s.chars.L1 <= 140, `${s.chars.L1}字`)
check('巩固层收到中间档', s.count.L2 > 0, `L2=${s.count.L2}`)
check('冷层收到低价值', s.count.DL1 > 0, `DL1=${s.count.DL1}`)
show('巩固层', LAYER.CONSOLIDATE)

// ──────────────────────────────────────────────────────────────
head('⑤ 巩固层只按容量整层取走（不设到期时间）')

// ★ 语义变了（用户 10-31）：L2 不再按"进来几天了"到期，
//   而是当缓冲满了，整层一次性取走做摘要。
clock.t = at(20)
await mem.sweep(clock.t)
s = mem.stats()
log(`  推进到第 20 天：L2=${s.count.L2}（时间推进不该清空它）`)
check('时间推进不清空巩固层', s.count.L2 > 0, `L2=${s.count.L2}`)

// 把上限压到当前占用之下，等价于"满了"
mem.cfg.consolidateMaxChars = 50
const beforeFull = s.count.L2
await mem.sweep(clock.t)
s = mem.stats()
log(`  模拟满容量后：L2=${s.count.L2}（原 ${beforeFull}）L3=${s.count.L3} DL1=${s.count.DL1} DL2=${s.count.DL2}`)

// ★ 语义变了（2026-10-31 用户定）：**不取整层**，取「按字数累加到上限一半」
//   的最旧一批 + DL1 全部。整层取走会让 L2 瞬间清空、缓存断档；
//   取一半留下一半，下次再取，缓存连续。
check('满容量后只取走一半（不是整层）', s.count.L2 > 0 && s.count.L2 < beforeFull,
  `L2 ${beforeFull} → ${s.count.L2}`)

const sums = mem.list(LAYER.LONG).filter((it) => it.kind === 'summary')
const badSpan = sums.filter((it) => !it.spanFrom || !it.spanTo || it.spanFrom > it.spanTo)
const noPeople = sums.filter((it) => !(it.people || []).length)
log(`  摘要 ${sums.length} 条：缺 span ${badSpan.length}，缺 people ${noPeople.length}`)
check('摘要都带 span', badSpan.length === 0, `${badSpan.length}`)
check('摘要都带 people', noPeople.length === 0, `${noPeople.length}`)
check('摘要记录了来源', sums.every((it) => (it.sources || []).length > 0))

// ──────────────────────────────────────────────────────────────
head('⑥ 检索')

const r1 = await mem.search('漏诊', { includeActive: true })
log(`  「漏诊」→ ${r1.hits.length} 条`)
for (const h of r1.hits.slice(0, 3)) log(`    [${h.layer}/${h.channel}] ${h.text.slice(0, 30)} (${h.score})`)
check('关键词能搜到', r1.hits.length > 0)

// 摘要沉在 DL3（深层池），默认搜索应该能扫到——这正是"翻旧账"的用途
const rDeep = await mem.search('漏诊')
log(`  「漏诊」默认（只扫深层）→ ${rDeep.hits.length} 条，全部来自深层`)
check('默认能扫到深层摘要', rDeep.hits.length > 0, `${rDeep.hits.length} 条`)
check('默认结果不含活跃层', rDeep.hits.every((h) => h.layer.startsWith('DL')), `层=${rDeep.hits.map((h) => h.layer).join(',')}`)

const r2 = await mem.search('量子纠缠', { includeActive: true })
log(`  「量子纠缠」→ ${r2.hits.length} 条`)
check('无关查询返回空', r2.hits.length === 0, `${r2.hits.length}`)

const r3 = await mem.search('星鲸说过什么', { person: '星鲸', includeActive: true })
log(`  「星鲸说过什么」→ ${r3.hits.length} 条`)
check('人名过滤有结果', r3.hits.length > 0, `${r3.hits.length}`)

// ──────────────────────────────────────────────────────────────
head('⑦ 注入')

const block = mem.buildBlock()
log(block.split('\n').slice(0, 12).join('\n'))
log(`  ... 共 ${block.length} 字`)
check('注入非空', block.length > 0)
check('注入只含活跃层', !block.includes('[DL1]') && !block.includes('[DL3]'))

// ──────────────────────────────────────────────────────────────
head('⑧ 长久层溢出 → 挤到 DL3')

clock.t = at(30)
const IMPORTANT = [
  '附属医院下个月交付 200 例带病理的 CT',
  '评估口径统一改成召回率，不再看准确率',
  '分割模型确定用 nnUNet，不再试别的',
  '标注平台要支持双击标注双肺结节',
  '训练集扩充到 800 例，月底前完成',
  '推理服务部署到四张卡，QPS 要过 50',
  '论文投稿目标定 MICCAI，先看消融',
  '所有报告统一用 markdown 输出',
  '数据脱敏流程必须过一遍法务',
  '每周五同步一次进度给导师',
  '测试集单独留 150 例不参与训练',
  '假阴性率要压到 5% 以下',
  '后处理加连通域过滤，去假阳性',
  'Dice 计算口径改成按切片统计',
  '模型版本要能回滚，保留最近三版',
  '标注质量抽查比例不低于 10%',
  '服务器扩容预算已经批下来了',
  '数据集里 12 例左右肺标反了要重标',
  '推理延迟要压到 200ms 以内',
  '所有实验记录写进同一个表格',
]
for (let i = 0; i < IMPORTANT.length; i++) {
  clock.t = at(30)
  await mem.write({
    text: IMPORTANT[i],
    speaker: '主人',
    channel: 'dialog',
    importance: 0.9,
    at: clock.t,
  })
}
s = mem.stats()
log(`  L3=${s.count.L3} 条 / ${s.chars.L3} 字（上限 180）`)
log(`  DL3=${s.count.DL3} 条`)
check('长久层被压到容量内', s.chars.L3 <= 220, `${s.chars.L3}字`)
check('溢出进了 DL3', s.count.DL3 > 0, `DL3=${s.count.DL3}`)

// ──────────────────────────────────────────────────────────────
head('⑧b DL2 超容量 → 只压缩字数，不摘要')

const dl2List = mem.list(LAYER.DL_LONG_RAW)
const compressed = dl2List.filter((it) => (it.compressCount || 0) > 0)
const stuckList = dl2List.filter((it) => it.compressFailed)
log(`  DL2 ${dl2List.length} 条 / ${mem.stats().chars.DL2} 字（上限 150）`)
log(`  本地压缩生效 ${compressed.length} 条，压不动已标记 ${stuckList.length} 条`)

// ★ 语义变了：模型压缩默认关闭（实测一个字都减不掉，纯烧钱）。
//   现在验证的是"不重复尝试"，而不是"一定能压下去"。
check('压不动的都打了标记', stuckList.length > 0, `${stuckList.length} 条`)
check('模型压缩没被调用（免费）', mem.stats().calls.compress.rounds === 0, `${mem.stats().calls.compress.rounds} 次`)
check('DL2 内容没被摘要（仍是原文形态）', dl2List.every((it) => it.kind === 'raw'))

// ──────────────────────────────────────────────────────────────
head('⑧c L3 是视图：DL3 的子集，按重要性×热度截取')

const poolDL3 = mem.list(LAYER.DL_LONG)
const viewL3 = mem.list(LAYER.LONG)
const idsInDl3 = new Set(poolDL3.map((it) => it.id))
log(`  DL3 池子 ${poolDL3.length} 条 → L3 视图 ${viewL3.length} 条`)
for (const it of viewL3.slice(0, 3)) {
  const sc = (Number(it.importance) || 0) * mem.heatOf(it)
  log(`    score=${sc.toFixed(2)} imp=${it.importance} heat=${mem.heatOf(it).toFixed(2)} 「${String(it.text).slice(0, 26)}」`)
}
check('L3 是 DL3 的子集', viewL3.every((it) => idsInDl3.has(it.id)), `${viewL3.length}/${poolDL3.length}`)
check('L3 条数不超过池子', viewL3.length <= poolDL3.length)
// 视图内应该是降序
const scores = viewL3.map((it) => (Number(it.importance) || 0) * mem.heatOf(it))
const sortedDesc = [...scores].sort((a, b) => b - a)
check('L3 按分数降序', scores.every((x, i) => Math.abs(x - sortedDesc[i]) < 1e-9), scores.map((x) => x.toFixed(2)).join(','))

// ──────────────────────────────────────────────────────────────
head('⑧d 定期融合：两条相似摘要合并成一条')

// makeItem 已在顶部导入（③b 段要用）
const sA = makeItem({
  text: '主人要求把评估口径改成召回率，不再看准确率',
  layer: LAYER.DL_LONG, channel: 'dialog', kind: 'summary', importance: 0.7, at: at(40),
})
sA.spanFrom = at(38); sA.spanTo = at(39); sA.people = ['主人']; sA.sources = ['a1', 'a2']

const sB = makeItem({
  text: '主人要求把评估口径改成召回率，不再看准确率了',
  layer: LAYER.DL_LONG, channel: 'dialog', kind: 'summary', importance: 0.7, at: at(45),
})
sB.spanFrom = at(44); sB.spanTo = at(44); sB.people = ['艾小']; sB.sources = ['b1']

const [vA, vB] = fakeEmbed([sA.text, sB.text])
mem._seed(sA, vA)
mem._seed(sB, vB)

const nBefore = mem.list(LAYER.DL_LONG).length
const fusedCount = await mem.fuse(at(50))
const nAfter = mem.list(LAYER.DL_LONG).length
log(`  DL3 ${nBefore} 条 → 融合合并 ${fusedCount} 条 → ${nAfter} 条`)

check('相似摘要被合并', fusedCount >= 1 && nAfter < nBefore, `${nBefore}→${nAfter}`)

// 按 seq 降序扫，后创建的那条当 target，先创建的被并掉
const kept = mem.list(LAYER.DL_LONG).find((it) => it.id === sB.id)
if (kept) {
  const from = new Date(kept.spanFrom).toISOString().slice(5, 10)
  const to = new Date(kept.spanTo).toISOString().slice(5, 10)
  log(`  保留：span ${from}~${to} people=${JSON.stringify(kept.people)} sources=${kept.sources.length} fusion=${kept.fusionCount}`)
  check('span 取并集(38~44)', kept.spanFrom === at(38) && kept.spanTo === at(44), `${from}~${to}`)
  check('people 取并集', kept.people.includes('主人') && kept.people.includes('艾小'), JSON.stringify(kept.people))
  check('sources 累积到3条', kept.sources.length === 3, `${kept.sources.length}`)
  check('融合次数递增', (kept.fusionCount || 0) >= 1)
} else {
  check('找到合并后的条目', false, '没找到')
}

// ──────────────────────────────────────────────────────────────
head('⑨ 遗忘：快进半年')

clock.t = at(30 + 180)
await mem.sweep(clock.t)
s = mem.stats()
const gy = mem.graveyard({ limit: 999 })
log(`  半年后：L3=${s.count.L3} DL1=${s.count.DL1} DL3=${s.count.DL3}`)
log(`  台账 ${gy.length} 条`)
for (const g of gy.slice(-3)) log(`    「${String(g.text).slice(0, 24)}」R=${g.retention} ${g.reason}`)
check('有东西被真遗忘', gy.length > 0, `${gy.length}`)
check('台账字段完整', gy.length === 0 || (gy[0].id && gy[0].text && gy[0].reason))

// ──────────────────────────────────────────────────────────────
head('⑩ 总结')

const pad = (x, n) => String(x).padEnd(n)
for (const c of checks) log(`  ${c.ok ? '✓' : '✗'} ${pad(c.name, 28)} ${c.detail}`)
log(`\n  ${checks.length - failed} / ${checks.length} 通过` + (failed ? `，${failed} 项失败` : ''))

const st = mem.stats()
log(`\n  最终分布：${JSON.stringify(st.count)}`)
log(`  通道分布：${JSON.stringify(st.byChannel)}`)
log(`  总条数 ${st.total}，向量 ${st.vectors}`)

process.exit(failed ? 1 : 0)
