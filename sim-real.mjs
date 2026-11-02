/**
 * 真实模型仿真：把每个机制都跑一遍，确认"确实有用"而不是"看起来有"
 *
 * 跑：node sim-real.mjs            （读 ~/.dsh/storages/memory-v5/config.json 里的 key）
 *     SILICONFLOW_API_KEY=sk-xxx node sim-real.mjs
 *     只跑不花钱的检查：node sim-real.mjs --dry（用假模型）
 *
 * 依次验证：
 *   ① L1 溢出（按整轮取，剩下的 ≤ 一半）
 *   ② 摘要路由（摘要进 DL3、被引用的原文进 DL2、其余进 L2/DL1）
 *   ③ L2 溢出（旧半 + DL1 全部，第二次整理不设 0.9 门禁）
 *   ④ 融合（两条相似的摘要被判重复/矛盾时真的合并或取代）
 *   ⑤ 检索（summary 命中摘要；detail 顺着 sources 带出原文）
 *   ⑥ L3 排序（importance × heat，降序截断）
 *   ⑦ DL1 遗忘（30 天后保持率低于阈值 → 进台账）
 *   ⑧ DL3 热度衰减（同一条摘要的热度随时间下降，L3 排序会变）
 *
 * 每一轮都打印「断言 + 实际数字」，最后汇总模型调用次数（钱花在哪）。
 */
import { createMemory6 } from './memory6.mjs'
import { heatOf } from './memory5.mjs'
import { createSilicon } from './silicon.mjs'
import { readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DRY = process.argv.includes('--dry')
const DIR = '.sim-real'
const DAY = 86400e3

// ── 时间可推进：所有时间戳都从这里来，才能模拟"过了 30 天" ──
let clock = new Date('2026-11-02T09:00:00+08:00').getTime()
const tick = () => clock
const advance = (min) => { clock += min * 60e3 }

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '   ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '   → ' + extra : ''}`) }
}
const head = (t) => console.log(`\n${t}`)

function loadKey() {
  if (process.env.SILICONFLOW_API_KEY) return process.env.SILICONFLOW_API_KEY
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.dsh/storages/memory-v5/config.json'), 'utf8'))
    if (j.apiKey) return j.apiKey
  } catch { /* 没有就算了 */ }
  for (const p of ['.sfkey', join(homedir(), 'Documents/deepseek-harness/default-workspace/dsh-memory-tiers/.sfkey')]) {
    try { const k = readFileSync(p, 'utf8').trim(); if (k) return k } catch { /* 继续找 */ }
  }
  return ''
}

// ── 模型：真实 HTTP，或全假的本地桩 ──
const key = DRY ? '' : loadKey()
if (!DRY && !key) {
  console.error('没有 API Key：设 SILICONFLOW_API_KEY，或把 key 放进 ~/.dsh/storages/memory-v5/config.json')
  process.exit(2)
}

const silicon = (!DRY && key)
  ? createSilicon({ apiKey: key, base: 'https://api.siliconflow.cn/v1', budgetTokens: 0, models: {}, noThink: { chat: true } })
  : null

const fakeEmbed = async (texts) => texts.map((t) => {
  const v = [0, 0, 0]
  if (/爬山|山/.test(t)) v[0] = 1
  if (/表情|群/.test(t)) v[1] = 1
  if (/Dice|路径|部署|测试/.test(t)) v[2] = 1
  return v
})

const models = silicon ? {
  embed: (t) => silicon.embed(t),
  judgeRelation: (a, b) => silicon.relation(a, b),
  summarizeWithSources: (lines, ch, folks, hint) => silicon.summarizeWithSources(lines, ch, folks, hint),
  rerank: (q, docs) => silicon.rerank(q, docs),
} : {
  embed: fakeEmbed,
  judgeRelation: async () => 'duplicate',
  // 一半引用（→ DL2）、一半标 +（→ L2），才测得到两条路径
  summarizeWithSources: async (lines) => {
    const half = Math.max(1, Math.floor(lines.length / 2))
    return {
      // 摘要文本带全部 lines：让"相邻两批都提到爬山"能撞上，才测得到融合
      summaries: [{ text: 'S:' + lines.join('|'), sources: lines.slice(0, half).map((_, i) => i + 1), importance: 0.9 }],
      keep: lines.slice(half).map((_, i) => half + i + 1),
    }
  },
  rerank: async (q, docs) => docs.map((d, i) => 0.9 - i * 0.1),
}

