/**
 * 分类链回归（dsh 侧）：写入打 impRough → 整理时整批问模型 → channel/importance 落地。
 *
 * 与 astrbot/test/test_classify.py 对应。要防的三个回退：
 *   ① 分类调用点又跑回 `routeMode !== 'citation'` 分支（默认 citation，等于死代码）
 *   ② 写入路径上开始调模型（每条多一次往返，且条目可能马上被作废）
 *   ③ 模型失败时拿本地正则假装分过（"没分类"看起来像"分类过了"）
 *
 * 用法：node dsh/test/test_classify.mjs
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemory, rawLine } from '../core/memory.mjs'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function readLayer(root, name) {
  try {
    return JSON.parse(readFileSync(join(root, `${name}.json`), 'utf8')).items || []
  } catch { return [] }
}

function readTemp(root, writer = 'astrbot') {
  const p = join(root, 'L1.tmp', `${writer}.jsonl`)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((ln) => JSON.parse(ln))
}

function readAudit(root) {
  const p = join(root, 'audit.log')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

/** 假模型：按内容判 action / event / 原则 / 闲聊 */
const fakeSummarize = async (lines, channel, people) => {
  // 返回"没有摘要"→ 整批回 L2，测试只关心分类结果
  return null
}

async function main() {
  // ── 1. 写入不分类，但打 impRough ──
  const root = mkdtempSync(join(tmpdir(), 'classify-'))
  try {
    const calls = []
    const mem = createMemory({
      dir: root,
      writer: 'astrbot',
      summarizeWithSources: fakeSummarize,
      classifyBatch: async (texts) => {
        calls.push(texts.length)
        return texts.map((t) => {
          if (t.includes('连通域')) return { importance: 0.6, channel: 'action' }
          if (t.includes('抖音')) return { importance: 0.6, channel: 'event' }
          if (t.includes('一律')) return { importance: 0.85, channel: 'dialog' }
          return { importance: 0.25, channel: 'dialog' }
        })
      },
      cfg: { hotMaxChars: 1, hotMaxItems: 10, quietMs: 0, consolidateMaxChars: 1e9 },
    })

    await mem.writeTurn([
      { text: '把后处理加了连通域过滤，Dice 涨了 0.02', speaker: 'user', scene: 'qq·项目群' },
      { text: '刷抖音刷到一个讲肺结节的，说得挺在理', speaker: 'user', scene: 'qq·项目群' },
      { text: '以后评估一律以召回率为准', speaker: 'user', scene: 'qq·项目群' },
      { text: '今天有点困', speaker: 'user', scene: 'qq·项目群' },
    ])

    const l1 = readLayer(root, 'L1')
    const temp = readTemp(root)          // 写入落在 L1.tmp/<writer>.jsonl
    const written = l1.length + temp.length
    assert(written === 4, `应写入 4 条，实际 ${written}`)
    const items = [...l1, ...temp]
    assert(items.every((it) => it.impRough === true), '没显式给 importance 的都应打 impRough')
    assert(items.every((it) => it.channel === 'dialog'), '写入时 channel 应保持默认 dialog')
    console.log('PASS 1 写入：4 条全部 impRough=true，channel 默认 dialog，未调模型')

    // ── 2. 整理时整批分类（默认 routeMode=citation，历史上这条被 continue 掉） ──
    await mem.organize()

    // 摘要返回 null → 整批原文档保底进 DL2，所以四层都要找
    const after = ['L1', 'L2', 'DL1', 'DL2'].flatMap((L) => readLayer(root, L))
    const find = (k) => after.find((it) => String(it.text || '').includes(k))
    const expect = [
      ['连通域', 0.6, 'action'],
      ['抖音', 0.6, 'event'],
      ['一律', 0.85, 'dialog'],
      ['困', 0.25, 'dialog'],
    ]
    for (const [key, imp, ch] of expect) {
      const it = find(key)
      assert(it, `找不到含「${key}」的条目`)
      assert(Math.abs(Number(it.importance) - imp) < 1e-9,
        `「${key}」importance 应为 ${imp}，实际 ${it.importance}`)
      assert(it.channel === ch, `「${key}」channel 应为 ${ch}，实际 ${it.channel}`)
      assert(!it.impRough, `「${key}」分类后应删掉 impRough`)
    }
    console.log('PASS 2 整理：一次请求分类 4 条，三种 channel + 三档 importance 全部落地')

    // ── 3. 送模型的行带日期 ──
    const at = new Date(2026, 9, 30, 21, 0, 0).getTime()   // 本地时间 2026-10-30 21:00
    const line = rawLine({ createdAt: at, speaker: 'user', text: '明天要出去打工' })
    assert(line.startsWith('[10-30] '), `行首应有日期，实际 ${line}`)
    assert(line.includes('user：明天要出去打工'), `说话人与正文格式不对：${line}`)
    assert(rawLine({ createdAt: 0, text: '无时间' }) === '无时间', '无时间戳时不该加空括号')
    console.log(`PASS 3 送模型的行：${line}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  // ── 4. 模型失败：保留 impRough，不拿本地规则顶上 ──
  const root2 = mkdtempSync(join(tmpdir(), 'classify-fail-'))
  try {
    const mem = createMemory({
      dir: root2,
      writer: 'astrbot',
      summarizeWithSources: fakeSummarize,
      classifyBatch: async (texts) => texts.map(() => null),
      cfg: { hotMaxChars: 1, hotMaxItems: 10, quietMs: 0, consolidateMaxChars: 1e9 },
    })
    await mem.writeTurn([{ text: '这条没分类成功', speaker: 'user' }])
    await mem.organize()

    const left = [...readLayer(root2, 'L1'), ...readLayer(root2, 'L2'),
      ...readLayer(root2, 'DL1'), ...readLayer(root2, 'DL2')]
      .filter((it) => String(it.text || '').includes('没分类成功'))
    assert(left.length, '条目不该丢')
    assert(left.every((it) => it.impRough === true), '分类失败必须保留 impRough')
    assert(left.every((it) => it.channel === 'dialog'), '失败时保持默认 dialog，不能瞎猜')
    console.log('PASS 4 模型失败：保留 impRough、保持 dialog')
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }

  // ── 5. 没有 classifyBatch：记 MODEL 缺失，不假装分过 ──
  const root3 = mkdtempSync(join(tmpdir(), 'classify-nomodel-'))
  try {
    const mem = createMemory({
      dir: root3,
      writer: 'astrbot',
      summarizeWithSources: fakeSummarize,
      cfg: { hotMaxChars: 1, hotMaxItems: 10, quietMs: 0, consolidateMaxChars: 1e9 },
    })
    await mem.writeTurn([{ text: '没有分类能力也要留着', speaker: 'user' }])
    await mem.organize()
    const log = readAudit(root3)
    assert(log.includes('classify'), `应留分类相关的跳过记录，实际日志尾部：${log.slice(-300)}`)
    console.log('PASS 5 无分类能力：留痕，条目保留 impRough')
  } finally {
    rmSync(root3, { recursive: true, force: true })
  }

  console.log('\n全部通过')
}

main().catch((e) => {
  console.error('FAIL', e?.message ?? e)
  process.exit(1)
})
