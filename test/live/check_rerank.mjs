/**
 * dsh 侧精排验证：用库里已有摘要的正文当查询，确保候选池里有相关项。
 *
 * 真实查询（nnUNet）在 detail 层没有相关条目，精排自然无从生效；
 * 这里只为验证「精排机制本身」是否被触发。
 *
 * 用法：SILICON_API_KEY=... node dsh/test/live/check_rerank.mjs
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMemory } from '../../core/memory.mjs'
import { createSilicon } from '../../core/silicon.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', '..', '..', 'astrbot', 'test', 'live', 'run', 'dsh-lib')

const silicon = createSilicon({
  apiKey: process.env.SILICON_API_KEY || '',
  base: 'https://api.siliconflow.cn/v1',
  noThink: { chat: true, summary: true },
})

const mem = createMemory({
  dir: LIB,
  writer: 'dsh',
  embedSignature: `api:${silicon.resolveStage('embed').model}`,
  embed: (t) => silicon.embed(t),
  judgeRelation: (a, b) => silicon.relation(a, b),
  summarizeWithSources: (l, ch, f, h) => silicon.summarizeWithSources(l, ch, f, h),
  rerank: (q, d) => silicon.rerank(q, d),
  cfg: { hotMaxChars: 12000, consolidateMaxChars: 300, longMaxChars: 2000, quietMs: 0 },
})

const seed = mem.list('DL3').find((x) => String(x.text || '').length > 12)
if (!seed) {
  console.error('FAIL 没有可用摘要')
  process.exit(1)
}
const q = String(seed.text).slice(0, 20)
const r = await mem.search(q, { depth: 'detail', limit: 5 })
const rels = r.hits.map((h) => h.rel)
console.log(`query=「${q}」 reranked=${r.reranked} hits=${r.hits.length}`)
console.log(`rel=${JSON.stringify(rels)}`)
console.log(`top=${r.hits[0]?.id} (${r.hits[0]?.layer})`)

if (!r.reranked || !rels.some((x) => x != null)) {
  console.error('FAIL 精排没有生效')
  process.exit(1)
}
console.log('PASS dsh：精排生效（rel 有值且按精排重排）')
