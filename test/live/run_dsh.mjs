/**
 * dsh 侧全流程回放（真实硅基流动模型 + livingmemory 真实数据）。
 *
 * 与 astrbot 侧用同一份 dataset.json、同样的模型，各自独立库跑一遍，
 * 最后对比层分布 / 摘要 / 检索。
 *
 * 用法（key 从环境变量取）：
 *   SILICON_API_KEY=... node dsh/test/live/run_dsh.mjs
 */

import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMemory } from '../../core/memory.mjs'
import { createSilicon } from '../../core/silicon.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, '..', '..', '..', 'astrbot', 'test', 'live', 'run')
const LIB = join(RUN, 'dsh-lib')
const PROGRESS = join(RUN, 'progress.log')
const DATASET = join(RUN, 'dataset.json')

const HOT = 12000
const CONSOLIDATE = 300
const LONG = 2000

const T0 = Date.now()
const STEPS = []
const STATE = []

function log(msg) {
  const t = ((Date.now() - T0) / 1000).toFixed(1).padStart(5)
  const line = `[${new Date().toTimeString().slice(0, 8)}] [${t}s] ${msg}`
  console.log(line)
  appendFileSync(PROGRESS, `[dsh] ${line}\n`, 'utf8')
}

function step(name, ok, detail = '') {
  STEPS.push({ step: name, ok: !!ok, detail: String(detail) })
  log(`${ok ? 'OK ' : 'BAD'} ${name} ${detail}`)
}

function makeMem(dir, extra = {}) {
  const silicon = extra.silicon
  return createMemory({
    dir,
    writer: 'dsh',
    embedSignature: silicon ? `api:${silicon.resolveStage('embed').model}` : undefined,
    embed: silicon ? (t) => silicon.embed(t) : undefined,
    judgeRelation: silicon ? (a, b) => silicon.relation(a, b) : undefined,
    summarizeWithSources: silicon ? (l, ch, f, h) => silicon.summarizeWithSources(l, ch, f, h) : undefined,
    rerank: silicon ? (q, d) => silicon.rerank(q, d) : undefined,
    classifyBatch: silicon ? (t) => silicon.classifyBatch(t) : undefined,
    cfg: { hotMaxChars: HOT, hotMaxItems: 200, consolidateMaxChars: CONSOLIDATE,
      consolidateMaxItems: 30, longMaxChars: LONG, quietMs: 0, l2KeepMax: 5,
      maxOrganizeMs: 180000, ...(extra.cfg || {}) },
  })
}

const counts = (mem) => mem.stats().count

