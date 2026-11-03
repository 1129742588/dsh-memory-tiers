/**
 * dsh-memory-tiers · 模型层
 *
 * 给记忆系统提供几种能力，除此之外什么都不做：
 *   embed(texts)                 → 向量（语义检索用）
 *   rerank(query, docs)          → 精排（区分「相关」和「字面擦边」）
 *   summarizeWithSources(...)    → 摘要 + 出处（分流靠它：被引用的进 DL2）
 *   classifyBatch(texts)         → 重要度 + 类型（决定去 L2 还是沉 DL1）
 *   relation(a, b)               → 两条摘要的关系（重复/矛盾/进展）
 *
 * 两条通道：
 *   ① HTTP：OpenAI 兼容接口（默认硅基流动），每阶段可单独指定 base / key / model
 *   ② 会话模型：摘要和判关系可以直接用当前对话的模型，不用另配 key
 *      由 createSessionCaller() 提供，取不到就回落 HTTP，**不会永久放弃**。
 *
 * 三条约定：
 *   · 任何能力失败都返回 null（不抛），由记忆系统降级（关键词检索 / 不产生假摘要）；
 *     但每次失败都要留痕（onLog），否则「检索为什么变差了」永远查不到。
 *   · 没有 key 且用的是云端默认地址 → 直接跳过，不发请求（省得每轮 401）。
 *     本地端点（自己填的 base）允许无 key。
 *   · prompt 里的措辞是实测调出来的，改之前先想清楚为什么。
 */

const DEFAULT_BASE = 'https://api.siliconflow.cn/v1'

/** 只有这两种阶段能走「当前会话模型」——嵌入和精排必须是固定的向量/精排模型 */
export const SESSION_STAGES = ['chat', 'summary']

