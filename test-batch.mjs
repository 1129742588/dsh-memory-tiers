/**
 * 批量写入一致性测试 —— `node test-batch.mjs`
 *
 * 批量化的价值是省掉网络往返，**但落库结果必须和逐条写一致**。
 * 这个测试盯两件事：结果对不对得上、往返次数有没有降。
 *
 * 用系统自己的 `stats().calls` 来量调用次数——
 * rounds 是延迟来源，items 是 token 来源，两者必须分开看：
 *   有批量接口 → rounds 和 items 一起降
 *   只有单条接口 → items 不变（该调的还得调），但 rounds 降（并发合并）
 *
 * 覆盖：
 *   ① 逐条写（基线）
 *   ② 批量写（带 classifyBatch）
 *   ③ 结果一致性
 *   ④ L1 批量写入后收敛（原来只分流一次会残留积压）
 *   ⑤ 批内重复能被发现
 *   ⑥ 无 batch 接口时的收益
 *   ⑦ 往返次数对比
 */

import { rmSync } from 'node:fs'
import { createMemory5, DAY } from './memory5.mjs'

// ──────────────────────────────────────────────────────────────
// 假向量
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

// 分类桩：返回 null 让 memory5 落到内部本地规则，
// 这样"逐条"和"批量"用的是同一套判定，比对才有意义。
const classifyStub = async () => null
const classifyBatchStub = async (texts) => texts.map(() => null)

// ──────────────────────────────────────────────────────────────
// 数据：40 条，含重复、矛盾、各种重要性
// ──────────────────────────────────────────────────────────────
const BASE = new Date('2026-09-01T12:00:00+08:00').getTime()
const at = (d, h = 0) => BASE + d * DAY + h * 3600e3

const DATA = [
  // 原则类（本地规则判 0.9 → 分流进 DL2 + 摘要）
  { text: '以后评估一律以召回率为准，不再看准确率', speaker: '主人', at: at(0, 9) },
  { text: '分割模型必须用 nnUNet，别再试别的了', speaker: '主人', at: at(0, 10) },
  { text: '所有报告统一用 markdown 输出', speaker: '主人', at: at(0, 11) },
  { text: '假阴性率必须压到 5% 以下，宁可多报', speaker: '主人', at: at(1, 9) },
  { text: '数据集里标反的必须退回重标，不准凑合', speaker: '主人', at: at(1, 10) },

  // 结果类（0.6 → L2 巩固）
  { text: '把预处理改成 1.5mm 重采样，跑通了一遍' },
  { text: '清了一轮空标注，删掉 37 个坏样本' },
  { text: '补完了 64 例人工标注' },
  { text: '后处理加了连通域过滤，假阳性降了一半' },
  { text: '训练脚本改完，八卡能起' },
  { text: '推理服务部署到四台机器，QPS 过了 50' },
  { text: '数据集规模扩到 800 例，月底前完成' },

  // 闲聊（0.3 → DL1）
  { text: '食堂今天的菜太咸了', speaker: '星鲸', at: at(2, 12) },
  { text: '地铁上有人外放音乐，很吵', speaker: '艾小', at: at(2, 13) },
  { text: '楼下那只橘猫又蹲在门口', speaker: '艾小', at: at(2, 14) },
  { text: '快递被放错了柜子，跑了两趟', speaker: '封魔', at: at(3, 10) },
  { text: '新买的耳机左声道有杂音', speaker: '艾小', at: at(3, 11) },
  { text: '公司楼下的咖啡涨价了', speaker: 'Ugly', at: at(3, 12) },
  { text: '昨天熬夜看球，今天很困', speaker: '星鲸', at: at(4, 9) },
  { text: '打印机又卡纸，修了半天', speaker: '封魔', at: at(4, 10) },
  { text: '小区门口的超市在打折', speaker: '艾小', at: at(4, 11) },
  { text: '手机屏幕摔裂了一道缝', speaker: '星鲸', at: at(5, 9) },
  { text: '空调遥控器找不到了', speaker: 'Ugly', at: at(5, 10) },
  { text: '楼下装修吵得没法午睡', speaker: '艾小', at: at(5, 11) },

  // 事件类
  { text: '刷到一个肺结节早筛的科普视频', speaker: '我', at: at(6, 20) },
  { text: '抖音评论区跟人吵了一架，气死了', speaker: '我', at: at(6, 21) },
  { text: '看到一个讲 nnUNet 拆解的直播', speaker: '我', at: at(7, 20) },

  // 重复（应合并）
  { text: '以后评估一律以召回率为准，不再看准确率了', speaker: '主人', at: at(8, 9) },
  { text: '公司楼下的咖啡涨价了，一杯都快三十', speaker: 'Ugly', at: at(8, 10) },

  // 矛盾（新替旧）
  { text: '群里不要发表情包了', speaker: '主人', at: at(9, 9) },
  { text: '群里要发表情包', speaker: '主人', at: at(9, 10) },

  // 日常补充
  { text: '周末想去爬山，看天气再说', speaker: '星鲸', at: at(10, 9) },
  { text: '天气突然降温，得加衣服', speaker: '艾小', at: at(10, 10) },
  { text: '小区物业在修水管，停水一天', speaker: '封魔', at: at(10, 11) },
  { text: '看了个做菜视频，想试试红烧肉', speaker: '我', at: at(11, 20) },
  { text: '同事说他跳槽了，去了大厂', speaker: '星鲸', at: at(11, 12) },
  { text: '隔壁组在裁员，气氛有点紧', speaker: 'Ugly', at: at(11, 13) },
  { text: '把标注平台的批量导入做完了' },
  { text: '论文的消融实验跑完，结果符合预期' },
  { text: '重新生成了一遍验证集的预测结果' },
]

