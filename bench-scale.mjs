/**
 * 大容量基准 —— 两个独立测试
 *
 *   node bench-scale.mjs sum                     # 一次摘要处理太多时：耗时 / token / 会不会失败
 *   node bench-scale.mjs sum --sizes=50,200,500  # 指定档位
 *   node bench-scale.mjs search                  # DL1/DL2/DL3 各 N 条时，检索耗时
 *   node bench-scale.mjs search --n=10000,100000 # 指定规模
 *   node bench-scale.mjs search --real           # 检索时带上 embed/rerank（1 次往返）
 *
 * sum 会花真钱（摘要模型）；search 默认不连模型，纯本地计时。
 */
import { createMemory6 } from './memory6.mjs'
import { createSilicon } from './silicon.mjs'
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const mode = process.argv[2] || 'sum'
const argv = Object.fromEntries(process.argv.slice(3).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v ?? true]
}))
const DRY = !!argv.dry
const REAL = !!argv.real
const KEEP = !!argv.keep

const list = (s, def) => (s ? String(s).split(',').map(Number).filter((x) => x > 0) : def)
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB'
const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n + ' ms')
const heap = () => mb(process.memoryUsage().heapUsed)

function loadKey() {
  if (process.env.SILICONFLOW_API_KEY) return process.env.SILICONFLOW_API_KEY
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.dsh/storages/memory-v5/config.json'), 'utf8'))
    if (j.apiKey) return j.apiKey
  } catch { /* 没配置 */ }
  return ''
}

// ── 素材：够长、有信息量，模型压的时候有东西可压 ──
const SENT = [
  '今天把肺结节数据集的标注又过了一遍，发现 37 个样本的轮廓偏移了大概 5 个像素，已经重新标好',
  '训练脚本加上了 cosine 学习率调度，前 10 个 epoch 用 warmup，之后按 0.95 的系数衰减',
  'Dice 从 0.86 涨到 0.88，主要收益来自把输入分辨率从 256 提到 384',
  '服务器上那个 3090 的机器又掉卡了，驱动版本是 535，换到 550 之后稳定了两天',
  '项目路径是 D:/lung，数据集在 D:/lung/data，模型权重放 D:/lung/weights',
  '这周的组会推迟到周四下午三点，地点还是在二楼小会议室',
  '群里不要发表情包，上次说了好几次了，还是有人发',
  '爬山回来腿疼了三天，山上风大，下次记得带护膝',
  '把 memory5 的分片逻辑抽出来之后，跨写者融合会丢数据的那条算是彻底堵上了',
  '文档要收敛成一个，之前那些 plan 和 report 删掉，别让下一个人（或者下一个我）读串',
]

// ============================================================
// 测试一：一次摘要处理太多条
// ============================================================
async function benchSum() {
  const sizes = list(argv.sizes, [50, 200, 500, 1000, 2000])
  const key = DRY ? '' : loadKey()
  if (!DRY && !key) {
    console.error('没有 API Key：设 SILICONFLOW_API_KEY，或用 --dry 只跑假模型')
    process.exit(2)
  }
  const silicon = DRY ? null : createSilicon({ apiKey: key, base: 'https://api.siliconflow.cn/v1', budgetTokens: 0, noThink: { chat: true } })

  console.log(`\n=== 摘要规模测试（${DRY ? '假模型' : '真实模型'}）===`)
  console.log('档位      字数     耗时      输入token  输出摘要  引用  结果')
  const rows = []
  for (const n of sizes) {
    const lines = Array.from({ length: n }, (_, i) => {
      const s = SENT[i % SENT.length]
      return `${i + 1}. ${s}${i >= SENT.length ? `（第 ${Math.floor(i / SENT.length) + 1} 次提到）` : ''}`
    })
    const chars = lines.reduce((a, b) => a + b.length, 0)
    const before = DRY ? { tokens: 0 } : silicon.usage()
    const t0 = Date.now()
    let res = null
    let err = null
    try {
      res = DRY
        ? { summaries: [{ text: 'S', sources: lines.slice(0, 3).map((_, i) => i + 1) }], keep: [] }
        : await silicon.summarizeWithSources(lines, 'dialog', [], '')
    } catch (e) { err = e?.message || String(e) }
    const took = Date.now() - t0
    const after = DRY ? { used: 0 } : silicon.usage()
    // 摘要走的是 chat 通道，别只统计 summarize 那一类，用总量差值最准
    const tokens = (after.used || 0) - (before.used || 0)
    const okFlag = !!res && !err
    rows.push({ n, chars, took, tokens, ok: okFlag, err })
    console.log(
      `${String(n).padStart(5)}  ${String(chars).padStart(7)}  ${ms(took).padStart(8)}  ` +
      `${String(tokens).padStart(9)}  ${String(res?.summaries?.length ?? 0).padStart(8)}  ` +
      `${String(res?.summaries?.reduce((a, s) => a + (s.sources?.length || 0), 0) ?? 0).padStart(4)}  ` +
      (okFlag ? 'ok' : `失败：${String(err).slice(0, 40)}`)
    )
  }
  const firstFail = rows.find((r) => !r.ok)
  console.log('\n结论：')
  if (firstFail) {
    console.log(`  ${firstFail.n} 条（${firstFail.chars} 字）时失败：${String(firstFail.err).slice(0, 80)}`)
    console.log('  → L1 一次性溢出到这么多时必须分批，否则整批摘要失败、原文回 L2 卡住')
  } else {
    const max = rows[rows.length - 1]
    console.log(`  最大档 ${max.n} 条 / ${max.chars} 字：${ms(max.took)}，${max.tokens} token（未失败）`)
  }
  const per1k = rows.filter((r) => r.ok).map((r) => r.took / (r.chars / 1000))
  if (per1k.length) console.log(`  平均每千字耗时：${(per1k.reduce((a, b) => a + b, 0) / per1k.length).toFixed(0)} ms`)
}

