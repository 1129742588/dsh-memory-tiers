/**
 * LivingMemory（AstrBot）→ dsh-memory-tiers v5 迁移
 *
 * 只迁 documents（42 条长期记忆文档）→ v5 的 DL3（摘要层）。
 * atoms（193 个细粒度事实）和图谱（389 节点/1993 边）暂不迁：
 *   documents 已经覆盖主要内容，全迁会让 DL3 变成 235 条重复；
 *   v5 没有图谱层，硬塞进文本只会污染检索。
 *
 * 向量：没有 embedding key，用与插件降级时**同一套** hashEmbed，
 * 保证「写入的向量」和「查询时算的向量」在同一个空间，能对上关键词。
 * 之后配了真 key，跑一次 reembed 就能换成真向量（另脚本）。
 *
 * 用法：
 *   node migrate-lm.mjs --to .test-migrate          # 迁到临时目录验证
 *   node migrate-lm.mjs --to ~/.dsh/storages/memory-v5   # 迁正式库（先备份）
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createMemory5, LAYER, makeItem } from './memory5.mjs'

const args = process.argv.slice(2)
const toIdx = args.indexOf('--to')
const target = toIdx >= 0 ? args[toIdx + 1] : ''
if (!target) {
  console.error('用法: node migrate-lm.mjs --to <目标目录>')
  process.exit(1)
}

const dir = target.startsWith('~') ? join(homedir(), target.slice(1)) : target
const exportPath = join(process.cwd(), '_lm_export.json')
if (!existsSync(exportPath)) {
  console.error('找不到 _lm_export.json，先跑 python _export_lm.py')
  process.exit(1)
}

const docs = JSON.parse(readFileSync(exportPath, 'utf8'))

/** 与 index.mjs 的 hashEmbed 完全一致——两边必须同源，否则查询对不上 */
function hashEmbed(texts, dim = 1024) {
  return texts.map((t) => {
    const s = String(t || '')
    const v = new Array(dim).fill(0)
    for (let i = 0; i < s.length; i++) {
      v[s.charCodeAt(i) % dim] += 1
      if (i < s.length - 1) v[(s.charCodeAt(i) * 31 + s.charCodeAt(i + 1)) % dim] += 0.5
    }
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
    return v.map((x) => x / n)
  })
}

const mem = createMemory5({
  dir,
  embed: hashEmbed,
  cfg: { summarizeMode: 'deferred' },
})

// 已有条目的最大 seq，接着往后排，避免和在线写入的条目撞序
const existing = mem.list()
const baseSeq = existing.reduce((m, it) => Math.max(m, Number(it.seq) || 0), 0)

let added = 0
const now = Date.now()
for (const [i, doc] of docs.entries()) {
  if (!doc.text || String(doc.text).trim().length < 10) continue

  const at = doc.create_time ? Math.round(doc.create_time * 1000) : now
  const item = makeItem({
    text: String(doc.text).trim(),
    layer: LAYER.DL_LONG,        // DL3 摘要层
    channel: 'dialog',
    kind: 'summary',
    importance: Number(doc.importance) || 0.6,
    at,
  })

  // 覆盖 id：用 lm- 前缀，和 v5 自己生成的 id 区分开，重跑不会重复（先查重）
  item.id = `lm-${doc.id}`
  if (existing.some((it) => it.id === item.id)) continue
  item.seq = baseSeq + i + 1
  item.heat = 2                  // 新摘要的初始热度
  item.spanFrom = at
  item.spanTo = at
  item.sources = []
  item.people = []

  mem._seed(item, hashEmbed([item.text])[0])
  added += 1
}

// 落盘（sweep 末尾会 store.save；DL3 不超容量，不会触发整理）
await mem.sweep()

const s = mem.stats()
console.log(`迁移完成：新增 ${added} 条 → ${dir}`)
console.log(`分布：L1=${s.count.L1} L2=${s.count.L2} L3视图=${s.count.L3} DL1=${s.count.DL1} DL2=${s.count.DL2} DL3=${s.count.DL3}`)
console.log(`总条数 ${s.total}，向量 ${s.vectors}`)

// 冒烟检索：用记忆里真实出现过的人名/话题
for (const q of ['语音', '小鱼', '植物大战僵尸', '艾婷']) {
  const r = await mem.search(q, { depth: 'summary', useRerank: false, limit: 2 })
  console.log(`  搜「${q}」→ ${r.hits.length} 条${r.hits.length ? '：' + r.hits[0].text.slice(0, 30) : ''}`)
}