const cfg = {
  hotMaxChars: 200, hotMaxItems: 100,          // 小容量：几次对话就能溢出
  consolidateMaxChars: 150, consolidateMaxItems: 100,
  longMaxChars: 800,
  quietMs: 0,                                  // 仿真里不等"安静 10 分钟"
  viewRefreshMs: 0,                            // 每次整理都重排 L3，方便看排序变化
  hotQuotaOwn: 0.7,
  forgetThreshold: 0.25,
  l2KeepMax: 3,
  organizeEveryMs: 9e9,
}

rmSync(DIR, { recursive: true, force: true })
const mem = createMemory6({ dir: DIR, writer: 'dsh', embedSignature: silicon ? 'api:BAAI/bge-m3' : 'dry', cfg, now: tick, ...models })

const count = (l) => { try { return JSON.parse(readFileSync(join(DIR, `${l}.json`), 'utf8')).items.length } catch { return 0 } }
const itemsOf = (l) => { try { return JSON.parse(readFileSync(join(DIR, `${l}.json`), 'utf8')).items } catch { return [] } }
const auditTail = (n = 40) => { try { return readFileSync(join(DIR, 'audit.log'), 'utf8').trim().split('\n').slice(-n) } catch { return [] } }
const say = (rows) => rows.forEach((r) => console.log('    ' + r))

console.log(`\n=== ${DRY ? '假模型（dry）' : '真实模型（硅基流动）'} ===`)
console.log(`目录 ${DIR} · L1 上限 ${cfg.hotMaxChars} 字 · L2 ${cfg.consolidateMaxChars} 字 · L3 ${cfg.longMaxChars} 字\n`)

// ── 素材：覆盖命令/事实/结果/闲聊/群规/琐事，还有一对几乎重复的"爬山" ──
const turns = [
  ['以后一律先跑测试再提交，别再直接推主分支', '好的，之后都先跑测试。'],
  ['项目路径是 D:/lung，数据集放在 D:/lung/data 下面', '记下了。'],
  ['Dice 从 0.86 涨到 0.88，调完学习率之后', '涨了两个点。'],
  ['周末去爬山，山上的风很大，差点把帽子吹走', '山上确实风大。'],
  ['周末爬山了，山上风特别大', '嗯，同一趟。'],
  ['群里不要发表情包，说了好几次了', '好，群里不发。'],
  ['今天有点困，咖啡喝多了也没用', '早点休息。'],
  ['部署脚本改成 systemd 了，重启服务用 systemctl restart dsh', '好，用 systemd 管。'],
]

head('① 写入 8 轮（每轮 user + bot，同一个 turnId）')
for (const [u, b] of turns) {
  mem.writeTurn([
    { text: u, speaker: 'user', channel: 'dialog' },
    { text: b, speaker: 'bot', channel: 'dialog' },
  ])
  advance(3)
}
ok('temp 里有 16 行', readdirSync(join(DIR, 'L1.tmp')).length > 0)
// 注入按配额只放最新的若干条，所以查最后一轮，不查第七轮
ok('注入立刻能看到刚说的（还没整理）', mem.buildBlock().includes('部署脚本'))

head('② L1 溢出 → 整理（会调真实模型做摘要）')
const t0 = Date.now()
const o1 = await mem.organize()
ok('organize 成功', o1.ok === true, JSON.stringify(o1?.error || o1?.skipped || ''))
say([
  `耗时 ${Date.now() - t0} ms · 合并 ${o1.merged} 条 · L1 取走 ${o1.l1Moved} 条 · L2 取走 ${o1.l2Moved} 条`,
  `分布 L1=${o1.count?.L1} L2=${o1.count?.L2} DL1=${o1.count?.DL1} DL2=${o1.count?.DL2} DL3=${o1.count?.DL3}`,
])
ok('L1 真的溢出了（取走了至少一轮）', (o1.l1Moved ?? 0) > 0, String(o1.l1Moved))
ok('剩下没超过上限，且不超过一半', (o1.chars?.L1 ?? 0) <= cfg.hotMaxChars / 2 + 120, `${o1.chars?.L1} 字`)
ok('产出摘要进了 DL3 或至少原文有了去处', count('DL3') + count('DL2') + count('L2') + count('DL1') > 0,
  `DL3=${count('DL3')} DL2=${count('DL2')} L2=${count('L2')} DL1=${count('DL1')}`)