// ============================================================
// 测试二：深层有多少条时，检索开始变慢
// ============================================================
function makeRows(n, layer) {
  const base = Date.now() - n * 60e3
  const kind = layer === 'DL3' ? 'summary' : 'raw'
  return Array.from({ length: n }, (_, i) => {
    const at = base + i * 60e3
    const row = {
      id: `${layer}-${i}`,
      text: kind === 'summary'
        ? `摘要 ${i}：${SENT[i % SENT.length].slice(0, 60)}`
        : `${SENT[i % SENT.length]}（第 ${i} 条）`,
      kind, layer, channel: 'dialog', speaker: 'user', people: [],
      importance: 0.5 + (i % 5) * 0.1,
      heat: 1 + (i % 10),
      createdAt: at, lastMentionedAt: at,
      supersededBy: null,
    }
    if (kind === 'summary') { row.spanFrom = at; row.spanTo = at; row.sources = [] }
    return row
  })
}

function writeLayer(dir, name, n) {
  const items = makeRows(n, name)
  const body = JSON.stringify({ version: 2, at: Date.now(), items })
  writeFileSync(join(dir, `${name}.json`), body)
  return Buffer.byteLength(body, 'utf8')
}

async function benchSearch() {
  const sizes = list(argv.n, [10000, 100000, 300000])
  const key = (REAL && !DRY) ? loadKey() : ''
  const silicon = key ? createSilicon({ apiKey: key, base: 'https://api.siliconflow.cn/v1', budgetTokens: 0 }) : null

  console.log(`\n=== 检索规模测试（${silicon ? '带 embed/rerank' : '纯本地，不连模型'}）===`)
  console.log('每层条数   DL 文件合计   建库      注入(L1+L2+L3)  summary      detail       full')

  for (const n of sizes) {
    const dir = join('.bench-scale', `n${n}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })

    const tBuild0 = Date.now()
    let bytes = 0
    for (const l of ['DL1', 'DL2', 'DL3']) bytes += writeLayer(dir, l, n)
    // 活跃层放小一点：注入只读这三份
    writeFileSync(join(dir, 'L1.json'), JSON.stringify({ version: 2, at: Date.now(), items: makeRows(200, 'L1') }))
    writeFileSync(join(dir, 'L2.json'), JSON.stringify({ version: 2, at: Date.now(), items: makeRows(200, 'L2') }))
    writeFileSync(join(dir, 'L3.json'), JSON.stringify({ version: 2, at: Date.now(), items: makeRows(20, 'L3') }))
    const buildMs = Date.now() - tBuild0

    const mem = createMemory6({
      dir, writer: 'bench', embedSignature: 'none',
      ...(silicon ? { embed: (t) => silicon.embed(t), rerank: (q, d) => silicon.rerank(q, d) } : {}),
    })

    const t1 = Date.now()
    const block = mem.buildBlock()
    const injectMs = Date.now() - t1

    const time = async (depth) => {
      const t = Date.now()
      const r = await mem.search('爬山 风很大', { depth, limit: 6 })
      return { ms: Date.now() - t, hits: r.hits.length }
    }
    const s1 = await time('summary')
    const s2 = await time('detail')
    const s3 = await time('full')

    console.log(
      `${String(n).padStart(8)}  ${mb(bytes).padStart(11)}  ${ms(buildMs).padStart(7)}  ` +
      `${(ms(injectMs) + `(${block.length}字)`).padStart(15)}  ` +
      `${(ms(s1.ms) + `(${s1.hits})`).padStart(10)}  ${(ms(s2.ms) + `(${s2.hits})`).padStart(10)}  ${(ms(s3.ms) + `(${s3.hits})`).padStart(10)}`
    )
    if (!KEEP) rmSync(join('.bench-scale', `n${n}`), { recursive: true, force: true })
  }
  if (!KEEP) rmSync('.bench-scale', { recursive: true, force: true })
  console.log(`\n堆占用 ${heap()}（连续跑多档时含 GC 未回收的部分）`)
  console.log('说明：检索每次都会把目标层整个 JSON 读出来解析，所以耗时会随条数线性涨。')
}

if (mode === 'sum') await benchSum()
else if (mode === 'search') await benchSearch()
else {
  console.error('用法：node bench-scale.mjs sum|search [--sizes=...] [--n=...] [--real] [--dry] [--keep]')
  process.exit(2)
}
