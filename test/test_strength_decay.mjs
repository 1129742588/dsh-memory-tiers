/**
 * 融合次数 / 关注次数的衰减回归（对应 astrbot/test/test_strength_decay.py）。
 *
 * 背景（2026-11-02）：
 *   `fusionCount` / `recallCount` 原来是裸计数器，只增不减，也不参与任何计算——
 *   DL3 进上下文的排序只看 `importance × heat`。结果是：
 *     一条一年前被重复过 20 次的摘要，永远压过昨天刚被关注 3 次的那条。
 *
 * 约定（两端同一套）：
 *   - 原始计数保留（台账），参与计算的是衰减后的有效值
 *   - `count × 0.5^(t/半衰期)`，等价于艾宾浩斯 R = e^(-t/S)（S = 半衰期/ln2）
 *   - 半衰期由 `repeatStrength` 决定
 *   - 融合 / 关注各自记 `lastFusedAt` / `lastRecalledAt`，互不干扰
 *
 * 期望值与 astrbot 侧完全一致（0.408 / 2.0 / 0.066 / 1.0）。
 *
 * 用法：node dsh/test/test_strength_decay.mjs
 */

import {
  DAY, effectiveCount, effectiveStrength, halfLifeOf, memoryStrength,
  markFused, markRecalled, touchHeat,
} from '../core/memory.mjs'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const now = Date.now()
const base = { importance: 0.7, heat: 1.0, repeatStrength: 1.0 }

const oldFusion = { ...base, fusionCount: 10, lastFusedAt: now - 60 * DAY, createdAt: now - 60 * DAY }
const newFusion = { ...base, fusionCount: 2, lastFusedAt: now, createdAt: now }
const oldRecall = { ...base, recallCount: 8, lastRecalledAt: now - 90 * DAY, createdAt: now - 90 * DAY }
const newRecall = { ...base, recallCount: 1, lastRecalledAt: now, createdAt: now }

const fOld = effectiveCount(oldFusion, 'fusionCount', 'lastFusedAt', now)
const fNew = effectiveCount(newFusion, 'fusionCount', 'lastFusedAt', now)
const rOld = effectiveCount(oldRecall, 'recallCount', 'lastRecalledAt', now)
const rNew = effectiveCount(newRecall, 'recallCount', 'lastRecalledAt', now)

assert(Math.abs(fOld - 0.408) < 0.01, `60 天前融合 10 次应衰减到 ~0.408，实际 ${fOld.toFixed(3)}`)
assert(fNew === 2.0, `今天融合 2 次应为 2.0，实际 ${fNew}`)
assert(fNew > fOld, '今天融合 2 次 应高于 60 天前融合 10 次')
assert(Math.abs(rOld - 0.066) < 0.01, `90 天前关注 8 次应衰减到 ~0.066，实际 ${rOld.toFixed(3)}`)
assert(rNew === 1.0, `今天关注 1 次应为 1.0，实际 ${rNew}`)
assert(rNew > rOld, '今天关注 1 次 应高于 90 天前关注 8 次')
console.log(`PASS 1 衰减：融合 60 天前×10 → ${fOld.toFixed(3)}；今天×2 → ${fNew.toFixed(1)}；` +
  `关注 90 天前×8 → ${rOld.toFixed(3)}；今天×1 → ${rNew.toFixed(1)}`)

// 短间隔几乎不衰减；正好一个半衰期则减半
const hourAgo = { ...base, fusionCount: 3, lastFusedAt: now - 3600 * 1000, createdAt: now }
const hv1 = effectiveCount(hourAgo, 'fusionCount', 'lastFusedAt', now)
assert(hv1 > 2.99 && hv1 < 3.0, `1 小时前的 3 次融合应仍接近 3，实际 ${hv1.toFixed(4)}`)
const halfLifeAgo = { ...base, fusionCount: 6, lastFusedAt: now - 13 * DAY, createdAt: now - 13 * DAY }
const hv2 = effectiveCount(halfLifeAgo, 'fusionCount', 'lastFusedAt', now)
assert(Math.abs(hv2 - 3.0) < 1e-6, `过一个半衰期应正好减半（6→3），实际 ${hv2.toFixed(4)}`)
console.log(`PASS 2 短间隔≈不衰减（1 小时 ${hv1.toFixed(4)}），半个半衰期对半（6→${hv2.toFixed(3)}）`)

// 半衰期随 repeatStrength 变长
const weak = { ...base, repeatStrength: 1.0, fusionCount: 5, lastFusedAt: now - 30 * DAY }
const strong = { ...base, repeatStrength: 15.0, fusionCount: 5, lastFusedAt: now - 30 * DAY }
const w = effectiveCount(weak, 'fusionCount', 'lastFusedAt', now)
const st = effectiveCount(strong, 'fusionCount', 'lastFusedAt', now)
assert(st > w, `repeatStrength 高的应衰减更慢（${st.toFixed(3)} 应 > ${w.toFixed(3)}）`)
assert(Math.abs(w - 1.010) < 0.02 && Math.abs(st - 1.943) < 0.03,
  `30 天后应分别为 ~1.010 / ~1.943，实际 ${w.toFixed(3)} / ${st.toFixed(3)}`)
