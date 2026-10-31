/**
 * 批量 vs 单条 分类质量诊断 —— `node diag-classify.mjs`
 *
 * 模拟里出现 distribution 异常（0.85 占 29%，0.6 只有 7 条），
 * 怀疑是批量分类质量不如单条。这个脚本用同一批数据分别跑两条路，对齐看差异。
 *
 * 要判断的是：
 *   ① 批量是不是把该判 0.6 的判成了 0.85 或 0.25
 *   ② 是不是同批之间互相"锚定"（前几条判什么，后面跟着）
 */

import { createSilicon, keyFromAstrbot } from './silicon.mjs'

const CFG = 'C:/Users/Anxiple/.astrbot_launcher/instances/56f66ac7-8570-41f3-82f3-91adacb6a65a/core/data/cmd_config.json'
const cred = keyFromAstrbot(CFG)
if (!cred) { console.log('没 key'); process.exit(0) }

const api = createSilicon(cred)

// 从模拟里挑 16 条，覆盖三类应当判 0.85 / 0.6 / 0.25 的内容
const CASES = [
  // 应该 0.85（定原则、长期诉求）
  ['以后评估一律以召回率为准，别老看准确率', 0.85],
  ['漏诊比误报严重得多，宁可多报几个', 0.85],
  ['数据脱敏流程必须过一遍法务，这个不能省', 0.85],
  ['假阴性率必须压到 5% 以下，宁可多报', 0.85],

  // 应该 0.6（有结果的具体事件）
  ['把脚本的预处理改成按 1.5mm 重采样，跑通了，Dice 从 0.86 涨到 0.88', 0.6],
  ['清了一轮空标注，删掉 37 个坏样本', 0.6],
  ['服务器扩容到四张卡，训练时间从 9 小时压到 3 小时', 0.6],
  ['补完了 128 例标注，抽查了 15 例，两例有问题已退回', 0.6],
  ['推理服务做了一版优化，延迟从 340ms 降到 210ms', 0.6],
  ['召回率在测试集上是 0.94，假阴性率 4.8%', 0.6],

  // 应该 0.25（闲聊琐事）
  ['今天食堂的菜太咸了', 0.25],
  ['地铁上有人外放音乐，很吵', 0.25],
  ['快递被放错了柜子，跑了两趟才拿到', 0.25],
  ['同事说他跳槽了，去了大厂', 0.25],
  ['看到群里在聊显卡，说 4090 又涨价了', 0.25],
  ['小区物业在修水管，停水一天', 0.25],
]

const texts = CASES.map((c) => c[0])
const expect = CASES.map((c) => c[1])

const head = (t) => console.log(`\n${'─'.repeat(70)}\n${t}`)
const stat = (arr) => {
  const m = {}
  for (const x of arr) if (x) m[x] = (m[x] || 0) + 1
  return m
}

// ──────────────────────────────────────────────────────────────
head('① 单条分类')
const single = []
for (const t of texts) single.push(await api.classify(t))
console.log('  importance 分布：', JSON.stringify(stat(single.map((x) => x?.importance))))

// ──────────────────────────────────────────────────────────────
head('② 批量分类（一次 16 条）')
const batch = await api.classifyBatch(texts, { chunk: 20 })
console.log('  importance 分布：', JSON.stringify(stat(batch.map((x) => x?.importance))))

// ──────────────────────────────────────────────────────────────
head('③ 逐条对比')
console.log('  ' + '期望'.padEnd(6) + '单条'.padEnd(7) + '批量'.padEnd(7) + '通道(单/批)'.padEnd(16) + '内容')
let agree = 0
let wrongSingle = 0
let wrongBatch = 0
for (let i = 0; i < texts.length; i++) {
  const e = expect[i]
  const a = single[i]
  const b = batch[i]
  const ai = a?.importance
  const bi = b?.importance
  if (ai === bi) agree++
  if (ai !== e) wrongSingle++
  if (bi !== e) wrongBatch++
  const mark = bi === e ? ' ' : (ai === e ? '←批量错' : '←都错 ')
  console.log(
    `  ${String(e).padEnd(6)}${String(ai).padEnd(7)}${String(bi).padEnd(7)}` +
    `${`${a?.channel || '-'}/${b?.channel || '-'}`.padEnd(16)}${texts[i].slice(0, 26)} ${mark}`
  )
}

console.log(`\n  两者一致 ${agree}/${texts.length}`)
console.log(`  单条判错 ${wrongSingle}/${texts.length}，批量判错 ${wrongBatch}/${texts.length}`)

// ──────────────────────────────────────────────────────────────
head('④ 结论')
if (wrongBatch > wrongSingle + 3) {
  console.log('  ✗ 批量明显更差，需要改提示词')
} else if (Math.abs(wrongBatch - wrongSingle) <= 3) {
  console.log('  ✓ 两者差不多，批量可用')
} else {
  console.log('  批量反而更好？检查样本量')
}
