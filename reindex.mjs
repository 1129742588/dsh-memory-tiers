#!/usr/bin/env node
/**
 * 重建向量库 —— 换 embedding 模型后必须跑一次
 *
 * 为什么需要它：
 *   向量是模型输出的坐标，换模型 = 换坐标系。旧坐标在新坐标系里没有任何意义。
 *   更麻烦的是常用的几个模型（Qwen3-Embedding-0.6B / bge-m3）**都是 1024 维**，
 *   维度检查发现不了，cosine() 会照常算出数字——不报错，只是越来越不准。
 *
 * 用法：
 *   node reindex.mjs                      # 用默认目录 ~/.dsh/storages/memory-v5
 *   node reindex.mjs --dir D:/my/memory   # 指定库目录
 *   node reindex.mjs --dry                # 只体检：库里有几条、当前用什么模型、要嵌多少
 *   node reindex.mjs --force              # 不备份旧向量（默认会先改名隔离）
 *
 * 跑完重启 dsh 生效。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createSilicon } from './silicon.mjs'

const VEC_SHARD_SIZE = 5000
const VEC_SHARD_RE = /^vectors-part-(\d{4})\.json$/
const vecShardName = (i) => `vectors-part-${String(i).padStart(4, '0')}.json`

// 和 memory5.embedOne / embedMany 保持一致：单条最多 512 字。
// 口径不一致的话，重建出来的向量和线上新写入的向量不是同一个分布。
const TEXT_LIMIT = 512

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
const has = (name) => process.argv.includes(name)

const dir = arg('--dir') || join(homedir(), '.dsh', 'storages', 'memory-v5')
const dry = has('--dry')
const force = has('--force')

function die(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

if (!existsSync(join(dir, 'store.json'))) die(`找不到库：${dir}/store.json（用 --dir 指定正确目录）`)

const cfgPath = join(dir, 'config.json')
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}
const apiKey = cfg.apiKey || process.env.SILICONFLOW_API_KEY
const base = cfg.apiBase || 'https://api.siliconflow.cn/v1'

if (!apiKey) {
  die(`没配 apiKey（${cfgPath} 的 "apiKey" 或环境变量 SILICONFLOW_API_KEY）。
  没有 key 就没有 embedding 模型，重建无从谈起（v0.5.2 起已不再用本地哈希向量兜底）。`)
}

let silicon
try {
  silicon = createSilicon({ apiKey, base, models: cfg.models || {} })
} catch (err) {
  die(`模型层初始化失败：${err?.message ?? err}`)
}

const stage = silicon.resolveStage('embed')
const signature = `api:${stage.model}`

const store = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'))
const items = (store.items || []).filter((it) => it && it.id && String(it.text || '').trim())

console.log('库目录   ', dir)
console.log('条目     ', items.length, '条有文本')
console.log('向量模型 ', stage.model, '@', stage.base)
console.log('指纹     ', signature)

// 现有向量的指纹（给「要不要重建」一个判断依据）
const metaPath = join(dir, 'vectors.meta.json')
let meta = null
try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch { /* 没有就是老库 */ }
if (meta) console.log('现有向量 ', `${meta.count} 条 / ${meta.dim} 维 / 来自 ${meta.sig || '(未知)'}`)
else console.log('现有向量 ', '(没有指纹文件，视为旧库)')

if (meta && meta.sig === signature && !has('--rebuild')) {
  console.log('\n✓ 指纹已经一致，不需要重建（确实想重嵌加 --rebuild）')
  process.exit(0)
}

if (dry) {
  console.log('\n--dry：不写任何文件。去掉 --dry 才会真正重嵌。')
  process.exit(0)
}

// ── 备份旧向量（默认做，--force 跳过）──────────────────────────────
if (!force) {
  const files = readdirSync(dir).filter((f) => VEC_SHARD_RE.test(f) || f === 'vectors.meta.json')
  if (files.length) {
    const bak = join(dir, `vectors.stale-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(bak, { recursive: true })
    for (const f of files) {
      try { renameSync(join(dir, f), join(bak, f)) } catch { /* 单个失败不影响后续 */ }
    }
    console.log(`\n旧向量已备份到 ${bak}（${files.length} 个文件）`)
  }
}

// ── 重嵌 ────────────────────────────────────────────────────────────
const t0 = Date.now()
const vectors = []
const BATCH = 32
let done = 0
let failed = 0

for (let i = 0; i < items.length; i += BATCH) {
  const slice = items.slice(i, i + BATCH)
  let vecs = null
  try {
    vecs = await silicon.embed(slice.map((it) => String(it.text).slice(0, TEXT_LIMIT)))
  } catch (err) {
    console.warn(`  批 ${i / BATCH + 1} 失败：${err?.message ?? err}`)
  }
  for (let j = 0; j < slice.length; j++) {
    const v = vecs?.[j]
    if (v && v.length) vectors.push([slice[j].id, Float32Array.from(v)])
    else failed++
  }
  done += slice.length
  process.stdout.write(`\r  已处理 ${done}/${items.length}  失败 ${failed}`)
}
process.stdout.write('\n')

if (!vectors.length) die('一条都没嵌成功，检查 key / 模型名 / 网络后重试')

// ── 写分片（格式与 memory5 一致：base64 的 Float32Array）──────────────
const shardCount = Math.ceil(vectors.length / VEC_SHARD_SIZE)
for (let i = 0; i < shardCount; i++) {
  const out = {}
  for (const [k, v] of vectors.slice(i * VEC_SHARD_SIZE, (i + 1) * VEC_SHARD_SIZE)) {
    out[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
  }
  writeFileSync(join(dir, vecShardName(i)), JSON.stringify(out), 'utf8')
}
// 清掉多余的旧片（条目变少时）
for (const f of readdirSync(dir)) {
  const m = f.match(VEC_SHARD_RE)
  if (m && Number(m[1]) >= shardCount) {
    try { renameSync(join(dir, f), join(dir, f + '.old')) } catch { /* 忽略 */ }
  }
}

writeFileSync(metaPath, JSON.stringify({
  sig: signature,
  dim: vectors[0][1].length,
  count: vectors.length,
  at: new Date().toISOString(),
}, null, 1), 'utf8')

const secs = ((Date.now() - t0) / 1000).toFixed(1)
const usage = silicon.usage?.()
console.log(`\n✓ 重建完成：${vectors.length} 条 / ${vectors[0][1].length} 维 / 用时 ${secs}s`)
if (failed) console.log(`  ⚠ ${failed} 条嵌入失败，这些条目暂时只能靠关键词命中，重跑一次通常会补上`)
if (usage?.tokens) console.log(`  用量约 ${usage.tokens} token`)
console.log('\n重启 dsh 生效。')
