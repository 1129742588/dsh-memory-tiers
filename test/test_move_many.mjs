/**
 * 批次 3 回归（dsh 侧）：批量搬层。
 *
 * 逐条 moveItem 每条要扫 5 个层并重建数组：10 万条 = 35 分钟。
 * moveMany 按目标层分桶后一次搬，O(5×层大小 + N)。
 *
 * 语义必须与 moveItem 一致：
 *   - 搬到目标层后其它层没有同一个 id
 *   - 同层再搬幂等（不重复 push）
 *   - 进 L2 写 consolidatedAt
 *
 * 用法：node dsh/test/test_move_many.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { createMemory } from '../core/memory.mjs'

const N = 100000

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function emptyDb(items = []) {
  return { L1: items, L2: [], DL1: [], DL2: [], DL3: [] }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'move-many-'))
  try {
    const mem = createMemory({ dir: root, writer: 'astrbot', cfg: {} })
    const items = Array.from({ length: N }, (_, i) => ({ id: `m${i}`, text: `第${i}条`, layer: 'L1' }))
    const db = emptyDb(items)

    // —— 1. 10 万条 L1 → DL1 ——
    const t0 = performance.now()
    mem._moveMany(db, items, 'DL1', 111)
    const dt = performance.now() - t0
    assert(db.DL1.length === N, `DL1 应有 ${N} 条，实际 ${db.DL1.length}`)
    assert(db.L1.length === 0, `L1 应清空，实际 ${db.L1.length}`)
    assert(db.DL1.every((it) => it.layer === 'DL1'), 'layer 字段没更新')
    assert(dt < 1000, `10 万条搬层应 < 1s，实际 ${dt.toFixed(0)}ms`)

    // —— 2. DL1 → L2：记 consolidatedAt ——
    mem._moveMany(db, items, 'L2', 222)
    assert(db.L2.length === N && db.DL1.length === 0, '搬层后两层条数不对')
    assert(db.L2.every((it) => it.consolidatedAt === 222), '进 L2 必须写 consolidatedAt')

    // —— 3. 同层再搬：幂等 ——
    mem._moveMany(db, items, 'L2', 333)
    assert(db.L2.length === N, `同层搬应幂等，实际 ${db.L2.length} 条`)

    // —— 4. 与逐条 moveItem 结果一致 ——
    const small = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, text: 'x', layer: 'L1' }))
    const dbA = emptyDb(small.map((x) => ({ ...x })))
    const dbB = emptyDb(small.map((x) => ({ ...x })))
    for (const it of dbB.L1) mem._moveItem(dbB, it, 'DL2', 444)
    mem._moveMany(dbA, dbA.L1.slice(), 'DL2', 444)
    for (const layer of ['L1', 'L2', 'DL1', 'DL2', 'DL3']) {
      const a = dbA[layer].map((x) => x.id)
      const b = dbB[layer].map((x) => x.id)
      assert(JSON.stringify(a) === JSON.stringify(b), `${layer} 批量与逐条结果不一致`)
    }

    console.log(`PASS 批次 3：10 万条搬层 ${dt.toFixed(0)}ms（< 1s），` +
      `同层幂等、L2 记 consolidatedAt、与 moveItem 结果一致`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('FAIL 批次 3：' + e.message)
  process.exit(1)
})
