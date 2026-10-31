/**
 * 批量分类实测 —— `node test-classify-batch.mjs`
 *
 * 验证 silicon.classifyBatch 接真实模型能不能正确工作：
 *   ① 条数与顺序对齐（模型有没有漏条、错位）
 *   ② 分类质量（跟单条 classify 比，一致率多少）
 *   ③ 往返次数与实际耗时（批量到底省多少）
 *
 * 这个要联网。没 key 就跳过，不算失败。
 */

import { createSilicon, keyFromAstrbot } from './silicon.mjs'

const ASTRBOT_CFG = 'C:/Users/Anxiple/.astrbot_launcher/instances/56f66ac7-8570-41f3-82f3-91adacb6a65a/core/data/cmd_config.json'

const cred = keyFromAstrbot(ASTRBOT_CFG)
if (!cred) {
  console.log('\n没找到 key，跳过。\n')
  process.exit(0)
}

const usage = { calls: 0 }
const api = createSilicon({
  ...cred,
  onUsage: () => { usage.calls++ },
})

const CASES = [
  '以后评估一律以召回率为准，不再看准确率',
  '把后处理加了连通域过滤，Dice 涨了 0.02',
  '刷抖音刷到一个讲肺结节的科普，说得挺在理',
  '群里聊到周末爬山，我说看天气',
  '今天有点困，喝了两杯咖啡',
  '在抖音评论区跟人吵了一架，气死我了',
  '主人说他最怕漏诊，宁可多报几个',
  '辅助医院下个月交付 200 例带病理的 CT',
  '楼下那只橘猫又蹲在门口',
  '训练改成八卡，耗时从 9 小时压到 3 小时',
]

const head = (t) => console.log(`\n${'─'.repeat(66)}\n${t}`)

// ──────────────────────────────────────────────────────────────
head(`① 批量分类 ${CASES.length} 条`)

const t0 = Date.now()
const batch = await api.classifyBatch(CASES, { chunk: 20 })
const msBatch = Date.now() - t0
const callsBatch = usage.calls
usage.calls = 0

let nullCount = 0
for (let i = 0; i < CASES.length; i++) {
  const r = batch[i]
  if (!r) nullCount++
  const mark = r ? (r.by === 'rule' ? '规则' : '模型') : '✗空'
  const imp = r ? String(r.importance).padEnd(5) : '—    '
  const ch = r ? r.channel.padEnd(7) : '—      '
  console.log(`  ${mark.padEnd(4)} ${imp} ${ch} ${CASES[i].slice(0, 40)}`)
}
console.log(`\n  ${msBatch}ms，${callsBatch} 次请求，空结果 ${nullCount} 条`)

const coverageOK = nullCount === 0
console.log(`  ${coverageOK ? '✓' : '✗'} 每条都有结果（对齐正常）`)

// ──────────────────────────────────────────────────────────────
head('② 单条分类对照（看一致性）')

const t1 = Date.now()
const singles = []
for (const c of CASES) singles.push(await api.classify(c))
const msSingle = Date.now() - t1
const callsSingle = usage.calls

let sameImp = 0
let sameCh = 0
let both = 0
for (let i = 0; i < CASES.length; i++) {
  const a = batch[i]
  const b = singles[i]
  if (!a || !b) continue
  both++
  if (a.importance === b.importance) sameImp++
  if (a.channel === b.channel) sameCh++
}
console.log(`  ${msSingle}ms，${callsSingle} 次请求（${CASES.length} 条）`)
console.log(`  importance 一致 ${sameImp}/${both}，channel 一致 ${sameCh}/${both}`)

const impRate = sameImp / Math.max(both, 1)
const chRate = sameCh / Math.max(both, 1)
console.log(`  ${impRate >= 0.7 ? '✓' : '✗'} importance 一致率 ${(impRate * 100).toFixed(0)}% (要求 ≥70%)`)
console.log(`  ${chRate >= 0.7 ? '✓' : '✗'} channel 一致率 ${(chRate * 100).toFixed(0)}% (要求 ≥70%)`)

// ──────────────────────────────────────────────────────────────
head('③ 收益')

const speedup = msSingle / Math.max(msBatch, 1)
const callDrop = callsSingle / Math.max(callsBatch, 1)
console.log(`  耗时：${msSingle}ms → ${msBatch}ms（快 ${speedup.toFixed(1)}x）`)
console.log(`  请求：${callsSingle} 次 → ${callsBatch} 次（降 ${callDrop.toFixed(1)}x）`)
console.log('  （单条是串行 await，所以省的主要是等待时间）')

const ok = coverageOK && impRate >= 0.7 && chRate >= 0.7
console.log(`\n${'='.repeat(66)}`)
console.log(`  ${ok ? '批量分类可用' : '批量分类有问题，需要调提示词'}`)
console.log('='.repeat(66))
process.exit(ok ? 0 : 1)
