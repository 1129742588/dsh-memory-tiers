/**
 * 晋升参数扫描 —— `node tune.mjs`
 *
 * 目的：把热度模型的参数扫出来，不靠拍脑袋。
 *
 * ★ 设计前提（用户两轮纠正后的模型）：
 *
 *   1. importance 与指标彻底分离
 *        importance  静态，写入时判定，永不变；只管"进门资格"和"检索权重"
 *        heat        动态，随时间衰减；只管"现在在不在 L3"
 *
 *   2. 半衰期不是常数——它随"活跃天数"变长（艾宾浩斯重复效应）
 *
 *        单纯 heat = heat × decay + 1 有个缺陷：
 *        把全部历史压成一个数，"提过几次"的信息丢了。
 *
 *        反例（用户提出）：
 *          A 在第 1、5、9、30 天被提（活跃 4 天）
 *          B 在第 0、30 天被提（活跃 2 天）
 *          到第 30 天，两者 heat 可能相等；但 30 天后 A 应该衰减更慢——
 *          因为它被反复强化过，B 只是沉寂很久后偶然出现。
 *
 *        修法：半衰期 = 基准 × (1 + 系数 × log2(1 + 活跃天数))
 *        用 log 是为了避免"提得越多越忘不掉"（老记忆永远不衰减）。
 *
 * 要区分的场景：
 *   burst      一天内爆发 20 次          → 应该跌出（短时热度 ≠ 长期重要）
 *   steady     每 6 天提一次             → 应该留住
 *   once       只提一次                  → 应该跌出
 *   stale7     写完 7 天没提（巩固层）    → 应该跌出
 *   sparse     每 10 天一次              → 边缘，靠迟滞兜
 *   historyA   活跃 4 天，第 30 天再提    → 第 60 天时应比 suddenB 留得多
 *   suddenB    活跃 2 天，第 30 天再提    → 同上对照组
 */

const OBSERVE = 30

// ──────────────────────────────────────────────────────────────
// 核心模型
//
//   activeDays  ← 有多少个不同的日子被提过（按天去重后的累计）
//   半衰期 = base × (1 + boost × log2(1 + min(activeDays, cap)))
//   heat   = heat × 0.5^(Δt / 半衰期) + 1
// ──────────────────────────────────────────────────────────────
// ★ strength 是"重复强度"的连续累积，不是活跃天数。
//   每次提及按间隔质量 q 累加：间隔越合理，q 越大，强度涨得越多。
//   半衰期只跟 strength 走——这样间隔效应才能真正沉淀下来，
//   而不是像"把 q 加进 heat"那样被衰减吃掉。
function halfLifeAt(strength, base, boost, cap) {
  const n = Math.min(Math.max(strength, 1), cap)
  return base * (1 + boost * Math.log2(1 + n))
}

// 间隔质量：间隔太密几乎没强化，隔开才有效（间隔重复效应）
//   ratio = 距上次的天数 / 半衰期
//   ratio 0.05（隔 1 天）→ 0.40
//   ratio 0.83（隔 15 天）→ 0.92
//   ratio 1.65（隔 30 天）→ 1.00 封顶
function spacingQuality(ratio) {
  return Math.min(1, 0.15 + 0.85 * Math.log2(1 + ratio))
}

function simHeat({ touches, base, boost, cap = 20, dedupeByDay = true, spacing = true, observeDay = OBSERVE }) {
  // ★ 写入本身算一次"满额提及"：heat=1、activeDays=1、占住第 0 天。
  //   不能从 0 起步——那样第一次 touch 会按 quality(0)=0.35 计，
  //   等于把"写入"当成了一次"太密的重复"，与实际不符。
  //   （memory5 里 makeItem 的 heat 初值也是 1，两边口径必须一致）
  let heat = 1
  let strength = 1
  let last = 0
  let lastDay = 0

  for (const t of touches) {
    const day = Math.floor(t)
    if (dedupeByDay && day === lastDay) continue

    const hl = halfLifeAt(strength, base, boost, cap)
    const dt = t - last
    const ratio = dt / hl
    const q = spacing ? spacingQuality(ratio) : 1
    heat = heat * Math.pow(0.5, ratio) + q
    strength += q          // ★ 强度累积，决定之后的半衰期
    last = t
    lastDay = day
  }

  const hlFinal = halfLifeAt(strength, base, boost, cap)
  const dt = observeDay - last

  return {
    peak: heat,
    current: heat * Math.pow(0.5, dt / hlFinal),
    strength,
    halfLife: hlFinal,
    later: heat * Math.pow(0.5, (dt + 30) / hlFinal),
  }
}