const DEFAULTS = {
  apiKey: '',
  apiBase: '',
  models: {},                 // { embed:{base,apiKey,model,source}, rerank:{...}, chat:{...}, summary:{...} }
  embedModel: 'BAAI/bge-m3',
  rerankModel: 'BAAI/bge-reranker-v2-m3',
  // 这两条只在「不跟会话模型」时用得上
  chatModel: 'inclusionAI/Ling-mini-2.0',
  summaryModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
  timeoutMs: 20000,
  summaryTimeoutMs: 90000,    // 一次要读几十条，给足时间
  retries: 2,
  maxConcurrent: 6,
  rateLimitRetries: 5,
  rateLimitBaseMs: 900,
  summaryChunk: 60,           // 一次摘要最多塞几条
  noThink: { chat: true, summary: true },
  onLog: null,                // (kind, detail) => void，由 index 写进插件日志
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================
// 并发闸
//
// 整理一批会同时发好几个请求（分类、摘要、判重），不限流必然撞 429。
// 撞了用「指数退避 + 单独计数」（429 是"你太快了"，不是"请求错了"）。
// ============================================================

let inflight = 0
const gateWaiters = []

function gateAcquire(max) {
  if (inflight < max) { inflight++; return Promise.resolve() }
  return new Promise((resolve) => { gateWaiters.push(() => { inflight++; resolve() }) })
}

function gateRelease() {
  inflight--
  const next = gateWaiters.shift()
  if (next) next()
}

/** 云端地址没 key 就别发请求了（本地端点不在此列） */
const CLOUD_HOST = /(^|\.)(siliconflow\.cn|deepseek\.com|openai\.com|moonshot\.cn|bigmodel\.cn)(\/|$)/
export function isCloudBase(base) {
  try { return CLOUD_HOST.test(new URL(base).host) } catch { return false }
}

/**
 * POST JSON，带超时 / 并发上限 / 分层重试。
 *
 * ★ 超时必须覆盖到「读完 body」：旧实现拿到响应头就 clearTimeout，
 *   body 卡住时这个请求会永远占着一个并发位，后面所有模型调用排队等死。
 */
async function post(url, key, body, opts = {}) {
  const {
    timeoutMs = 20000, retries = 2, maxConcurrent = 6,
    rateLimitRetries = 5, rateLimitBaseMs = 900,
  } = opts

  await gateAcquire(maxConcurrent)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let netAttempt = 0
  let rlAttempt = 0
  try {
    while (true) {
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (key) headers.Authorization = `Bearer ${key}`
        const r = await fetch(url, {
          method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
        })
        const text = await r.text()      // 读 body 也在 signal 的覆盖范围内

        if (!r.ok) {
          if (r.status === 429 && rlAttempt < rateLimitRetries) {
            rlAttempt++
            await sleep(rateLimitBaseMs * rlAttempt * (1 + Math.random()))
            continue
          }
          if (r.status >= 500 && netAttempt < retries) {
            netAttempt++
            await sleep(500 * netAttempt)
            continue
          }
          throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`)
        }
        try { return JSON.parse(text) } catch { throw new Error('响应不是 JSON：' + text.slice(0, 120)) }
      } catch (e) {
        if (netAttempt >= retries) throw e
        netAttempt++
        await sleep(300 * netAttempt)
      }
    }
  } finally {
    clearTimeout(timer)
    gateRelease()
  }
}

/**
 * 从模型回复里抠出 JSON。
 *
 * 旧实现取「最后一个 } 或 ]」当结尾，模型在 JSON 后面补一句解释就整段解析失败。
 * 现在从第一个 { 或 [ 开始做括号配平，取第一个完整值。
 */
export function parseJson(text) {
  const s = String(text || '')
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : s
  const start = body.search(/[[{]/)
  if (start === -1) return null
  const open = body[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/** 整条回复被一层 ``` 包住时脱掉外壳；正文里的围栏不动 */
export function stripFence(text) {
  const s = String(text || '').trim()
  const m = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/)
  return m ? m[1].trim() : s
}

/**
 * 解析「1,3,5」「1-5」「1—5」这几种写法，返回去重后的合法下标（1 起）。
 * 越界的一律丢掉——模型编出 99 号是常事，不能让它把路由带跑偏。
 */
export function parseIndexList(raw, n) {
  const out = new Set()
  for (const part of String(raw || '').split(/[,，、\s]+/)) {
    if (!part) continue
    const range = part.match(/^(\d+)\s*[-—~～]\s*(\d+)$/)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      if (a >= 1 && b >= a && b <= n) for (let i = a; i <= b; i++) out.add(i)
      continue
    }
    const k = Number(part)
    if (Number.isInteger(k) && k >= 1 && k <= n) out.add(k)
  }
  return [...out].sort((a, b) => a - b)
}

// ============================================================
// 提示词
// ============================================================

const CLASSIFY_SYS = [
  '你给一条记忆打两个标签，输出一行 JSON。',
  '',
  'channel 三选一：',
  '  action = 自己动手做了一件具体的事。跑通了、删掉 37 条、补完标注、部署了。',
  '  dialog = 说了一段话，重点在话本身。他说他最怕漏诊、我吐槽像年糕、聊到爬山。',
  '  event  = 外面发生的事，不是自己主动做的。刷到一条视频、看到有人吵架、路上被撞、群里出事。',
  '  分不清 action 和 event 时：自己动手 = action，外面发生的 = event。都不像就选 dialog。',
  '  别人说的话（转述、要求、抱怨、答应）都算 dialog，哪怕内容是命令——',
  '  「老王说周五之前必须交报告」是 dialog，不是 event。',
  '',
  'importance 三档：0.85 定原则或长期诉求；0.6 有结果的具体事件；0.25 闲聊琐事。',
  '',
  '★ 比例很重要：绝大多数记忆是 0.6 或 0.25。',
  '  0.85 只给「以后都这样做」的规则、禁令、长期偏好，一天里通常不超过一两条。',
  '  不确定时给 0.6，不要给 0.85。',
  '  「做了某件事、拿到了某个结果」是 0.6，不是 0.85——哪怕结果很重要。',
  '',
  '示例：',
  '记忆：以后评估一律以召回率为准  → {"importance":0.85,"channel":"dialog"}',
  '记忆：以后叫我小鱼就行，别叫全名  → {"importance":0.85,"channel":"dialog"}',
  '记忆：把后处理加了连通域过滤，Dice 涨了 0.02  → {"importance":0.6,"channel":"action"}',
  '记忆：下午补完了 64 例标注  → {"importance":0.6,"channel":"action"}',
  '记忆：刷到一个讲肺结节的，说得挺在理  → {"importance":0.6,"channel":"event"}',
  '记忆：群里聊到爬山，我说看天气  → {"importance":0.25,"channel":"dialog"}',
  '记忆：今天有点困  → {"importance":0.25,"channel":"dialog"}',
  '',
  '只输出 JSON，不要解释。',
].join('\n')

const CLASSIFY_BATCH_SYS = [
  '你给一批记忆各打两个标签，输出一个 JSON 数组。',
  '',
  'channel 三选一：',
  '  action = 自己动手做了一件具体的事。跑通、删掉 37 条、补完标注、部署。',
  '  dialog = 说了一段话，重点在话本身。',
  '  event  = 外面发生的事，不是自己主动做的。刷到视频、看到吵架、路上被撞。',
  '  分不清 action 和 event 时：自己动手 = action，外面发生的 = event。都不像就选 dialog。',
  '  别人说的话（转述、要求、抱怨、答应）都算 dialog，哪怕内容是命令。',
  '',
  'importance 三档：0.85 定原则或长期诉求；0.6 有结果的具体事件；0.25 闲聊琐事。',
  '',
  '★ 比例很重要：一批里绝大多数应该是 0.6 或 0.25，0.85 通常只有一两条。',
  '  0.85 只给「以后都这样做」的规则、禁令、长期偏好。不确定时给 0.6。',
  '  做了某件事、拿到了某个结果（跑通、删掉 37 条、补完 128 例）是 0.6，不是 0.85。',
  '  每条独立判断，不要因为前一条给了 0.85 就跟着给。',
  '',
  '输出格式（每项必须带 i，i 就是输入的编号）：',
  '[{"i":1,"importance":0.85,"channel":"dialog"},{"i":2,"importance":0.25,"channel":"dialog"}]',
  '',
  '规则：',
  '  - 输入的每一条都要有一项，不能漏、不能多。',
  '  - 顺序无关，靠 i 对齐。',
  '  - 示例：',
  '    1. 以后评估一律以召回率为准  → {"i":1,"importance":0.85,"channel":"dialog"}',
  '    2. 把后处理加了连通域过滤，Dice 涨了 0.02  → {"i":2,"importance":0.6,"channel":"action"}',
  '    3. 刷到一个讲肺结节的  → {"i":3,"importance":0.6,"channel":"event"}',
  '    4. 今天有点困  → {"i":4,"importance":0.25,"channel":"dialog"}',
  '',
  '只输出 JSON 数组，不要解释。',
].join('\n')

const RELATION_SYS = [
  '你判断两条记忆的关系，只输出一个词。',
  '',
  'duplicate      同一件事，只是措辞不同；同一条规则被重复强调也算。',
  'contradiction  后一条推翻了前一条。「别发表情」和「多发表情」',
  'update         后一条是前一条的进展或补充，不冲突。「Dice 0.86」和「Dice 涨到 0.88」',
  'unrelated      两件不同的事。',
  '',
  '只输出这四个词之一，不要解释。',
].join('\n')

// 本地下限保护：模型判过低的典型（有动作 + 有数字结果），只抬不降
const RESULT_PATTERNS = /(跑通|改完|部署|提交|补完|删掉|清理|扩容|优化|压到|涨到|降到|过了|做完|写完|跑完|推进|上线)[^。，；]{0,24}?(\d|一半|翻倍|四成|三成|两倍)/
const HIGH_PATTERNS = /(以后|从今|一律|永远|不许|不准|不要|必须|只能|记住|原则|标准是|我说了算)/

const IMPORTANCE_TIERS = [0.85, 0.6, 0.25]
const snapImportance = (n) => IMPORTANCE_TIERS.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a))

// ============================================================
// 分流模型的 prompt 与解析（两个阶段，两套格式）
//
// 一次调用同时决定「哪些写成摘要（并给出处）」和「哪些留原文」。
// 阶段不同、prompt 不同、档位不同，但**只有一套解析器**，靠 phase 区分：
//
//   l1（L1 溢出时）：★ 摘要（→ DL3，引用原文 → DL2）/ `+ 行号` 留原文（→ L2）/ 其余 → DL1
//   l2（L2 满时）：  ★★ 重要 / ★ 一般 / ☆ 琐事 三档都写摘要（→ DL3，0.9/0.6/0.3）
//                    / `+ 行号` 限量留 L2 / 其余 → DL1
//
// ★ 不再有 `·` 档：旧版 `·`=0.7 与「first pass 只收 importance ≥ 0.9」的结构互斥，
//   导致 `·` 摘要必然被丢弃、原文既不进 DL2 也不进 L2。现在只有带标记的行才算数。
// ============================================================

const FOCUS = {
  action: '重点：做了什么、结果如何、数字变化。',
  event: '重点：发生了什么、在哪、大概经过。细节可以模糊，但「发生过这件事」这个骨架必须留住。',
  dialog: '重点：谁说了什么、定了什么、聊到哪了。特别注意对方表达的原则和长期诉求，这类一定要留下。',
}

const focusOf = (channel) => FOCUS[channel] || FOCUS.dialog

/** 两个阶段共用的规则：时间折算、人名、不许编 */
function sharedRules(folks = []) {
  return [
    '保留人名和具体数字。不许写原文里没有的事。',
    '原文行首的 [月-日] 是这一条发生的时间。原文里的「今天/明天/昨天/下周」'
    + '要按那个日期折算成具体日期再写进摘要；摘要里不要出现「今天」这种离开原文就看不懂的词。',
    folks.length
      ? `这批里出现过的人：${folks.join('、')}。摘要里写到具体的事，必须带上是谁说的/谁做的。`
      : '原文里如果有人名，摘要里也要留着。',
  ]
}

/** 第一阶段（L1 溢出）：只分两档——写摘要（★，带出处）/ 留原文（+）/ 其余不管 */
function buildL1Prompt({ list, hint = '', folks = [], maxLines = 2, focus = '' }) {
  const sys = '你把几条记忆做分流：值得长期记住的写成摘要并标出处，有信息量但还不到摘要程度的标 +，其余不用管。'
  const user = [
    hint ? `要求：${hint}` : '',
    focus || FOCUS.dialog,
    ...sharedRules(folks),
    '',
    `这一批共 ${list.length} 条，最多写 ${maxLines} 条摘要——这是上限，不是任务量。`,
    '输出格式（一行一条）：',
    '★ 摘要正文（不超过40字）《1,3,5》',
    '+ 4,7',
    '',
    '★ = 值得长期记住：原则、约定、决定、关键结果、长期偏好、「以后一律…」、稳定的项目背景。',
    '    这类内容就是该写摘要的，不要因为「怕写多」而不敢标 ★。',
    '+ = 有信息量、但写摘要不划算：具体数字、人名、时间地点、结论细节、约定细节。',
    '    大约一到三成，宁少勿多；打招呼、附和、当下状态不要标 +。',
    '其余的不要写——它们会沉到流水账，这是设计好的。',
    '',
    '《》里填这条摘要依据的原文编号，逗号分隔，连续的可以写成 1-3；必须是真实存在的编号。',
    '一条摘要只讲一件事；两件不相干的事不要挤进同一行（编号之间毫无关系 = 在硬凑）。',
    '只有 ★ 开头的行算摘要，只有 + 开头的行算保留；其它行会被忽略。',
    '',
    '原文：',
    ...list.map((t, i) => `${i + 1}. ${t}`),
  ].filter(Boolean).join('\n')
  return { sys, user }
}

/** 第二阶段（L2 满）：三档摘要都做 + 少量原文保留 + 其余下沉 */
function buildL2Prompt({ list, hint = '', folks = [], maxLines = 3, keepMax = 10, focus = '' }) {
  const sys = '你把一批原文做二级整理：分三档写摘要并标出处，少量保留原文，其余下沉。'
  const user = [
    hint ? `要求：${hint}` : '',
    focus || FOCUS.dialog,
    ...sharedRules(folks),
    '',
    `这一批共 ${list.length} 条，最多写 ${maxLines} 条摘要。`,
    '输出格式（一行一条）：',
    '★★ 摘要正文《1,3,5》',
    '★  摘要正文《7》',
    '☆  摘要正文《9》',
    '+ 12,15',
    '',
    '★★ = 重要：原则、决定、长期承诺、关键结果。',
    '★  = 一般：有信息量的日常、约定、进展、有结论的讨论。',
    '☆  = 琐事：发生过，但只值得留一句。',
    '三档都要写摘要，区别只在重要性：★★ 少、★ 多、☆ 也少（不值得写就不写，不写会下沉）。',
    `+ = 不写摘要、但原文值得留着（最多 ${keepMax} 条；宁少勿多）。`,
    '其余不写——它们会沉到流水账，这是设计好的。',
    '',
    '《》规则同前：必须是真实存在的编号；一条摘要只讲一件事。',
    '只有 ★★ / ★ / ☆ 开头的行算摘要；其它行会被忽略。',
    '',
    '原文：',
    ...list.map((t, i) => `${i + 1}. ${t}`),
  ].filter(Boolean).join('\n')
  return { sys, user }
}

/**
 * 解析分流模型的输出。两阶段共用，靠 phase 区分档位。
 *
 * @param {string} out 模型原文
 * @param {number} n   本批条数（编号上界，越界丢弃）
 * @param {'l1'|'l2'} phase
 * @returns {{summaries:Array<{text:string,sources:number[],importance:number}>, keep:number[]}}
 */
export function parseSummaryOutput(out, n, phase = 'l1') {
  const summaries = []
  const keep = []
  for (const raw of String(out || '').split('\n')) {
    let line = raw.trim()
    if (!line) continue

    // 「+ 12,15」= 不写摘要、但原文值得留着
    const plus = line.match(/^[+＋]\s*([\d,，、\s\-—~～]+)$/)
    if (plus) {
      for (const k of parseIndexList(plus[1], n)) if (!keep.includes(k)) keep.push(k)
      continue
    }

    let imp = null
    if (phase === 'l2') {
      if (line.startsWith('★★')) { imp = 0.9; line = line.slice(2) }
      else if (line.startsWith('★')) { imp = 0.6; line = line.slice(1) }
      else if (line.startsWith('☆')) { imp = 0.3; line = line.slice(1) }
      else continue
    } else {
      if (!line.startsWith('★')) continue
      imp = 0.9
      line = line.replace(/^★+/, '')
    }
    // 模型偶尔会在星号后补一个项目符号（`★ · 正文`）
    line = line.trim().replace(/^[·•．.\-–—*]\s*/, '').trim()
    if (!line) continue

    const m = line.match(/^(.*?)[《<【(（]\s*([\d,，、\s\-—~～]+)\s*[》>】)）]\s*$/)
    if (!m) {
      const plain = line.replace(/[《》]/g, '').trim()
      if (plain) summaries.push({ text: plain, sources: [], importance: imp })
      continue
    }
    const text = m[1].trim()
    if (!text) continue
    summaries.push({ text, sources: parseIndexList(m[2], n), importance: imp })
  }
  return { summaries, keep }
}

// ============================================================
// 会话模型通道
// ============================================================

/**
 * 走 dsh 自己的会话模型（不需要额外的 key）。
 *
 * ★ 旧实现第一次拿不到服务就把「试过了」记死，而它偏偏在插件装载那一刻探测
 *   （服务可能还没就绪）→ 整进程「摘要/融合跟会话模型走」这条默认路径永久失效。
 *   现在：每次调用前惰性解析；失败只冷却 30 秒，之后重试。
 *
 * @param {() => object|null} getCtx 返回 dsh 的 ctx（每次调用时取，不要闭包固定）
 */
export function createSessionCaller(getCtx, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const defaultTimeout = Number(opts.timeoutMs) || 30000
  let cached = null
  let retryAt = 0

  /** 拿 llm / agentDefaultModel 两个服务；拿不到就冷却，不永久放弃 */
  function services() {
    if (cached) return cached
    if (Date.now() < retryAt) return null
    try {
      const ctx = typeof getCtx === 'function' ? getCtx() : getCtx
      if (!ctx) throw new Error('ctx 还没就绪')
      const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : null) ?? ctx.llm
      const dm = (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null) ?? ctx.agentDefaultModel
      if (!llm || typeof llm.prepareCall !== 'function') throw new Error('没有 llm.prepareCall')
      cached = { llm, dm }
      retryAt = 0
      return cached
    } catch (e) {
      retryAt = Date.now() + 30_000
      log('SESSION_UNAVAILABLE', String(e?.message ?? e))
      return null
    }
  }

  function selection() {
    const s = services()
    if (!s?.dm || typeof s.dm.currentSelection !== 'function') return null
    try {
      const sel = s.dm.currentSelection()
      return sel?.provider && sel?.model ? sel : null
    } catch { return null }
  }

  const available = () => !!selection()

  /** 关思考 = 取这个模型支持的最低推理档 */
  function lowestEffort(modelInfo) {
    const efforts = modelInfo?.reasoning?.efforts
    if (Array.isArray(efforts) && efforts.length && efforts[0]?.id) return efforts[0].id
    return undefined
  }

  /** 打一次请求。失败抛错（由调用方回落 HTTP）。返回 { text, provider, model }。 */
  async function call({
    system = '', user = '', maxTokens = 400, temperature = 0,
    disableThinking = true, timeoutMs = defaultTimeout,
  }) {
    const s = services()
    if (!s) throw new Error('拿不到 dsh 的 llm 服务')
    const sel = selection()
    if (!sel) throw new Error('取不到当前会话模型')

    const signal = AbortSignal.timeout(timeoutMs)
    const callHandle = await s.llm.prepareCall(
      { provider: sel.provider, model: sel.model, maxTokens },
      signal,
      (controls, modelInfo) => {
        const next = { ...controls }
        next.temperature = temperature
        if (disableThinking) {
          const effort = lowestEffort(modelInfo)
          if (effort !== undefined) next.reasoningEffort = effort
        }
        return next
      },
    )

    // prepareCall 已经把配置冻住，事后不要再改 maxTokens / temperature，
    // 否则会触发 "prepared LLM call config changed before adapter dispatch"。
    const options = {
      ...callHandle.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(user) }] }],
      system: String(system || ''),
      purpose: 'memory-tiers',
      signal,
    }

    let text = ''
    let failure = null
    for await (const chunk of callHandle.stream(options)) {
      const t = chunk?.type
      if (t === 'text-delta') text += chunk.text ?? ''
      else if (t === 'error') { failure = chunk; break }
      else if (t === 'finish') {
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk
        break
      }
    }
    if (failure) throw new Error(String(failure?.failure?.message ?? failure?.message ?? '会话模型调用失败'))
    return { text: text.trim(), provider: sel.provider, model: sel.model }
  }

  function info() {
    const sel = selection()
    if (!sel) {
      return { available: false, reason: services() ? 'agentDefaultModel 未就绪' : 'llm 服务不可用（30 秒后重试）' }
    }
    return { available: true, provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort ?? null }
  }

  return { available, selection, call, info }
}

