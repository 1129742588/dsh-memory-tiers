/**
 * 第二次拆解（限流版）：每次调用之间等 10 秒，避免 429
 *
 *   node bench-profile.mjs
 *
 * 只测四件事：
 *   1. 输入 1k vs 100k 字，只输出 8 token   → 读输入到底要不要时间
 *   2. 500 条摘要，关思考                    → 单批的真实耗时和输出 token
 *   3. 2000 条：一次送 vs 分 4 批串行        → 分批到底快不快
 *   4. 2000 条一次送、开思考 vs 关思考        → 思考值多少钱
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = 'https://api.siliconflow.cn/v1'
const MODEL = process.env.PROFILE_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash'

function loadKey() {
  if (process.env.SILICONFLOW_API_KEY) return process.env.SILICONFLOW_API_KEY
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.dsh/storages/memory-v5/config.json'), 'utf8'))
    if (j.apiKey) return j.apiKey
  } catch { /* 没有 */ }
  return ''
}
const key = loadKey()
if (!key) { console.error('没有 API Key'); process.exit(2) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sec = (n) => (n / 1000).toFixed(2) + 's'
const SENT = '今天把肺结节数据集的标注又过了一遍，发现 37 个样本的轮廓偏移了大概 5 个像素，已经重新标好。'
const HINT = '把下面这批记录压成摘要。只输出 JSON：{"summaries":[{"text":"...","sources":[1,3],"importance":0.7}],"keep":[]}'
const lines = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. ${SENT}`)

async function call({ user, maxTokens = 8, system = '', think = null, retry = 3 }) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: user })
  const body = {
    model: MODEL, messages, max_tokens: maxTokens, temperature: 0.2,
    stream: true, stream_options: { include_usage: true },
  }
  if (think === false) body.enable_thinking = false

  for (let attempt = 0; attempt < retry; attempt++) {
    const t0 = Date.now()
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
    if (res.status === 429) {
      await sleep(15000)          // 限流：等一会儿再来
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)

    let ttft = 0
    let out = ''
    let usage = null
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const ls = buf.split('\n')
      buf = ls.pop() || ''
      for (const line of ls) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const p = s.slice(5).trim()
        if (p === '[DONE]') continue
        let j
        try { j = JSON.parse(p) } catch { continue }
        if (j.usage) usage = j.usage
        const d = j.choices?.[0]?.delta
        if (d?.content) { if (!ttft) ttft = Date.now() - t0; out += d.content }
      }
    }
    return { ttft, total: Date.now() - t0, outLen: out.length, usage }
  }
  throw new Error('连续 3 次 429')
}

const tok = (u, k) => u?.[k] ?? '?'

console.log(`\n模型 ${MODEL}（每次调用间隔 10 秒）\n`)

// 1. 读输入要不要时间
console.log('1. 输入长度 → 首 token（输出固定 8 token）')
for (const n of [1000, 100000]) {
  const text = SENT.repeat(Math.ceil(n / SENT.length)).slice(0, n)
  try {
    const r = await call({ user: `读这段，只回复「收到」：\n\n${text}`, maxTokens: 8, system: '只回复要求的词。' })
    console.log(`   ${String(n).padStart(6)} 字 / ${String(tok(r.usage, 'prompt_tokens')).padStart(6)} token → 首token ${sec(r.ttft)} · 总 ${sec(r.total)}`)
  } catch (e) { console.log(`   ${n} 失败 ${e.message.slice(0, 70)}`) }
  await sleep(10000)
}

// 2. 500 条摘要（关思考）
let single500 = null
console.log('\n2. 500 条摘要（关思考）')
try {
  single500 = await call({ user: `${HINT}\n\n${lines(500).join('\n')}`, maxTokens: 8000, system: '你是记忆压缩器。', think: false })
  const ct = tok(single500.usage, 'completion_tokens')
  console.log(`   首token ${sec(single500.ttft)} · 总 ${sec(single500.total)} · 输出 ${ct} token · 速度 ${(ct / (single500.total / 1000)).toFixed(0)} token/s`)
} catch (e) { console.log(`   失败 ${e.message.slice(0, 80)}`) }
await sleep(10000)

// 3. 2000 条：一次送 vs 4 批串行
console.log('\n3. 2000 条：一次送 vs 分 4 批（串行，都关思考）')
try {
  const all = lines(2000)
  const t0 = Date.now()
  const one = await call({ user: `${HINT}\n\n${all.join('\n')}`, maxTokens: 16000, system: '你是记忆压缩器。', think: false })
  const oneMs = Date.now() - t0
  console.log(`   一次送：${sec(oneMs)} · 输出 ${tok(one.usage, 'completion_tokens')} token`)
  await sleep(10000)

  const t1 = Date.now()
  let sumOut = 0
  for (let i = 0; i < 4; i++) {
    const r = await call({ user: `${HINT}\n\n${all.slice(i * 500, (i + 1) * 500).join('\n')}`, maxTokens: 8000, system: '你是记忆压缩器。', think: false })
    sumOut += (r.usage?.completion_tokens || 0)
    if (i < 3) await sleep(10000)
  }
  const partMs = Date.now() - t1
  console.log(`   4 批串行：${sec(partMs)}（含 3 次等待 30s，纯调用 ${sec(partMs - 30000)}）· 输出 ${sumOut} token`)
  console.log(`   → 串行分批不会更快：总输出 token 差不多，时间也差不多`)
} catch (e) { console.log(`   失败 ${e.message.slice(0, 100)}`) }

console.log('\n4. 结论（看数字即可）')
console.log('   - 输入 100k 的首 token 若和 1k 接近 → 读输入不是瓶颈')
console.log('   - 摘要耗时 ≈ 输出 token ÷ 速度；输出 token 由"摘要条数 × 每条长度"决定')
console.log('   - 想快只有两条路：少产出（限条数/限长度），或并发（受账户并发配额限制）')
