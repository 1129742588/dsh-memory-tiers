/**
 * 「相关旧事」注入段回归（dsh 侧）。
 *
 * 背景：astrbot 一直有 `semantic_inject`（每轮按你说的话检索旧记忆，命中就拼一段），
 * dsh 之前没有——只有 `memory_search` 工具，模型得自己想得起来调。
 * 2026-11-02 给 dsh 补上，行为与 astrbot 对齐：
 *
 *   · 位置：注入块**最后**（`## 相关的旧事` 在 `## 刚发生的` 之后）
 *     因为它每轮都变，排在末尾才不会把前面的稳定前缀一起带崩
 *   · 空段不注入（不产生空标题）
 *   · 外壳仍然完整（以 <memory_context> 开头、</memory_context> 结尾）
 *
 * 这里只测「拼装」这一段纯逻辑；预取（异步检索 + TTL）在 index.mjs 里，
 * 需要宿主事件流，不在此覆盖。
 *
 * 用法：node dsh/test/test_semantic_extra.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemory } from '../core/memory.mjs'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'sem-extra-'))
  try {
    const mem = createMemory({
      dir: root,
      writer: 'dsh',
      cfg: { hotMaxChars: 1e6, hotMaxItems: 100, quietMs: 0, consolidateMaxChars: 1e9 },
    })
    await mem.writeTurn([
      { text: '今天把后处理加了连通域过滤', speaker: 'user' },
      { text: '记住了', speaker: 'bot' },
    ])

    const base = mem.buildBlock(0)
    assert(base.startsWith('<memory_context>'), '注入块应以 <memory_context> 开头')
    assert(base.includes('## 刚发生的'), '应含即时层段')

    const extra = '## 相关的旧事\n- 10-26 [DL2·user] 小鱼定肺结节后处理（0.61）'
    const withExtra = mem.buildBlock(0, { extra })

    assert(withExtra.includes('## 相关的旧事'), '应拼进「相关的旧事」段')
    assert(withExtra.indexOf('## 刚发生的') < withExtra.indexOf('## 相关的旧事'),
      '「相关的旧事」必须排在「刚发生的」之后（每轮都变的段放最后）')
    assert(withExtra.trimEnd().endsWith('</memory_context>'),
      '外壳必须完整闭合，语义段要插在闭合标签之前')
    console.log('PASS 1 额外段：拼在「刚发生的」之后、闭合标签之前')

    // 空段不注入
    const empty1 = mem.buildBlock(0, { extra: '' })
    const empty2 = mem.buildBlock(0, { extra: '   ' })
    assert(!empty1.includes('## 相关的旧事'), '空字符串不应产生空标题')
    assert(!empty2.includes('## 相关的旧事'), '纯空白也不应产生空标题')
    assert(empty1 === base, '空额外段的结果应与不带 extra 完全一致')
    console.log('PASS 2 空段不注入：与不带 extra 的输出逐字一致')

    // 外壳标签必须是中性的（不带任何一端的名字）
    assert(!withExtra.includes('dsh_memory'), '外壳不应再出现 dsh_memory')
    console.log('PASS 3 外壳中性：无 dsh_memory 残留')

    console.log('\n全部通过')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('FAIL', e?.message ?? e)
  process.exit(1)
})