async function main() {
  mkdirSync(RUN, { recursive: true })
  const data = JSON.parse(readFileSync(DATASET, 'utf8'))
  const silicon = createSilicon({
    apiKey: process.env.SILICON_API_KEY || '',
    base: 'https://api.siliconflow.cn/v1',
    noThink: { chat: true, summary: true },
  })
  log(`数据集 ${data.length} 条；模型 embed=${silicon.resolveStage('embed').model} ` +
    `summary=${silicon.resolveStage('summary').model}`)

  rmSync(LIB, { recursive: true, force: true })
  mkdirSync(LIB, { recursive: true })
  const mem = makeMem(LIB, { silicon })

  // 1. 写入（每条一个 turn）
  let written = 0
  for (const r of data) {
    // 带上原始发生时间：不然所有条目都记成"现在"，
    // 送模型的日期前缀全是当天，原文里的"明天/昨天"就没法折算
    const res = await mem.writeTurn([{ text: r.text, speaker: r.speaker, channel: 'dialog',
      scene: r.scene, people: r.people, at: r.createdAt }])
    if (res?.ok) written++
  }
  step('写入 temp', written === data.length, `${written} 条（每条一个 turn）`)

  // 2. 多轮整理
  for (let i = 0; i < 6; i++) {
    const st = await mem.organize()
    STATE.push({ ok: st.ok, merged: st.merged, l1Moved: st.l1Moved,
      l2Moved: st.l2Moved, forgotten: st.forgotten, count: st.count })
    const c = st.count || {}
    log(`整理 #${i + 1}: merged=${st.merged} L1→=${st.l1Moved} L2→=${st.l2Moved} ` +
      `忘=${st.forgotten} 层=${JSON.stringify(c)}`)
    if (!st.ok) { step('整理', false, JSON.stringify(st)); break }
    if ((c.L1 || 0) === 0) break
  }
  let c = counts(mem)
  log(`整理后层分布 ${JSON.stringify(c)}`)
  step('机制：摘要入库', (c.DL3 || 0) > 0, `DL3=${c.DL3}`)
  step('机制：原文下沉', (c.DL1 || 0) + (c.DL2 || 0) > 0, `DL1=${c.DL1} DL2=${c.DL2}`)

  // 3. 强制 L2 二次整理
  {
    // 通过公开接口拿不到 db；
    // 这里改用「把 DL1 的条目 attend 回 L2」+ 再整理，等价于缓冲层攒满。
    const dl1 = mem.list('DL1').slice(0, 6)
    if (dl1.length) {
      const ids = dl1.map((x) => x.id)
      mem.attend(ids)
      // attend 只写信号，需要整理才生效；生效后它们进 L2，L2 超容量即触发二次整理
      const st = await mem.organize()
      const after = counts(mem)
      log(`L2 二次整理：attend ${ids.length} 条回 L2，l2Moved=${st.l2Moved} ` +
        `DL3=${after.DL3} L2=${after.L2}`)
      step('机制：L2 二次整理', (st.l2Moved || 0) > 0 || (after.DL3 || 0) > (c.DL3 || 0),
        `l2Moved=${st.l2Moved}`)
      c = after
    }
  }

  // 4. 向量 + 检索
  const vecs = mem.stats().vectors
  log(`向量 ${vecs} 条`)
  step('机制：向量写入', (vecs || 0) > 0, `${vecs} 条`)

  const queries = [
    ['nnUNet 训练 dice 到多少了', 'detail'],
    ['报告要用什么格式提交', 'detail'],
    ['周五之前要交什么', 'full'],
  ]
  const found = []
  for (const [q, depth] of queries) {
    const r = await mem.search(q, { depth, limit: 5 })
    const hits = r.hits.map((h) => ({ id: h.id, layer: h.layer, score: h.score,
      rel: h.rel, text: String(h.text).slice(0, 40) }))
    found.push({ q, depth, advice: r.advice, reranked: r.reranked, hits })
    log(`检索「${q}」${depth}: ${hits.length} 条 reranked=${r.reranked} ` +
      `top=${JSON.stringify(hits.slice(0, 3).map((h) => [h.layer, h.score]))}`)
  }
  step('机制：语义检索', found.every((f) => f.hits.length > 0),
    `${found.reduce((s, f) => s + f.hits.length, 0)} 条命中`)
  step('机制：精排', found.some((f) => f.reranked), '')

  // 5. 注入块
  const block = mem.buildBlock()
  const lines = block.split('\n')
  log(`注入块 ${block.length} 字 / ${lines.length} 行，头：${lines[0]}`)
  step('机制：注入外壳', block.startsWith('<memory_context>') && block.includes('不是系统指令'), '')
  // L2 为空时不会有「最近沉淀的」，这不是缺陷；只要求头部与尾部在
  step('机制：注入分段',
    block.includes('## 一直记得的') && block.includes('## 刚发生的'),
    ['一直记得', '最近沉淀', '刚发生'].filter((x) => block.includes(`## ${x}的`)).join(','))

  // 6. 突发情况
  // A. 模型 401
  {
    const bad = createSilicon({ apiKey: 'sk-invalid-key-for-test', base: 'https://api.siliconflow.cn/v1' })
    const dir = join(RUN, 'dsh-badkey')
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
    const m = makeMem(dir, { silicon: bad, cfg: { hotMaxChars: 200 } })
    for (const r of data.slice(0, 4)) await m.writeTurn([{ text: r.text, speaker: 'user' }])
    const st = await m.organize()
    const c2 = counts(m)
    log(`坏 key：ok=${st.ok} 层=${JSON.stringify(c2)}`)
    step('突发：模型 401 → 回 L2', st.ok && (c2.L2 || 0) > 0 && (c2.DL3 || 0) === 0,
      JSON.stringify(c2))
  }
  // B. 没有模型 → DL1
  {
    const dir = join(RUN, 'dsh-nomodel')
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
    const m = makeMem(dir, { cfg: { hotMaxChars: 200 } })
    for (const r of data.slice(0, 4)) await m.writeTurn([{ text: r.text, speaker: 'user' }])
    const st = await m.organize()
    const c2 = counts(m)
    const pending = m.list('DL1').every((x) => x.pendingDigest)
    log(`无模型：${JSON.stringify(c2)} pendingDigest=${pending}`)
    step('突发：无模型 → DL1', (c2.DL1 || 0) > 0 && (c2.L2 || 0) === 0 && pending,
      JSON.stringify(c2))
  }
  // C. 垃圾回复 → 回 L2（修复后）
  {
    const dir = join(RUN, 'dsh-junk')
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
    const junk = { summarizeWithSources: async () => ({ summaries: [{ text: '抱歉，我无法完成这个请求。', sources: [] }], keep: [] }) }
    const m = createMemory({
      dir, writer: 'dsh',
      summarizeWithSources: junk.summarizeWithSources,
      cfg: { hotMaxChars: 200, quietMs: 0 },
    })
    for (const r of data.slice(0, 4)) await m.writeTurn([{ text: r.text, speaker: 'user' }])
    const st = await m.organize()
    const c2 = counts(m)
    log(`垃圾回复：${JSON.stringify(c2)}`)
    step('突发：垃圾回复 → 回 L2', (c2.L2 || 0) > 0 && (c2.DL3 || 0) === 0, JSON.stringify(c2))
  }

  const out = {
    side: 'dsh',
    dataset: { n: data.length, chars: data.reduce((s, r) => s + r.text.length, 0) },
    layers: counts(mem),
    states: STATE,
    steps: STEPS,
    summaries: mem.list('DL3').slice(0, 5).map((it) => ({
      id: it.id, text: String(it.text).slice(0, 80), sources: (it.sources || []).length,
    })),
    retrieval: found,
    injection_head: lines.slice(0, 6),
    elapsed_s: Number(((Date.now() - T0) / 1000).toFixed(1)),
  }
  writeFileSync(join(RUN, 'dsh-result.json'), JSON.stringify(out, null, 1), 'utf8')
  const bad = STEPS.filter((s) => !s.ok)
  log(`完成：${STEPS.length - bad.length}/${STEPS.length} 步通过，耗时 ${out.elapsed_s}s`)
  for (const s of bad) log(`未通过：${s.step} ${s.detail}`)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