// ============================================================
// 主体
// ============================================================

export function createLlm(options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  if (!cfg.models || typeof cfg.models !== 'object') cfg.models = {}
  const onLog = typeof cfg.onLog === 'function' ? cfg.onLog : null
  const log = (kind, detail) => { try { onLog?.(kind, detail) } catch { /* 日志失败不影响主流程 */ } }
  const getSession = typeof cfg.getSession === 'function' ? cfg.getSession : () => null

  const STAGES = ['embed', 'rerank', 'chat', 'summary']

  /**
   * 某阶段最终用哪套连接参数。
   * 优先级：models[stage].xxx > 顶层 apiBase/apiKey > 该阶段默认模型名。
   * source='session' 只对 chat/summary 有意义，且每次现问（不缓存可用性）。
   */
  function stage(name) {
    const over = cfg.models[name] || {}
    const base = String(over.base || cfg.apiBase || cfg.base || DEFAULT_BASE).replace(/\/+$/, '')
    const apiKey = over.apiKey || cfg.apiKey || ''
    const model = over.model || cfg[name + 'Model'] || ''
    const wantSession = over.source === 'session' && SESSION_STAGES.includes(name)
    return {
      name, base, apiKey, model, wantSession,
      chat: `${base}/chat/completions`,
      embed: `${base}/embeddings`,
      rerank: `${base}/rerank`,
    }
  }

  /** 错误要带「阶段 + 耗时」留痕，否则「检索为什么变差」查不出来 */
  function fail(stageName, err, ms) {
    log('MODEL_FAIL', `stage=${stageName} ms=${ms} msg=${String(err?.message ?? err).slice(0, 200)}`)
  }

  /**
   * 通用对话调用。
   * 先试会话模型（如果该阶段配置成跟随），失败安静回落 HTTP。
   */
  async function chat(system, user, opts = {}) {
    const {
      maxTokens = 400, temperature = 0, stage: stageName = 'chat',
      model, timeout = cfg.timeoutMs, thinking,
    } = opts
    const st = stage(stageName)
    const useModel = model || st.model
    const noThink = thinking === undefined
      ? cfg.noThink?.[stageName] === true
      : thinking === false

    if (st.wantSession) {
      const s = getSession()
      if (s?.available && typeof s.call === 'function') {
        const t0 = Date.now()
        try {
          const out = await s.call({ system, user, maxTokens, temperature, disableThinking: noThink, timeoutMs: timeout })
          const text = String(out?.text ?? out ?? '').trim()
          if (text) return text
          log('SESSION_EMPTY', `stage=${stageName} ms=${Date.now() - t0}`)
        } catch (err) {
          fail(`session:${stageName}`, err, Date.now() - t0)
        }
      }
    }

    if (!useModel) throw new Error(`阶段 ${stageName} 没有配置模型`)
    if (!st.apiKey && isCloudBase(st.base)) throw new Error(`阶段 ${stageName} 没有 API Key`)
    const body = {
      model: useModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
      temperature,
    }
    if (noThink) body.enable_thinking = false

    const t0 = Date.now()
    try {
      const d = await post(st.chat, st.apiKey, body, {
        timeoutMs: timeout, retries: cfg.retries, maxConcurrent: cfg.maxConcurrent,
        rateLimitRetries: cfg.rateLimitRetries, rateLimitBaseMs: cfg.rateLimitBaseMs,
      })
      return String(d.choices?.[0]?.message?.content || '').trim()
    } catch (err) {
      fail(stageName, err, Date.now() - t0)
      throw err
    }
  }

  // ---------- 对外能力 ----------

  /** 批量向量。失败返回 null，调用方退回关键词 */
  async function embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '').trim()).filter(Boolean)
    if (!list.length) return null
    const es = stage('embed')
    if (!es.apiKey && isCloudBase(es.base)) { log('NO_KEY', 'stage=embed'); return null }
    const t0 = Date.now()
    try {
      const d = await post(es.embed, es.apiKey, { model: es.model, input: list }, {
        timeoutMs: cfg.timeoutMs, retries: cfg.retries, maxConcurrent: cfg.maxConcurrent,
        rateLimitRetries: cfg.rateLimitRetries, rateLimitBaseMs: cfg.rateLimitBaseMs,
      })
      const vecs = (d.data || []).map((x) => x.embedding)
      return vecs.length === list.length ? vecs : null
    } catch (err) { fail('embed', err, Date.now() - t0); return null }
  }

  /** 精排。返回 [{index, score}]，顺序即排名 */
  async function rerank(query, docs, topN = 0) {
    const list = (docs || []).map((t) => String(t || ''))
    if (!list.length) return null
    const rs = stage('rerank')
    if (!rs.apiKey && isCloudBase(rs.base)) { log('NO_KEY', 'stage=rerank'); return null }
    const t0 = Date.now()
    try {
      const body = { model: rs.model, query: String(query || ''), documents: list }
      if (topN > 0) body.top_n = Math.min(topN, list.length)
      const d = await post(rs.rerank, rs.apiKey, body, {
        timeoutMs: cfg.timeoutMs, retries: cfg.retries, maxConcurrent: cfg.maxConcurrent,
        rateLimitRetries: cfg.rateLimitRetries, rateLimitBaseMs: cfg.rateLimitBaseMs,
      })
      return (d.results || []).map((x) => ({ index: x.index, score: Number(x.relevance_score) }))
    } catch (err) { fail('rerank', err, Date.now() - t0); return null }
  }

  /**
   * 分流模型：一次调用同时决定「哪些写成摘要（并给出处）」和「哪些留原文」。
   *
   * 两个阶段，两套 prompt（模块顶部），**同一套解析器**，靠 phase 区分：
   *   phase='l1'  ★ → DL3（引用 → DL2）/ `+ 行号` → L2 / 其余 → DL1
   *   phase='l2'  ★★(0.9) / ★(0.6) / ☆(0.3) 三档摘要 → DL3 / `+ 行号` 限量 → L2 / 其余 → DL1
   *
   * 超长批次按 summaryChunk 切开，下标加回偏移量，phase 继续往下传。
   *
   * @param {string[]} texts 一行一条原文（带日期前缀）
   * @param {string} channel dialog|action|event
   * @param {string[]} people 本批出现的人名
   * @param {string} hint 额外要求（场景 / 第二次整理的 K 条上限）
   * @param {{phase?:'l1'|'l2', keepMax?:number}} [opts]
   * @return {{summaries:Array<{text:string,sources:number[],importance:number}>, keep:number[], maxLines:number, phase:string}|null}
   *         sources / keep 都是 1 起的下标
   */
  async function summarizeWithSources(texts, channel = 'dialog', people = [], hint = '', opts = {}) {
    const list = (texts || []).map((t) => String(t || '').trim()).filter(Boolean)
    if (!list.length) return null
    const phase = opts.phase === 'l2' ? 'l2' : 'l1'
    const folks = (Array.isArray(people) ? people : []).filter(Boolean)
    const CHUNK = Number(cfg.summaryChunk) || 60
    const linesOf = (n) => Math.max(phase === 'l2' ? 3 : 2, Math.ceil(n / (phase === 'l2' ? 8 : 10)))

    // 超过一块就切；每块单独给 maxLines，合并时只作参考（引擎不据此截断）
    if (list.length > CHUNK) {
      const summaries = []
      const keep = []
      for (let i = 0; i < list.length; i += CHUNK) {
        const part = list.slice(i, i + CHUNK)
        const sub = await summarizeWithSources(part, channel, people, hint, opts)
        if (!sub) continue
        for (const x of sub.summaries) {
          summaries.push({ text: x.text, sources: x.sources.map((k) => k + i), importance: x.importance })
        }
        for (const k of sub.keep) keep.push(k + i)
      }
      return summaries.length || keep.length
        ? { summaries, keep, maxLines: linesOf(list.length), phase }
        : null
    }

    const maxLines = linesOf(list.length)
    const args = { list, hint, folks, maxLines, focus: focusOf(channel) }
    const prompt = phase === 'l2'
      ? buildL2Prompt({ ...args, keepMax: Number(opts.keepMax) || 10 })
      : buildL1Prompt(args)

    try {
      const out = await chat(prompt.sys, prompt.user, {
        maxTokens: Math.min(300 + 12 * list.length, 4000),
        temperature: 0.2, stage: 'summary', timeout: cfg.summaryTimeoutMs, thinking: false,
      })
      const { summaries, keep } = parseSummaryOutput(stripFence(out), list.length, phase)
      return summaries.length || keep.length ? { summaries, keep, maxLines, phase } : null
    } catch { return null }
  }

  /** 分类：返回 {importance, channel}，失败返回 null */
  async function classify(text) {
    const body = String(text || '').trim()
    if (!body) return null
    try {
      const out = await chat(CLASSIFY_SYS, `记忆：${body}`, { maxTokens: 300 })
      const j = parseJson(out)
      if (!j) return null
      const imp0 = Number(j.importance)
      if (!Number.isFinite(imp0)) return null
      let importance = snapImportance(imp0)
      const channel = ['dialog', 'action', 'event'].includes(j.channel) ? j.channel : 'dialog'
      if (RESULT_PATTERNS.test(body) && importance < 0.6) importance = 0.6
      if (HIGH_PATTERNS.test(body) && importance < 0.85) importance = 0.85
      return { importance, channel, by: 'model' }
    } catch { return null }
  }

  /**
   * 批量分类。返回数组，跟输入一一对应，**失败的位置是 null**
   * （上层保留 impRough，下轮再试；绝不拿假值污染数据）。
   */
  async function classifyBatch(texts, { chunk = 20 } = {}) {
    const list = (texts || []).map((t) => String(t || '').trim())
    const out = new Array(list.length).fill(null)
    const need = []
    for (let i = 0; i < list.length; i++) if (list[i]) need.push(i)
    if (!need.length) return out

    for (let start = 0; start < need.length; start += chunk) {
      const idx = need.slice(start, start + chunk)
      const payload = idx.map((i, k) => `${k + 1}. ${list[i]}`).join('\n')
      try {
        const raw = await chat(CLASSIFY_BATCH_SYS, payload, { maxTokens: 200 + idx.length * 60 })
        const arr = parseJson(raw)
        if (!Array.isArray(arr)) { log('MODEL_BAD_JSON', `stage=classifyBatch n=${idx.length}`); continue }
        const hasI = arr.some((x) => x && typeof x === 'object' && 'i' in x)
        for (let k = 0; k < idx.length; k++) {
          const i = idx[k]
          // 有 i 就严格按 i 对齐；缺项时**不能**退回按位置——那等于把两件事的标签互相污染
          const item = hasI ? arr.find((x) => Number(x?.i) === k + 1) : arr[k]
          if (!item) continue
          const imp0 = Number(item.importance)
          if (!Number.isFinite(imp0)) continue
          let importance = snapImportance(imp0)
          const channel = ['dialog', 'action', 'event'].includes(item.channel) ? item.channel : 'dialog'
          if (RESULT_PATTERNS.test(list[i]) && importance < 0.6) importance = 0.6
          if (HIGH_PATTERNS.test(list[i]) && importance < 0.85) importance = 0.85
          out[i] = { importance, channel, by: 'model' }
        }
      } catch { /* chat() 里已经记过失败 */ }
    }
    return out
  }

  /**
   * 判两条记忆的关系。
   * 返回 'duplicate' | 'contradiction' | 'update' | 'unrelated'，失败返回 null。
   */
  async function relation(a, b) {
    try {
      const out = await chat(RELATION_SYS, `A：${a}\nB：${b}`, { maxTokens: 10 })
      const w = String(out || '').trim().toLowerCase()
      for (const k of ['contradiction', 'duplicate', 'update', 'unrelated']) {
        if (w.includes(k)) return k
      }
      return null
    } catch { return null }
  }

  /** 给设置页/启动日志：现在到底哪些能力真的能用（不是「配了 key」而是「能发出去」） */
  function capabilities() {
    const e = stage('embed')
    const r = stage('rerank')
    const s = getSession()
    const httpChat = (name) => {
      const st = stage(name)
      return !!st.model && (!!st.apiKey || !isCloudBase(st.base))
    }
    return {
      embed: !!e.model && (!!e.apiKey || !isCloudBase(e.base)),
      rerank: !!r.model && (!!r.apiKey || !isCloudBase(r.base)),
      chat: httpChat('chat') || !!s?.available,
      summary: httpChat('summary') || !!s?.available,
      embedModel: e.model,
      session: s?.available ? { provider: s.provider, model: s.model } : null,
    }
  }

  /** 给设置页：某阶段最终解析成什么（覆盖已合并）+ 现在到底能不能发出去 */
  function resolveStage(name) {
    const st = stage(name)
    const s = st.wantSession ? getSession() : null
    const ready = st.wantSession
      ? !!s?.available
      : (!!st.model && (!!st.apiKey || !isCloudBase(st.base)))
    return {
      name,
      base: st.base,
      model: st.model,
      hasKey: !!st.apiKey,
      source: st.wantSession ? 'session' : 'api',
      sessionModel: st.wantSession ? (s?.available ? s.model : null) : null,
      ready,
    }
  }

  return {
    embed, rerank, summarizeWithSources, classify, classifyBatch, relation,
    resolveStage, capabilities, stages: () => STAGES,
  }
}
