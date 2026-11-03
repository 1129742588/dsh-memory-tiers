/**
 * A5 回归：融合判 duplicate 之后，旧摘要的正文被更长的文本替换，
 * 它的向量必须跟着重算。
 *
 * 修复前的症状：memory6 的 duplicate 分支先 `vectors.delete(sum.id)`（被合并掉的那条），
 * 再 `embedInto([top.it])`；但 embedInto 会过滤掉"已经有向量"的条目，
 * 所以 top.it 的旧向量一直留着，下次 fusionPrefilter 是拿旧正文的向量在比。
 *
 * 用法：node dsh/test/test_fuse_vector.mjs
 * 退出码：0 = 通过；1 = 断言失败。
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemory } from '../core/memory.mjs'

const A_TEXT = '摘要A'                 // 3 字
const B_TEXT = '摘要A的更长版本'       // 8 字 → mergeSummaries 会用它替换旧正文

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** 用 dumpVectors 落盘再解回来，确认用的是"实际存下来的向量"而不是内部 Map */
function vecOf(mem, root, id, tag) {
  const p = join(root, `vec-${tag}.json`)
  mem.dumpVectors(p)
  const all = JSON.parse(readFileSync(p, 'utf8'))
  const b64 = all[id]
  if (!b64) return null
  const buf = Buffer.from(b64, 'base64')
  const out = []
  for (let i = 0; i < buf.length; i += 4) out.push(buf.readFloatLE(i))
  return out
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'a5-fuse-'))
  try {
    let phase = 0
    const mem = createMemory({
      dir: root,
      writer: 'astrbot',
      embedSignature: 'api:test',
      // 向量只跟正文长度有关：[1, len]。
      // A=[1,3] 与 B=[1,8] 的余弦 ≈0.98（> 0.82 预筛），保证走到判关系那一步。
      embed: async (texts) => texts.map((t) => [1, String(t).length]),
      summarizeWithSources: async () => ({
        summaries: [{
          text: phase === 0 ? A_TEXT : B_TEXT,
          importance: 0.9,
          sources: [1],
        }],
        keep: [],
      }),
      judgeRelation: async () => 'duplicate',
      cfg: {
        hotMaxChars: 5, hotMaxItems: 2,
        consolidateMaxChars: 500, consolidateMaxItems: 2,
        quietMs: 0, viewRefreshMs: 0,
      },
    })

    // ── 第一轮：产出摘要 A ──
    phase = 0
    await mem.writeTurn([
      { text: '第一轮原文一', speaker: 'user' },
      { text: '第一轮原文二', speaker: 'user' },
    ])
    await mem.organize()

    const firstList = mem.list('DL3')
    assert(firstList.length === 1, `第一轮应产出 1 条 DL3 摘要，实际 ${firstList.length}`)
    const first = firstList[0]
    const before = vecOf(mem, root, first.id, 'before')
    assert(before && before[1] === A_TEXT.length,
      `合并前的向量应基于「${A_TEXT}」（len=${A_TEXT.length}），实际 ${JSON.stringify(before)}`)

    // ── 第二轮：新摘要更长 + 判 duplicate → 合并进旧摘要 ──
    phase = 1
    await mem.writeTurn([
      { text: '第二轮原文一', speaker: 'user' },
      { text: '第二轮原文二', speaker: 'user' },
    ])
    await mem.organize()

    const merged = mem.list('DL3')
    assert(merged.length === 1, `融合后 DL3 应仍为 1 条，实际 ${merged.length}`)
    const target = merged[0]
    assert(target.id === first.id, `应保留旧摘要的 id，实际 ${target.id} ≠ ${first.id}`)
    assert(target.text === B_TEXT, `正文应被更长的文本替换，实际「${target.text}」`)

    const after = vecOf(mem, root, target.id, 'after')
    assert(after, '合并后旧摘要的向量丢了')

    if (after[1] !== B_TEXT.length) {
      throw new Error(
        `A5 未修复：正文已变成 ${B_TEXT.length} 字，向量却仍是 ${after[1]} 字那一版\n` +
        `        合并前 ${JSON.stringify(before)} → 合并后 ${JSON.stringify(after)}\n` +
        `        期望 ${JSON.stringify([1, B_TEXT.length])}`,
      )
    }

    console.log('PASS A5：融合后正文变长，旧摘要的向量已按新正文重算')
    console.log(`  合并前 ${JSON.stringify(before)}（${A_TEXT}）→ 合并后 ${JSON.stringify(after)}（${B_TEXT}）`)
    console.log(`  DL3 条数 1，id 保留 ${target.id}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('FAIL A5：' + e.message)
  process.exit(1)
})