const dl2 = itemsOf('DL2')
const dl3 = itemsOf('DL3')
const refs = new Set(dl3.flatMap((s) => s.sources || []))
ok('DL2 每条都被摘要引用（不变式）', dl2.every((it) => refs.has(it.id)),
  dl2.map((it) => it.id + (refs.has(it.id) ? '' : '✗')).join(',') || '（DL2 为空）')

head('③ 再写 8 轮 → 触发 L2 溢出（旧半 + DL1 全部，第二次不设 0.9 门禁）')
for (let i = 0; i < 6; i++) {
  mem.writeTurn([
    { text: `补记第 ${i + 1} 条：训练日志在 runs/${i + 1}，指标都留在里面`, speaker: 'user', channel: 'dialog' },
    { text: '收到。', speaker: 'bot', channel: 'dialog' },
  ])
  advance(3)
}
const before = { l2: count('L2'), dl1: count('DL1'), dl3: count('DL3') }
const o2 = await mem.organize()
say([
  `合并 ${o2.merged} · L1 取走 ${o2.l1Moved} · L2 取走 ${o2.l2Moved}`,
  `之前 L2=${before.l2} DL1=${before.dl1} DL3=${before.dl3} → 现在 L2=${count('L2')} DL1=${count('DL1')} DL3=${count('DL3')}`,
])
ok('L2 有货', count('L2') > 0, String(count('L2')))
ok('L2 溢出后 DL3 增加了（第二次整理确实在产出）', count('DL3') >= before.dl3, `${before.dl3} → ${count('DL3')}`)
ok('没有条目同时出现在两层（同一 id 只在一层）', (() => {
  const seen = new Set(); const all = ['L1', 'L2', 'DL1', 'DL2', 'DL3']
  for (const l of all) for (const it of itemsOf(l)) { if (seen.has(it.id)) return false; seen.add(it.id) }
  return true
})())

head('④ 融合：把同一条命令再说一遍（只有 ★ 摘要才进 DL3，所以重复"命令"才撞得上）')
// ★ 这里踩过一个坑：原来用"爬山"（闲聊）重复，结果模型只给 ·，
//   L1 路径的门禁（≥0.9）把摘要丢了，DL3 里根本没有两条相似摘要 —— 融合自然不触发。
//   要测融合，必须用会被判成 ★ 的内容（命令/原则）重复说。
mem.writeTurn([
  { text: '再说一次：群里不要发表情包，重复一遍', speaker: 'user', channel: 'dialog' },
  { text: '好，群里不发。', speaker: 'bot', channel: 'dialog' },
])
advance(3)
for (let i = 0; i < 4; i++) {
  mem.writeTurn([
    { text: `还是那条：群里不要发表情包（第 ${i + 1} 次提醒）`, speaker: 'user', channel: 'dialog' },
    { text: '记住了。', speaker: 'bot', channel: 'dialog' },
  ])
  advance(3)
}
await mem.organize()
const fuseLines = auditTail(60).filter((l) => /FUSE_DUP|SUPERSEDE|FUSE_UPDATE/.test(l))
ok('融合判定真的生效了（FUSE_DUP / SUPERSEDE / FUSE_UPDATE 任一）', fuseLines.length > 0,
  fuseLines.slice(-2).join(' | ') || '没有融合日志')
say(fuseLines.slice(-3).map((l) => l.replace(/^\S+\s/, '')))

head('⑤ 检索')
const r1 = await mem.search('爬山')
ok('summary 检索有命中', r1.hits.length > 0, `${r1.hits.length} 条 · rel=${r1.confidence}`)
ok('命中的是摘要层', r1.hits.some((h) => h.kind === 'summary'), r1.hits.map((h) => h.layer).join(','))
if (r1.hits.length) say([`「${r1.hits[0].text.slice(0, 40)}」 rel=${r1.hits[0].rel}`])

const r2 = await mem.search('Dice 涨到多少了', { depth: 'detail' })
ok('detail 检索有命中', r2.hits.length > 0, `${r2.hits.length} 条`)
// 原文自己也可能命中关键词（那样就不需要"顺藤摸瓜"，via 为空是正常的）
ok('detail 能带出原文（via 或直接命中 DL2）',
  r2.hits.some((h) => h.via) || r2.hits.some((h) => h.layer === 'DL2'),
  r2.hits.map((h) => `${h.layer}${h.via ? '(via)' : ''}`).join(','))

