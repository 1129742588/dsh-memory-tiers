/**
 * 规模-耗时趋势分析
 *
 * 用法：
 *   node analyze-scale.mjs               # 分析 .big
 *   node analyze-scale.mjs .big-xxx      # 指定目录
 *
 * 读 timeline.json（simulate-big 跑完落盘的），算「库大小 → 各阶段耗时」的趋势，
 * 并外推到 1 万 / 10 万条。目的是回答一个问题：
 *
 *   **数据量涨 10 倍、100 倍之后，哪一段会先撑不住？**
 *
 * 判定口径：
 *   O(1)   常数     —— 与库大小无关（网络往返、按条数付费）
 *   O(n)   线性     —— 每条都要过一遍（余弦扫全库、序列化）
 *   O(n²)  平方     —— 两两比较（全量融合、判重）
 *
 * 做法：对每个指标拟合 y = a·n + b 和 y = a·n² + b，看哪个 R² 更高。
 * R² 差距小于 0.05 时按简单（线性）算。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || '.big'
const file = join(dir, 'timeline.json')

if (!existsSync(file)) {
  console.log(`没有 ${file}。先跑：node simulate-big.mjs --days=90 --budget=450000`)
  process.exit(1)
}

const tl = JSON.parse(readFileSync(file, 'utf8'))
if (!tl.length) { console.log('timeline 是空的'); process.exit(1) }

// ── 最小二乘拟合 ──────────────────────────────────────────────
function fit(xs, ys, deg) {
  // deg=1: y=ax+b ；deg=2: y=ax²+bx+c
  const n = xs.length
  const X = xs.map((x) => (deg === 2 ? [x * x, x, 1] : [x, 1]))
  const k = X[0].length
  // 正规方程 XᵀX β = Xᵀy。k 只有 2 或 3，直接高斯消元。
  const A = Array.from({ length: k }, (_, i) => [
    ...Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)),
    X.reduce((s, r, t) => s + r[i] * ys[t], 0),
  ])
  for (let i = 0; i < k; i++) {
    let p = i
    for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r
    ;[A[i], A[p]] = [A[p], A[i]]
    if (Math.abs(A[i][i]) < 1e-12) return null
    for (let r = 0; r < k; r++) {
      if (r === i) continue
      const f = A[r][i] / A[i][i]
      for (let c = i; c <= k; c++) A[r][c] -= f * A[i][c]
    }
  }
  // 回代
  const sol = new Array(k).fill(0)
  for (let i = k - 1; i >= 0; i--) {
    let s = A[i][k]
    for (let j = i + 1; j < k; j++) s -= A[i][j] * sol[j]
    sol[i] = s / A[i][i]
  }
  // R²
  const ybar = ys.reduce((a, b) => a + b, 0) / n
  let ss = 0, sr = 0
  for (let t = 0; t < n; t++) {
    let pred = 0
    for (let c = 0; c < k; c++) pred += sol[c] * X[t][c]
    ss += (ys[t] - ybar) ** 2
    sr += (ys[t] - pred) ** 2
  }
  return { beta: sol, r2: ss < 1e-12 ? 1 : 1 - sr / ss }
}

function classify(xs, ys) {
  const lin = fit(xs, ys, 1)
  const quad = fit(xs, ys, 2)
  if (!lin || !quad) return { order: '?', note: '拟合失败' }
  const better = quad.r2 > lin.r2 + 0.05 ? 'n²' : 'n'
  return {
    order: better,
    linR2: lin.r2,
    quadR2: quad.r2,
    // 用胜出的那个外推
    predict: (n) => (better === 'n²'
      ? quad.beta[0] * n * n + quad.beta[1] * n + quad.beta[2]
      : lin.beta[0] * n + lin.beta[1]),
  }
}

// ── 取指标 ────────────────────────────────────────────────────
const n = tl.map((x) => x.total)
const writeMs = tl.map((x) => x.ms)
const sumMs = tl.map((x) => x.msSum || 0)

// relation / summarize 的耗时在 net 明细里（毫秒，是"请求累计"）
const relMs = tl.map((x) => (x.net && x.net.relation) || 0)
const sumNetMs = tl.map((x) => (x.net && (x.net.summarizeWithSources || x.net.summarize)) || 0)
const embMs = tl.map((x) => (x.net && x.net.embed) || 0)

const items = [
  ['写入（本地+网络）', writeMs],
  ['摘要（后台）', sumMs],
  ['判重 relation', relMs],
  ['摘要 summarize', sumNetMs],
  ['向量 embed', embMs],
]

console.log(`\n规模-耗时趋势  ·  数据点 ${tl.length} 天  ·  库从 ${Math.min(...n)} 涨到 ${Math.max(...n)} 条\n`)
if (tl.length < 20) {
  console.log('⚠️  数据点不足 20 天，拟合不可靠（会出现负数外推）。要看趋势请跑 90 天。\n')
}
console.log('指标                  复杂度   线性R²   平方R²    外推 1万条    外推 10万条')
console.log('─'.repeat(78))

const TARGETS = [10000, 100000]
for (const [label, ys] of items) {
  if (ys.every((y) => y === 0)) {
    console.log(`${label.padEnd(20)}  无数据`)
    continue
  }
  const c = classify(n, ys)
  const preds = TARGETS.map((t) => {
    const v = c.predict(t)
    // 外推为负或 R² 太低 → 标不可靠，别给假数字
    if (!Number.isFinite(v) || v < 0 || (c.linR2 ?? 0) < 0.5) return '     不可靠'
    return `${(v / 1000).toFixed(1)}s`.padStart(10)
  })
  const reliable = (c.linR2 ?? 0) >= 0.5 ? '' : ' ← 拟合弱'
  console.log(
    `${label.padEnd(20)}  O(${c.order})`.padEnd(12) +
    `${(c.linR2 ?? 0).toFixed(3).padStart(8)}` +
    `${(c.quadR2 ?? 0).toFixed(3).padStart(9)}` +
    preds.join('') + reliable
  )
}

// ── 结论 ──────────────────────────────────────────────────────
const totalMs = tl.map((x) => x.ms + (x.msSum || 0))
const cTotal = classify(n, totalMs)
console.log('\n结论')
console.log('─'.repeat(78))
if (tl.length < 20) {
  console.log('数据点不足，结论不可下。请跑 90 天后再看（node simulate-big.mjs --days=90）。')
} else if ((cTotal.linR2 ?? 0) < 0.5) {
  console.log('总耗时的拟合很弱（R² < 0.5），趋势不明显。可能是网络抖动盖过了规模效应。')
} else if (cTotal.order === 'n²') {
  console.log('⚠️  总耗时呈 O(n²) 增长——有平方级环节（全量融合/两两比较）还没砍干净。')
  console.log('   先查 fuseIntoDL3 的候选扫描是不是变成两两比了。')
} else {
  console.log('总耗时 O(n) 线性增长。瓶颈在扫描类环节（判重、检索、序列化），')
  console.log('库大到十万级时需要上向量索引（HNSW）或分片存储。')
}
const relC = classify(n, relMs)
if (tl.length >= 20 && relC.order !== '?' && relC.predict(100000) > 60000) {
  console.log(`⚠️  判重在 10 万条时约 ${(relC.predict(100000) / 1000).toFixed(0)} 秒/天，会成为最大瓶颈。`)
}
console.log('\n注意：外推是拟合结果，库结构变化（分层比例、摘要产量）会让曲线拐弯。')
console.log('     只当"哪个环节先撑不住"的参考，别当精确预测。')
