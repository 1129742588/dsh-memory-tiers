/**
 * 只读对照脚本（dsh 侧）。
 *
 * fixture 与 astrbot/test/parity_dump.py 逐字段一致，输出同一套 JSON，
 * 供 compare_parity.py 比对。不修改 core，不碰真实记忆库。
 *
 * 用法：node dsh/test/parity_dump.mjs
 * 输出：dsh/test/out/dsh.json
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMemory, makeItem, pickTurnBatch } from '../core/memory.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, 'out')
const BASE = 1762000000000
const LONG_MAX_CHARS = 1500
const HOT_MAX_CHARS = 3000

function item(kw = {}) {
  return {
    id: '', seq: 0, text: '', kind: 'raw', channel: 'dialog', layer: 'L1',
    speaker: '', people: [], scene: '', importance: 0.5, directEntry: false,
    heat: 1, lastMentionedAt: BASE, repeatStrength: 1, fusionCount: 0,
    recallCount: 0, supersededBy: null, createdAt: BASE, archivedAt: null,
    spanFrom: null, spanTo: null, pinned: false, archiveFile: null,
    origin: 'astrbot',
    ...kw,
  }
}

function fixtureLayers() {
  const l1 = [
    item({ id: 'm5_p1', seq: 1, text: '今天把召回率调到 0.88', speaker: 'user',
      people: ['小鱼'], scene: 'qq·项目群', createdAt: BASE, turnId: 't1' }),
    item({ id: 'm5_p2', seq: 2, text: '记下了，回头提醒你', speaker: 'bot',
      people: [], scene: 'qq·项目群', createdAt: BASE + 1000, turnId: 't1' }),
    item({ id: 'm5_p3', seq: 3, text: '明天要交报告', speaker: 'user', people: [],
      scene: 'qq·项目群', createdAt: BASE + 2000, turnId: 't2', origin: 'dsh' }),
  ]
  const l2 = [
    item({ id: 'm5_b1', seq: 4, text: '约定：报告统一用 markdown', layer: 'L2',
      speaker: 'user', createdAt: BASE - 200000000,
      consolidatedAt: BASE - 100000000, origin: 'dsh' }),
    item({ id: 'm5_b2', seq: 5, text: '旧的一条缓冲记录', layer: 'L2',
      createdAt: BASE - 300000000, consolidatedAt: BASE - 200000000 }),
  ]
  const dl1 = [
    item({ id: 'm5_d1', seq: 6, text: '流水账一条：中午吃了面', layer: 'DL1',
      createdAt: BASE - 500000000 }),
  ]
  const dl2 = [
    item({ id: 'm5_d2', seq: 7, text: '被摘要引用的原文', layer: 'DL2',
      createdAt: BASE - 600000000, consolidatedAt: BASE - 600000000, origin: 'dsh' }),
  ]
  const dl3 = [
    item({ id: 'm5_s0', seq: 8, text: '长期摘要：报告统一 markdown', kind: 'summary',
      layer: 'DL3', speaker: '', createdAt: BASE - 600000000,
      spanFrom: BASE - 600000000, spanTo: BASE - 600000000,
      importance: 0.9, heat: 2, sources: ['m5_d2'], origin: 'dsh', srcKey: 'k0' }),
    item({ id: 'm5_s1', seq: 9, text: '长摘要B' + '乙'.repeat(736), kind: 'summary',
      layer: 'DL3', createdAt: BASE - 500000000,
      spanFrom: BASE - 500000000, spanTo: BASE - 500000000,
      importance: 0.7, heat: 2, sources: [], origin: 'dsh', srcKey: 'k1' }),
    item({ id: 'm5_s2', seq: 10, text: '长摘要C' + '丙'.repeat(736), kind: 'summary',
      layer: 'DL3', createdAt: BASE - 400000000,
      spanFrom: BASE - 400000000, spanTo: BASE - 400000000,
      importance: 0.7, heat: 2, sources: [], origin: 'dsh', srcKey: 'k2' }),
    item({ id: 'm5_s3', seq: 11, text: '已作废摘要', kind: 'summary', layer: 'DL3',
      createdAt: BASE - 300000000, importance: 0.95, heat: 2,
      supersededBy: 'm5_s0', sources: [], origin: 'dsh', srcKey: 'k3' }),
  ]
  return { L1: l1, L2: l2, DL1: dl1, DL2: dl2, DL3: dl3 }
}

function fixtureTemps() {
  return {
    'parity.jsonl': [
      item({ id: 'm5_p4', seq: 12, text: '临时的一条', speaker: 'user', people: [],
        createdAt: BASE + 3000, turnId: 't3' }),
    ],
    'other.jsonl': [
      item({ id: 'm5_p5', seq: 13, text: '另一端的临时', speaker: 'bot', people: [],
        createdAt: BASE + 3500, turnId: 't4', origin: 'dsh' }),
    ],
    'x.claimed-1762000000000-abcd.jsonl': [
      item({ id: 'm5_p6', seq: 14, text: '已认领未落盘', speaker: 'user', people: [],
        createdAt: BASE + 4000, turnId: 't5', origin: 'dsh' }),
    ],
  }
}

function buildFixture(root) {
  mkdirSync(join(root, 'L1.tmp'), { recursive: true })
  for (const [name, items] of Object.entries(fixtureLayers())) {
    writeFileSync(join(root, `${name}.json`),
      JSON.stringify({ version: 2, at: BASE, items }, null, 1), 'utf8')
  }
  for (const [fname, rows] of Object.entries(fixtureTemps())) {
    writeFileSync(join(root, 'L1.tmp', fname),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  }
}

function pickFixture() {
  const out = []
  for (let i = 1; i <= 6; i++) {
    out.push(item({ id: `k${i}`, seq: 100 + i, text: '一', turnId: `u${i}`,
      createdAt: BASE + i * 1000 }))
  }
  return out
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'parity-dsh-'))
  try {
    buildFixture(root)
    const mem = createMemory({
      dir: root,
      writer: 'astrbot',
      // 不传 embed：语义层整体关闭，搜索只走关键词（与 astrbot 侧 vectors={} 等价）
      cfg: {
        hotMaxChars: HOT_MAX_CHARS,
        hotQuotaOwn: 0.7,
        longMaxChars: LONG_MAX_CHARS,
        consolidateMaxChars: 2500,
      },
    })

    const block = mem.buildBlock()
    const l1View = mem.list('L1')

    const pick = pickTurnBatch(pickFixture(), 6, {
      orderKey: (it) => it.createdAt,
      maxItems: 5,
    })

    // makeItem 的 id/seq/createdAt 是随机的，只比 people
    const made = makeItem({ text: '测试', speaker: 'user', people: [] })

    const cosineUnequal = cosine([1.0, 2.0], [1.0, 2.0, 3.0])

    const searched = await mem.search('报告 markdown', { depth: 'detail', limit: 6 })

    const out = {
      side: 'dsh',
      block,
      l1_view_ids: l1View.map((it) => it.id),
      l1_view_count: l1View.length,
      pick_ids: pick.map((it) => it.id),
      cosine_unequal: Number(cosineUnequal.toFixed(6)),
      make_item_people: made.people,
      search_depth: searched.depth,
      search_hits: searched.hits.map((h) => ({ id: h.id, score: h.score, layer: h.layer })),
      search_confidence: searched.confidence,
    }
    mkdirSync(OUT_DIR, { recursive: true })
    const dst = join(OUT_DIR, 'dsh.json')
    writeFileSync(dst, JSON.stringify(out, null, 2), 'utf8')
    console.log(`OK -> ${dst}`)
    console.log(`  l1_view=${l1View.length} pick=${pick.map((it) => it.id)} ` +
      `cos=${cosineUnequal.toFixed(4)} people=${JSON.stringify(made.people)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// memory6 没有导出 lineOf（模块内私有）；行格式的对照走 buildBlock 的真实输出，
// 这里不再另抄一份实现，避免"抄错了却当成差异"。

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

main().catch((e) => { console.error(e); process.exit(1) })