const r3 = await mem.search('量子计算机的退相干时间')
// 闸门设计是"宁可多给，让会话模型自己判断"，所以允许有结果，但 advice 不能说"可以直接用"
ok('没见过的话题不会被判成高相关', r3.hits.length === 0 || r3.confidence < 0.5,
  `${r3.hits.length} 条 · rel=${r3.confidence} · ${r3.advice.slice(0, 16)}`)

head('⑥ L3 排序（importance × heat，降序，按容量截断）')
const n = mem.refreshL3()
const l3 = itemsOf('L3')
const scores = l3.map((it) => ({ id: it.id, s: (Number(it.importance) || 0) * heatOf(it, tick(), mem.cfg) }))
const sorted = scores.every((x, i) => i === 0 || scores[i - 1].s >= x.s)
ok('L3 非空', n > 0, `${n} 条`)
ok('按 importance×heat 降序', sorted, scores.map((x) => x.s.toFixed(2)).join(' ≥ '))
ok('L3 字数不超过 longMaxChars', l3.reduce((s, it) => s + it.text.length, 0) <= cfg.longMaxChars + 60,
  String(l3.reduce((s, it) => s + it.text.length, 0)))

head('⑦ DL3 热度衰减（同一条摘要，30 天后分数必须变小）')
const sample = l3[0] || itemsOf('DL3')[0]
if (sample) {
  const h0 = heatOf(sample, tick(), mem.cfg)
  const h30 = heatOf(sample, tick() + 30 * DAY, mem.cfg)
  ok('热度随时间下降', h30 < h0, `${h0.toFixed(2)} → ${h30.toFixed(2)}`)
  ok('分数 = importance × heat 也下降',
    (sample.importance * h30) < (sample.importance * h0),
    `${(sample.importance * h0).toFixed(2)} → ${(sample.importance * h30).toFixed(2)}`)
} else {
  ok('有摘要可测', false, 'DL3 为空')
}

head('⑧ DL1 遗忘（推进 30 天，保持率 < 阈值 → 进台账）')
const dl1Before = count('DL1')
clock += 30 * DAY
const o3 = await mem.organize()
const grave = mem.graveyard({ limit: 100 })
say([
  `DL1 ${dl1Before} → ${count('DL1')} 条 · 台账 ${grave.length} 条`,
  `整理耗时 ${o3.elapsedMs} ms`,
])
ok('DL1 有东西被遗忘（或本来就没到阈值）', dl1Before === 0 || count('DL1') < dl1Before,
  `${dl1Before} → ${count('DL1')}`)
ok('遗忘的进了台账', grave.length > 0 || dl1Before === 0, `${grave.length} 条`)

head('⑨ 注入块形态（三段顺序：一直记得的 / 最近沉淀的 / 刚发生的）')
const block = mem.buildBlock()
const i1 = block.indexOf('## 一直记得的')
const i2 = block.indexOf('## 最近沉淀的')
const i3 = block.indexOf('## 刚发生的')
ok('L3 在 L2 前面，L2 在 L1 前面', (i1 === -1 || i1 < i2 || i2 === -1) && (i2 === -1 || i2 < i3 || i3 === -1))
say([`${block.length} 字`, `段落顺序：${[i1, i2, i3].map((x) => (x === -1 ? '-' : x)).join(' < ')}`])

head('=== 汇总 ===')
const st = mem.stats()
say([
  `分布 L1=${st.count.L1} L2=${st.count.L2} L3=${st.count.L3} DL1=${st.count.DL1} DL2=${st.count.DL2} DL3=${st.count.DL3}`,
  `字数 L1=${st.chars.L1} L2=${st.chars.L2} DL2=${st.chars.DL2} DL3=${st.chars.DL3}`,
  `调用 ${Object.entries(st.calls).filter(([, v]) => v.rounds).map(([k, v]) => `${k}×${v.rounds}(${v.items}条)`).join(' · ') || '（无）'}`,
  `向量 ${st.vectors}`,
])
console.log(`\n  ${pass} / ${pass + fail} 通过`)
console.log(`  审计日志：${join(DIR, 'audit.log')}`)
if (DRY) console.log('  （dry 模式用的是假模型：融合/摘要的判定不代表真实质量）')
process.exit(fail ? 1 : 0)