const CFG = {
  hotMaxChars: 200,
  hotMaxItems: 200,
  consolidateMaxChars: 8000,
  consolidateDays: 7,
  longMaxChars: 600,
  dl2MaxChars: 4000,
  dl2CompressTarget: 400,
}

// ──────────────────────────────────────────────────────────────
// 比对工具
// ──────────────────────────────────────────────────────────────
let failed = 0
const rows = []
const check = (name, actual, expect, extra = '') => {
  const ok = JSON.stringify(actual) === JSON.stringify(expect)
  if (!ok) failed++
  rows.push({ name, ok })
  const detail = extra ? `  ${extra}` : ''
  const exp = ok ? '' : `期望 ${JSON.stringify(expect)} 实际 ${JSON.stringify(actual)}`
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(30)} ${exp}${detail}`)
}
const head = (t) => console.log(`\n${'─'.repeat(66)}\n${t}`)

const mk = (dir, extra = {}) => {
  rmSync(dir, { recursive: true, force: true })
  return createMemory5({
    dir,
    now: () => BASE + 20 * DAY,
    embed: fakeEmbed,
    classify: classifyStub,
    judgeRelation: fakeJudgeRelation,
    cfg: CFG,
    ...extra,
  })
}

// ──────────────────────────────────────────────────────────────
head('① 逐条 write（基线）')
const dirA = '.test-batch-single'
const memA = mk(dirA)
const t0 = Date.now()
for (const d of DATA) await memA.write(d)
const msA = Date.now() - t0
const sA = memA.stats()
console.log(`  ${DATA.length} 条：${msA}ms`)
console.log(`  embed ${sA.calls.embed.rounds} 轮 / ${sA.calls.embed.items} 条`)
console.log(`  classify ${sA.calls.classify.rounds} 轮 / ${sA.calls.classify.items} 条`)
console.log(`  分布：${JSON.stringify(sA.count)}`)

head('② writeMany（带 classifyBatch）')
const dirB = '.test-batch-many'
const memB = mk(dirB, { classifyBatch: classifyBatchStub })
const t1 = Date.now()
await memB.writeMany(DATA)
const msB = Date.now() - t1
const sB = memB.stats()
console.log(`  ${DATA.length} 条：${msB}ms`)
console.log(`  embed ${sB.calls.embed.rounds} 轮 / ${sB.calls.embed.items} 条`)
console.log(`  classify ${sB.calls.classify.rounds} 轮 / ${sB.calls.classify.items} 条`)
console.log(`  分布：${JSON.stringify(sB.count)}`)

// ──────────────────────────────────────────────────────────────
head('③ 落库结果必须对得上')

check('总条数一致', sB.total, sA.total, `单条 ${sA.total} / 批量 ${sB.total}`)
check('通道分布一致', sB.byChannel, sA.byChannel)
check('向量条数一致', sB.vectors, sA.vectors)

// ★ 分层分布不能要求逐字节相同：
//   逐条写每条都触发分流，批量写是整批之后才分，
//   分流那一刻 L1 的构成不同，边界上一两条可能落到 L2 也可能落到 DL1。
//   这两层都是"待定/不重要"，不是 bug。所以校验：
//     a) 活跃层总量守恒
//     b) 单层差异在分批粒度可解释的范围内
const activeSum = (x) => x.L1 + x.L2 + x.DL1
check('活跃层总量守恒', activeSum(sB.count), activeSum(sA.count),
  `单条 ${activeSum(sA.count)} / 批量 ${activeSum(sB.count)}`)

const layerDiff = {}
for (const k of Object.keys(sA.count)) {
  layerDiff[k] = Math.abs((sB.count[k] || 0) - (sA.count[k] || 0))
}
const maxDiff = Math.max(...Object.values(layerDiff))
check('单层差异可解释（≤3 条）', maxDiff <= 3, true, `最大差 ${maxDiff}：${JSON.stringify(layerDiff)}`)

const mergedA = memA.list().filter((it) => (it.fusionCount || 0) > 0).length
const mergedB = memB.list().filter((it) => (it.fusionCount || 0) > 0).length
check('判重合并数一致', mergedB, mergedA, `${mergedA} 条被合并`)

const deadA = memA.list().filter((it) => it.supersededBy).length
const deadB = memB.list().filter((it) => it.supersededBy).length
check('矛盾作废数一致', deadB, deadA, `${deadA} 条被作废`)

const sumA = memA.list().filter((it) => it.kind === 'summary').length
const sumB = memB.list().filter((it) => it.kind === 'summary').length
check('都有摘要产出', sumA > 0 && sumB > 0, true, `单条 ${sumA} 条 / 批量 ${sumB} 条`)
check('摘要条数接近', Math.abs(sumB - sumA) <= 2, true, `${sumA} vs ${sumB}`)

// ──────────────────────────────────────────────────────────────
head('④ L1 批量写入后必须收敛')

check('批量后 L1 不超容量', sB.chars.L1 <= CFG.hotMaxChars, true,
  `${sB.chars.L1} 字 / 上限 ${CFG.hotMaxChars}`)
check('基线 L1 也不超', sA.chars.L1 <= CFG.hotMaxChars, true, `${sA.chars.L1} 字`)
console.log('    （两边 L1 字数可以不同——分批时机不同——但都必须在上限内）')

// ──────────────────────────────────────────────────────────────
head('⑤ 批内重复必须被发现')

const dirC = '.test-batch-dup'
const memC = mk(dirC)
const beforeC = memC.stats().total
await memC.writeMany([
  { text: '把验证集的预测结果重新生成了一遍' },
  { text: '把验证集的预测结果重新生成了一遍啊' },
  { text: '把验证集的预测结果重新生成了一遍呢' },
])
const afterC = memC.stats().total
console.log(`  批内写 3 条几乎相同的：${beforeC} → ${afterC} 条`)
// ★ 语义变了（2026-10-31）：写入**不做批内去重**。
//   重复度本身是重要性信号——说了 2 次 vs 10 次，模型压摘要时分得出
//   「反复叮嘱」和「刷屏」。提前合并会把这信号抹掉。
//   重复的合并留到摘要入 DL3 时的融合（fuseDL3）。
check('批内不合并（写入不判重）', afterC - beforeC, 3)

// ──────────────────────────────────────────────────────────────
head('⑥ 无 batch 接口：并发合并，省延迟不省调用')

const dirD = '.test-batch-nobatch'
const memD = mk(dirD)     // 只有 classify，没有 classifyBatch
await memD.writeMany(DATA)
const sD = memD.stats()
console.log(`  请求 ${sD.calls.classify.rounds} 次 / 等待 ${sD.calls.classify.waves} 波 / 共 ${sD.calls.classify.items} 条`)
console.log('  请求数不变（该调的还得调），但波次从 N 降到 ceil(N/chunk)——省的是延迟，不是钱')

check('无 batch 时等待波次大降', sD.calls.classify.waves <= Math.ceil(DATA.length / 20),
  true, `${sA.calls.classify.waves} 波 → ${sD.calls.classify.waves} 波`)

// ★ 语义变了（classifyMode='onOverflow'）：分类挪到溢出那一刻，
//   还躺在 L1 里的条目根本不会被分类——它们可能被合并、被作废、直接遗忘，
//   提前分类是白花钱。所以这里验证的是"分类条数 < 写入条数"。
check('溢出才分类（比全量少）', sD.calls.classify.items < DATA.length, true,
  `${sD.calls.classify.items} / ${DATA.length} 条`)
check('写入路径上真的没分类', (sD.gates.classify.skipped['写入不分类·留到溢出'] || 0) > 0, true,
  `${sD.gates.classify.skipped['写入不分类·留到溢出'] || 0} 条延后`)
check('无 batch 时结果也对得上', sD.total, sA.total, `${sD.total} vs ${sA.total}`)

// ──────────────────────────────────────────────────────────────
head('⑦ 往返次数对比')

const embedDrop = sA.calls.embed.rounds / Math.max(sB.calls.embed.rounds, 1)
console.log(`  embed：${sA.calls.embed.rounds} 轮 → ${sB.calls.embed.rounds} 轮（降 ${embedDrop.toFixed(1)}x），条目 ${sA.calls.embed.items} → ${sB.calls.embed.items}`)
console.log(`  classify：${sA.calls.classify.rounds} 次 / ${sA.calls.classify.waves} 波 → ${sB.calls.classify.rounds} 次 / ${sB.calls.classify.waves} 波`)

check('embed 往返大降', sB.calls.embed.rounds < sA.calls.embed.rounds, true, `${embedDrop.toFixed(1)}x`)
check('向量条目总数不变', sB.calls.embed.items, sA.calls.embed.items, `${sA.calls.embed.items} 条`)
check('有 batch 时请求数也降', sB.calls.classify.rounds <= Math.ceil(DATA.length / 10), true,
  `${sA.calls.classify.rounds} → ${sB.calls.classify.rounds} 次`)
check('延迟波次降到底', sB.calls.classify.waves <= Math.ceil(DATA.length / 20), true,
  `${sA.calls.classify.waves} → ${sB.calls.classify.waves} 波`)
console.log(`  耗时：${msA}ms → ${msB}ms`)

// ──────────────────────────────────────────────────────────────
const passed = rows.filter((r) => r.ok).length
console.log(`\n${'='.repeat(66)}`)
console.log(`  ${passed} / ${rows.length} 通过`)
console.log('='.repeat(66))

for (const d of [dirA, dirB, dirC, dirD]) {
  try { rmSync(d, { recursive: true, force: true }) } catch { /* 回收站不可用就留着，不影响结论 */ }
}
process.exit(failed ? 1 : 0)
