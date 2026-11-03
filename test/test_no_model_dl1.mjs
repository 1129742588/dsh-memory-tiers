/**
 * A3 回归（dsh 侧）：没有摘要能力时不产生假摘要，批次下沉 DL1 并免于遗忘。
 *
 * 与 astrbot/test/test_no_model_dl1.py 对应，断言保持一致：
 *   L1 清空（不挤上下文）· L2 不动（留到能压的时候）· DL1 收下 + pendingDigest
 *   · 这些条目不参与遗忘（否则"等模型"等成丢失）
 *
 * 用法：node dsh/test/test_no_model_dl1.mjs
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemory } from '../core/memory.mjs'

const DAY = 86400000

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function readLayer(root, name) {
  try {
    return JSON.parse(readFileSync(join(root, `${name}.json`), 'utf8')).items || []
  } catch { return [] }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'a3-nomodel-'))
  try {
    const mem = createMemory({
      dir: root,
      writer: 'astrbot',
      // 不传 summarizeWithSources：模拟"没有模型"
      cfg: { hotMaxChars: 5, hotMaxItems: 10, quietMs: 0, consolidateMaxChars: 2500 },
    })

    await mem.writeTurn([
      { text: '第一百天前的原文零', speaker: 'user' },
      { text: '第一百天前的原文一', speaker: 'user' },
    ])

    // ── 第一次整理：没有模型 ──
    const res = await mem.organize()
    assert(res.ok, `整理应成功，实际 ${JSON.stringify(res)}`)

    const l1 = readLayer(root, 'L1')
    const l2 = readLayer(root, 'L2')
    const dl1 = readLayer(root, 'DL1')
    assert(l1.length === 0, `L1 应被清空（不挤上下文），实际 ${l1.length} 条`)
    assert(l2.length === 0, `L2 不应被动过，实际 ${l2.length} 条`)
    assert(dl1.length === 2, `两条原文应进 DL1，实际 ${dl1.length} 条`)
    assert(dl1.every((it) => it.pendingDigest === true), '进 DL1 的条目应带 pendingDigest')

    // ── 把时间改旧，再整理一次，考遗忘保护 ──
    const old = Date.now() - 100 * DAY
    for (const it of dl1) {
      it.createdAt = old
      it.lastMentionedAt = old
    }
    writeFileSync(join(root, 'DL1.json'),
      JSON.stringify({ version: 2, at: 0, items: dl1 }), 'utf8')

    await mem.organize()
    const dl1b = readLayer(root, 'DL1')
    assert(dl1b.length === 2,
      `等模型整理的条目不该被遗忘，实际剩 ${dl1b.length} 条（被忘就是丢数据）`)

    console.log('PASS A3：无模型时 L1→DL1（不碰 L2），pendingDigest 免于遗忘')
    console.log(`  整理结果 l1Moved=${res.l1Moved} l2Moved=${res.l2Moved} ` +
      `count=${JSON.stringify(res.count)}`)
    console.log(`  L1=${l1.length} L2=${l2.length} DL1=${dl1.length} → 二次整理后 DL1=${dl1b.length}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('FAIL A3：' + e.message)
  process.exit(1)
})
