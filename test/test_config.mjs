#!/usr/bin/env node
/**
 * 配置页自检（dsh 端）。
 *
 * 三个容易出事的地方：
 *   1. 界面上有、服务端白名单没有 → 点了保存「成功」但没生效（最难查的那种）。
 *   2. 老的毫秒键没被换算 → 用户升级后 quietMs=600000 直接变成 600000 分钟。
 *   3. 时间类字段又悄悄改回毫秒 → 两端配置对不上，抄配置要心算。
 *
 * 跑法：node dsh/test/test_config.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateTimeUnits } from '../core/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(dirname(HERE), 'core')
const read = (f) => readFileSync(join(CORE, f), 'utf8')

const errs = []
const ok = (cond, msg) => { if (!cond) errs.push(msg) }

// ── 1. 毫秒 → 分钟 的迁移 ──
const m1 = migrateTimeUnits({ quietMs: 600000, organizeEveryMs: 300000 })
ok(m1.quietMin === 10, `quietMs=600000 应换算成 quietMin=10，实际 ${m1.quietMin}`)
ok(m1.organizeEveryMin === 5, `organizeEveryMs=300000 应换算成 organizeEveryMin=5，实际 ${m1.organizeEveryMin}`)
ok(!('quietMs' in m1) && !('organizeEveryMs' in m1), '迁移后不该留下老键')

const m2 = migrateTimeUnits({ quietMs: 600000, quietMin: 7 })
ok(m2.quietMin === 7, '新键已存在时，迁移不该覆盖新键')
ok(!('quietMs' in m2), '新键存在时也要删掉老键')

const m3 = migrateTimeUnits({ refreshMin: 30, semanticTtlMin: 3 })
ok(m3.refreshMin === 30 && m3.semanticTtlMin === 3, '纯新格式不该被改动')
ok(Object.keys(m3).length === 2, '纯新格式不该凭空多出键')

// 小于 1000 的老值当分钟（没人会把 10 分钟写成 10 毫秒）
const m4 = migrateTimeUnits({ quietMs: 30 })
ok(m4.quietMin === 30, '小于 1000 的老值按分钟解释')

// ── 2. 时间类字段不许再用毫秒命名 ──
for (const f of ['index.mjs', 'settings.mjs', 'client.mjs']) {
  const src = read(f)
  // 迁移表本身要提到老键，注释里也会提，所以只查"被当作配置读/写"的形态
  const bad = src.split('\n').filter((line) =>
    /(?:cfg\.(?:quietMs|organizeEveryMs|refreshMinMs|semanticTtlMs)\b)|(?:path: \['(?:quietMs|organizeEveryMs|refreshMinMs|semanticTtlMs)'\])|(?:^\s+(?:quietMs|organizeEveryMs|refreshMinMs|semanticTtlMs): '(?:number|string)')/.test(line),
  )
  ok(bad.length === 0, `${f} 还在把老毫秒键当配置用：\n      ${bad.join('\n      ')}`)
}

// ── 3. 设置页字段必须都在服务端白名单里 ──
const settingsSrc = read('settings.mjs')
const block = (name) => {
  const i = settingsSrc.indexOf(`const ${name} = {`)
  if (i < 0) return ''
  return settingsSrc.slice(i, settingsSrc.indexOf('\n}', i))
}
const writableKeys = new Set(
  [...block('WRITABLE').matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]),
)
const memoryKeys = new Set(
  [...block('MEMORY_CFG_WRITABLE').matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]),
)

const clientSrc = read('client.mjs')
const paths = [...clientSrc.matchAll(/path: \[([^\]]+)\]/g)].map((m) =>
  m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean),
)

let checked = 0
for (const p of paths) {
  if (p[0] === 'dir' || p[0] === 'models' || p[0] === 'noThink') continue // 单独处理，见 settings.mjs
  if (p.length === 1) {
    checked++
    ok(writableKeys.has(p[0]), `设置页有 ${p[0]}，但 settings.mjs 的 WRITABLE 里没有（保存会被静默忽略）`)
  } else if (p[0] === 'memoryCfg') {
    checked++
    ok(memoryKeys.has(p[1]), `设置页有 memoryCfg.${p[1]}，但 MEMORY_CFG_WRITABLE 里没有`)
  }
}

// 反向：白名单里有、界面上没有 —— 允许（内部定时器），但要显式列出来，防止漏配
const UI_ONLY_INTERNAL = new Set(['flushEveryMs', 'sweepEveryMs', 'layout', 'preset', 'budgetTokens'])
const uiTop = new Set(paths.filter((p) => p.length === 1).map((p) => p[0]))
for (const k of writableKeys) {
  if (UI_ONLY_INTERNAL.has(k)) continue
  ok(uiTop.has(k), `settings.mjs 白名单有 ${k}，但设置页没有对应字段（只能用 JSON 改）`)
}

// ── 4. 两端默认值要对得上（astrbot 的 DEFAULTS 在这几项上必须同值） ──
const idxSrc = read('index.mjs')
const memSrc = read('memory.mjs')
ok(/longMaxChars:\s*3000/.test(memSrc), 'memory.mjs 的 L3 容量默认值应为 3000（和 astrbot 的 long_max_chars 对齐）')
ok(/inject:\s*true/.test(idxSrc), 'index.mjs 应默认 inject: true')
ok(/quietMin:\s*10/.test(idxSrc), 'index.mjs 应默认 quietMin: 10（和 astrbot 的 quiet_min 对齐）')
ok(/organizeEveryMin:\s*5/.test(idxSrc), 'index.mjs 应默认 organizeEveryMin: 5（和 astrbot 的 organize_every_min 对齐）')
ok(/refreshMin:\s*30/.test(idxSrc), 'index.mjs 应默认 refreshMin: 30')
ok(/semanticTtlMin:\s*3/.test(idxSrc), 'index.mjs 应默认 semanticTtlMin: 3')

// ── 结果 ──
if (errs.length) {
  console.error('配置自检失败：')
  for (const e of errs) console.error('  ✗ ' + e)
  process.exit(1)
}
console.log(`配置自检通过：迁移 4 例，字段对齐 ${checked} 项，默认值 6 项`)