console.log(`PASS 3 间隔效应：同样 30 天，strength=1 → ${w.toFixed(3)}，strength=15 → ${st.toFixed(3)}`)

// 老数据没有 lastFusedAt 时退回 createdAt
const legacy = { ...base, fusionCount: 4, createdAt: now - 30 * DAY }
const lv = effectiveCount(legacy, 'fusionCount', 'lastFusedAt', now)
assert(lv > 0 && lv < 4, `缺 lastFusedAt 应退回 createdAt，实际 ${lv.toFixed(3)}`)
assert(Math.abs(lv - 0.808) < 0.02, `应算得 ~0.808，实际 ${lv.toFixed(3)}`)
console.log(`PASS 4 老数据兼容：缺 lastFusedAt 时按 createdAt 算得 ${lv.toFixed(3)}`)

// 两个指标独立
const { fusion, recall } = memoryStrength(newFusion, now)
assert(fusion === 2.0 && recall === 0.0, `两个指标应独立，实际 fusion=${fusion} recall=${recall}`)
console.log('PASS 5 指标独立：融合强度 2.0 / 关注强度 0.0')

// markFused / markRecalled 会同时写计数与时间戳
const fresh = { ...base }
markFused(fresh, now - 1000)
markRecalled(fresh, now - 500)
assert(fresh.fusionCount === 1 && fresh.lastFusedAt === now - 1000, 'markFused 应写计数与 lastFusedAt')
assert(fresh.recallCount === 1 && fresh.lastRecalledAt === now - 500, 'markRecalled 应写计数与 lastRecalledAt')
markFused(fresh, now)
assert(fresh.fusionCount === 2 && fresh.lastFusedAt === now, 'markFused 第二次应累加并刷新时间')
console.log('PASS 6 计数与时间戳成对写入：fusion=2 / recall=1，时间各自独立')

// 强度本身会回落：久不提 → 半衰期变短
const t0 = now - 200 * DAY
const it = { importance: 0.5, heat: 1.0, createdAt: t0, lastMentionedAt: t0, repeatStrength: 1.0 }
for (const d of [1, 6, 19, 40, 100]) touchHeat(it, t0 + d * DAY, {})
const rawS = it.repeatStrength
const eNow = effectiveStrength({ ...it, lastMentionedAt: now }, now)
const e30 = effectiveStrength({ ...it, lastMentionedAt: now - 30 * DAY }, now)
const e120 = effectiveStrength({ ...it, lastMentionedAt: now - 120 * DAY }, now)
assert(Math.abs(eNow - rawS) < 1e-9, `刚提过时应等于原始强度 ${rawS}，实际 ${eNow}`)
assert(e30 < eNow && e120 < e30, `越久不提强度应越低：${eNow.toFixed(2)} > ${e30.toFixed(2)} > ${e120.toFixed(2)}`)
const hNow = halfLifeOf({ ...it, lastMentionedAt: now }, {}, now)
const h120 = halfLifeOf({ ...it, lastMentionedAt: now - 120 * DAY }, {}, now)
assert(h120 < hNow, `久不提后半衰期应变短：${hNow.toFixed(1)} → ${h120.toFixed(1)}`)
console.log(`PASS 7 强度回落：raw=${rawS.toFixed(2)} 刚提过 ${eNow.toFixed(1)} / 30 天 ${e30.toFixed(1)} / ` +
  `120 天 ${e120.toFixed(1)}；半衰期 ${hNow.toFixed(1)} → ${h120.toFixed(1)} 天`)

// 间隔重复 > 集中爆发
const a = { importance: 0.5, heat: 1.0, createdAt: t0, lastMentionedAt: t0, repeatStrength: 1.0 }
for (const d of [1, 6, 19, 40, 100]) touchHeat(a, t0 + d * DAY, {})
const noon = new Date(t0)
noon.setHours(12, 0, 0, 0)
const noonMs = noon.getTime()
const b = { importance: 0.5, heat: 1.0, createdAt: noonMs, lastMentionedAt: noonMs, repeatStrength: 1.0 }
for (let k = 0; k < 6; k++) touchHeat(b, noonMs + k * 10 * 60 * 1000, {})
assert(b.repeatStrength <= 1.01, `同一天多次不应累加强度，实际 ${b.repeatStrength.toFixed(3)}`)
assert(a.repeatStrength > b.repeatStrength * 3,
  `间隔重复的强度应远高于集中爆发：${a.repeatStrength.toFixed(2)} vs ${b.repeatStrength.toFixed(2)}`)
const ha = halfLifeOf(a, {}, t0 + 100 * DAY)
const hb = halfLifeOf(b, {}, t0 + 100 * DAY)
assert(ha > hb, `间隔重复的半衰期应更长：${ha.toFixed(1)} vs ${hb.toFixed(1)}`)
console.log(`PASS 8 间隔 > 爆发：间隔递增强度 ${a.repeatStrength.toFixed(2)}（半衰期 ${ha.toFixed(1)} 天）` +
  ` vs 同日 6 次 ${b.repeatStrength.toFixed(2)}（半衰期 ${hb.toFixed(1)} 天）`)

console.log('\n全部通过')