// ──────────────────────────────────────────────────────────────
// 场景
// ──────────────────────────────────────────────────────────────
const CASES = {
  burst: { touches: Array.from({ length: 20 }, () => 0), observeDay: 30 },
  steady: { touches: [0, 6, 12, 18, 24], observeDay: 30 },
  once: { touches: [0], observeDay: 30 },
  stale7: { touches: [0], observeDay: 7 },
  sparse: { touches: [0, 10, 20], observeDay: 30 },
  // 重复效应对照：两者都在第 30 天被提，但历史不同
  historyA: { touches: [1, 5, 9, 30], observeDay: 30 },
  suddenB: { touches: [0, 30], observeDay: 30 },
  // ★ 重复密度对照：都是 2 个活跃日，但间隔不同。
  //   ⚠️ 观察点必须"距最后一次提及同样天数"（都是 15 天），
  //      否则比的是观察窗口偏移，不是间隔效应。
  closeRep: { touches: [0, 1], observeDay: 16 },    // 隔 1 天，最后提完过 15 天看
  spreadRep: { touches: [0, 14], observeDay: 29 },  // 隔 14 天，同样过 15 天看
}

// ──────────────────────────────────────────────────────────────
// 扫描
// ──────────────────────────────────────────────────────────────
const BASES = [10, 14, 21]
const BOOSTS = [0, 0.3, 0.5]
const THRESHOLDS = [0.6, 0.8, 1.0, 1.2, 1.5]
const SPACINGS = [true, false]

const rows = []

for (const base of BASES) {
  for (const boost of BOOSTS) {
    for (const threshold of THRESHOLDS) {
      for (const spacing of SPACINGS) {
        const o = {}
        for (const [key, c] of Object.entries(CASES)) {
          o[key] = simHeat({ touches: c.touches, base, boost, spacing, observeDay: c.observeDay })
        }

        const cur = (k) => o[k].current

        const burstOK = cur('burst') < threshold
        const steadyOK = cur('steady') >= threshold
        const onceOK = cur('once') < threshold
        const staleOK = cur('stale7') < threshold
        // 重复效应：第 60 天时 A（活跃4天）必须比 B（活跃2天）留得多
        const repeatOK = o.historyA.later > o.suddenB.later
        // ★ 间隔效应：隔 14 天重复 必须强于 隔 1 天重复（同样 2 个活跃日）
        const spacingOK = cur('spreadRep') > cur('closeRep')

        const pass = burstOK && steadyOK && onceOK && staleOK && repeatOK && spacingOK

        const minMargin = Math.min(
          cur('steady') / threshold,
          threshold / Math.max(cur('burst'), 1e-6),
          threshold / Math.max(cur('stale7'), 1e-6)
        )

        rows.push({
          base, boost, threshold, spacing, pass, minMargin,
          burst: cur('burst'), steady: cur('steady'), once: cur('once'),
          stale7: cur('stale7'), sparse: cur('sparse'),
          closeRep: cur('closeRep'), spreadRep: cur('spreadRep'),
          aAt30: o.historyA.current, aAt60: o.historyA.later,
          bAt30: o.suddenB.current, bAt60: o.suddenB.later,
          repeatOK, spacingOK, burstOK, steadyOK, onceOK, staleOK,
        })
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 输出
// ──────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n)
const num = (x) => x.toFixed(2).padStart(6)

console.log('\n' + '='.repeat(104))
console.log('  热度参数扫描 · importance 不参与，半衰期随活跃天数变长')
console.log('='.repeat(104))
console.log('\n  判定：爆发 < T ≤ 持续，一次 < T，7天没提 < T，且第60天 A(活跃4天) > B(活跃2天)\n')

const shown = rows.filter((r) => r.spacing)

console.log(
  '  ' + pad('基准', 7) + pad('系数', 7) + pad('阈值', 7) +
  pad('爆发', 8) + pad('持续', 8) + pad('一次', 8) + pad('7天没提', 9) +
  pad('密重复', 8) + pad('疏重复', 8) + pad('余量', 8) + '判定'
)
console.log('  ' + '-'.repeat(100))

for (const r of shown) {
  const flag = r.pass ? '✓' : (!r.spacingOK ? '✗间隔' : (!r.repeatOK ? '✗重复' : '✗'))
  console.log(
    '  ' + pad(r.base, 7) + pad(r.boost.toFixed(1), 7) + pad(r.threshold.toFixed(1), 7) +
    num(r.burst) + '  ' +
    num(r.steady) + '  ' +
    num(r.once) + '  ' +
    num(r.stale7) + '  ' +
    num(r.closeRep) + '  ' +
    num(r.spreadRep) + '  ' +
    num(r.minMargin) + 'x ' +
    flag
  )
}

const noSpacing = rows.filter((r) => !r.spacing)
console.log(`\n  【对照】关掉间隔质量：可用 ${noSpacing.filter(r => r.pass).length} / ${noSpacing.length}`)

// ──────────────────────────────────────────────────────────────
// 推荐
// ──────────────────────────────────────────────────────────────
const passed = rows.filter((r) => r.pass)

console.log('\n' + '='.repeat(104))
console.log(`  可用组合：${passed.length} / ${rows.length}`)
console.log('='.repeat(104))

if (passed.length) {
  const ranked = [...passed].sort((a, b) => b.minMargin - a.minMargin)
  const best = ranked[0]

  console.log('\n  推荐：')
  console.log(`    半衰期基准 ${best.base} 天 · 重复系数 ${best.boost} · 晋升阈值 ${best.threshold}`)
  console.log(`    最小余量 ${best.minMargin.toFixed(2)}x`)
  console.log('')
  console.log(`    爆发 20 次        ${best.burst.toFixed(2)}  → 跌出`)
  console.log(`    只提一次          ${best.once.toFixed(2)}  → 跌出`)
  console.log(`    写完7天没提        ${best.stale7.toFixed(2)}  → 跌出（巩固层能筛掉）`)
  console.log(`    每6天一次          ${best.steady.toFixed(2)}  → 留住`)
  console.log(`    每10天一次         ${best.sparse.toFixed(2)}  → 靠迟滞兜`)
  console.log('')
  console.log(`    重复效应（第 60 天）：`)
  console.log(`      A 活跃4天  ${best.aAt30.toFixed(2)} → ${best.aAt60.toFixed(2)}`)
  console.log(`      B 活跃2天  ${best.bAt30.toFixed(2)} → ${best.bAt60.toFixed(2)}`)
  console.log(`      → A 留得多 ${(best.aAt60 / Math.max(best.bAt60, 1e-6)).toFixed(2)} 倍`)

  // 半衰期随活跃天数的变化
  const hl = (n) => halfLifeAt(n, best.base, best.boost, 20).toFixed(1)
  console.log(`\n    半衰期随活跃天数：1天→${hl(1)}天  4天→${hl(4)}天  10天→${hl(10)}天  20天→${hl(20)}天`)

  console.log('\n  其余可用（前 5）：')
  for (const r of ranked.slice(0, 5)) {
    console.log(
      `    基准 ${r.base} · 系数 ${r.boost} · 阈值 ${r.threshold}` +
      `   余量 ${r.minMargin.toFixed(2)}x`
    )
  }
} else {
  console.log('\n  没有组合能同时满足。')
  const near = rows.filter((r) => r.burstOK && r.steadyOK && r.staleOK).length
  console.log(`  其中"爆发/持续/7天"三项都过、只有重复效应不满足的：${near} 组`)
}

console.log('\n  说明：importance 只保留在条目上，不参与衰减，也不进 heat。')
console.log('        它管"进门资格（0.85 直进 L3）"和"检索权重"。\n')
