/**
 * 硅基流动适配层 —— 给四层记忆提供"模型能力"。
 *
 * 分工原则：按「调用频率 × 需要多少推理」来分，不是按"越贵越好"。
 *
 *   高频 + 不需要推理  → 小模型 / 免费模型
 *   低频 + 需要判断     → 大模型
 *   纯格式、纯时序、容量 → 本地规则，一次调用都不发
 *
 * 具体分工（全部实测选出来的，不是拍脑袋）：
 *
 *   Qwen/Qwen3-Embedding-0.6B    免费 · 89ms · 1024 维    每条记忆调一次
 *     语义召回。实测「漏诊风险」能把「假阴性率太高」排到第一，
 *     这是关键词永远做不到的。
 *
 *   Qwen/Qwen3-Reranker-0.6B     免费 · 244ms               每次搜索调一次
 *     精排。实测区分度比 bge-reranker 好一个量级
 *     （0.0303 vs 0.0010；而 bge 是 0.0140 vs 0.0122，几乎拉不开）。
 *
 *   inclusionAI/Ling-mini-2.0    437-977ms                  每条记忆调一次
 *     分类、判重。实测分类 9/10、JSON 稳定、判重三对全对。
 *     试过 Qwen3-8B（慢 2-3 倍）、Step-3.5-Flash（token 全烧在思考上，
 *     14 秒返回空）、GLM-5.3-Flash（一直限流），都不如它。
 *
 *   deepseek-ai/DeepSeek-V4.1-Flash   约 2s                  80 条才调一次
 *     沉降总结。这是唯一值得上大模型的地方：一次要压几十条，
 *     压坏了整段记忆就废了。实测它 3 条摘要塞下的信息量最多
 *     （nnUNet、37 个坏样本、12 例标反、200 例 CT 全保住了），
 *     而小模型只挑出三条带数字的，把决策和原则全丢了。
 *     Qwen3.5-27B 质量略低还慢 4 倍，不用。
 *
 * 成本量级：embedding 和 rerank 免费；分类一次约 120 token；
 * 总结一次约 450 token。按一天几十条记忆算，一天几分钱。
 *
 * 没配 key 或调用失败时，全部返回 null，调用方自己退回本地规则。
 * 记忆系统的骨架不能依赖外网。
 */

const DEFAULT_BASE = 'https://api.siliconflow.cn/v1'

import { readFileSync } from 'node:fs'

const DEFAULTS = {
  apiKey: '',
  base: DEFAULT_BASE,
  // 默认就是硅基流动上那两个免费的：中文够用，换 embed 记得跑一次 reindex
  embedModel: 'BAAI/bge-m3',
  rerankModel: 'BAAI/bge-reranker-v2-m3',
  chatModel: 'inclusionAI/Ling-mini-2.0',            // 高频轻任务
  summaryModel: 'deepseek-ai/DeepSeek-V4.1-Flash',    // 低频重任务
  timeoutMs: 20000,
  summaryTimeoutMs: 90000,                            // 总结要读几十条，给足时间
  retries: 2,                                         // 普通失败重试次数
  maxConcurrent: 6,                                   // ★ 全局并发上限
  rateLimitRetries: 5,                                // 429 单独给更多机会
  rateLimitBaseMs: 900,                               // 429 退避基数（指数增长）
  onUsage: null,          // (kind, tokens, model) => void，用来记账
  budgetTokens: 0,        // ★ 本次进程的 token 预算上限，0 = 不限。
                          //   用完就抛 BudgetExceededError，调用方降级到本地规则继续跑。
                          //   这是"最多花多少就停"那道闸，防止手滑重跑把余额烧光。
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 预算用完。
 *
 * ★ 为什么单独一个错误类型：它**不该被重试**。
 *   普通失败（网络抖、5xx）重试有意义，预算用完了重试一万次也是失败。
 *   调用方 catch 住它之后应该直接降级到本地规则，而不是当成"这次没成功"。
 */
export class BudgetExceededError extends Error {
  constructor(used, limit) {
    super(`token 预算用完：已用 ${used} / 上限 ${limit}`)
    this.name = 'BudgetExceededError'
    this.code = 'BUDGET_EXCEEDED'
    this.used = used
    this.limit = limit
  }
}

// ──────────────────────────────────────────────────────────────
// 全局并发闸
//
// 压测 1800 条时会同时有几十个请求在飞（批量分类 20 条一次、
// 摘要 3 个 channel 并发），不限流必然撞 429。
// 撞了以后的退避如果只是固定等待，会越撞越多——所以：
//   ① 先限并发，从源头压住
//   ② 真撞了 429 就指数退避，且不消耗普通重试次数
//      （429 是"你太快了"，不是"你错了"，多给几次机会是合理的）
// ──────────────────────────────────────────────────────────────
let inflight = 0
const gateWaiters = []

function gateAcquire(max) {
  if (inflight < max) {
    inflight++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    gateWaiters.push(() => { inflight++; resolve() })
  })
}

function gateRelease() {
  inflight--
  const next = gateWaiters.shift()
  if (next) next()
}

/**
 * POST，带超时、并发限制、分层重试
 *
 * 三类失败分开处理，不能一锅端：
 *   网络/超时    → 等一会儿重试（可能只是抖了）
 *   429          → 指数退避，多给几次（说明并发太高，不是请求有问题）
 *   其他 4xx     → 直接失败（重试也没用，别浪费配额）
 */
async function post(url, key, body, timeoutMs, retries, maxConcurrent = 6, rlRetries = 5, rlBase = 900, guard = null) {
  await gateAcquire(maxConcurrent)
  try {
    let netAttempt = 0      // 网络错误次数
    let rlAttempt = 0       // 429 次数（单独计数，不吃普通重试额度）
    let lastErr = null

    while (true) {
      // ★ 预算检查放在这里：每发一次请求前都问一遍。
      //   放在 fetch 之后检查没用——钱已经花了。
      //   guard 抛错直接冒泡出去，不进重试（重试也是白花）。
      if (guard) guard()

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)

      let r
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
      } catch (e) {
        clearTimeout(timer)
        lastErr = e
        if (++netAttempt > retries) break
        await sleep(300 * netAttempt)
        continue
      }
      clearTimeout(timer)

      if (!r.ok) {
        const text = await r.text().catch(() => '')

        // ① 429：并发太高，不是请求有问题。指数退避，多给几次机会
        if (r.status === 429 && rlAttempt < rlRetries) {
          rlAttempt++
          lastErr = new Error('HTTP 429 限流')
          await sleep(rlBase * rlAttempt * (1 + Math.random()))
          continue
        }

        // ② 5xx：服务端抽风，短退避重试
        if (r.status >= 500 && netAttempt < retries) {
          netAttempt++
          lastErr = new Error(`HTTP ${r.status}`)
          await sleep(500 * netAttempt)
          continue
        }

        // ③ 其他 4xx：重试没用，直接失败，别浪费配额
        throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`)
      }

      return await r.json()
    }

    throw lastErr || new Error('请求失败')
  } finally {
    gateRelease()
  }
}

/** 从模型回复里抠出 JSON。小模型偶尔会包代码块或加前缀，不能直接 parse */
function parseJson(text) {
  const s = String(text || '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : s
  const start = body.search(/[[{]/)
  if (start === -1) return null
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  if (end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

const cos = (a, b) => {
  let s = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return s / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// ---------- 提示词：都是按实测结果定下来的 ----------

const CLASSIFY_SYS = [
  '你给一条记忆打两个标签，输出一行 JSON。',
  '',
  'channel 三选一：',
  '  action = 自己动手做了一件具体的事。跑通了、删掉 37 条、补完标注、部署了。',
  '  dialog = 说了一段话，重点在话本身。他说他最怕漏诊、我吐槽像年糕、聊到爬山。',
  '  event  = 外面发生的事，不是自己主动做的。刷到一条视频、看到有人吵架、路上被撞、群里出事。',
  '  分不清 action 和 event 时：自己动手 = action，外面发生的 = event。都不像就选 dialog。',
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
  '记忆：主人说他最怕漏诊，宁可多报几个  → {"importance":0.85,"channel":"dialog"}',
  '记忆：把后处理加了连通域过滤，Dice 涨了 0.02  → {"importance":0.6,"channel":"action"}',
  '记忆：下午补完了 64 例标注  → {"importance":0.6,"channel":"action"}',
  '记忆：刷抖音刷到一个讲肺结节的，说得挺在理  → {"importance":0.6,"channel":"event"}',
  '记忆：在抖音跟人吵了一架，吵的啥记不清了  → {"importance":0.6,"channel":"event"}',
  '记忆：群里聊到爬山，我说看天气  → {"importance":0.25,"channel":"dialog"}',
  '记忆：今天有点困  → {"importance":0.25,"channel":"dialog"}',
  '',
  '只输出 JSON，不要解释。',
].join('\n')

/**
 * 批量分类的提示词
 *
 * 单条分类每条一次往返（约 0.5s）。补录历史或批量导入时 40 条就是 20 秒纯等待。
 * 一次问 20 条，往返次数降 20 倍，token 也省（系统提示只算一次）。
 *
 * 为什么要求输出编号：模型偶尔会漏条或乱序，靠编号对齐比靠顺序可靠。
 */
const CLASSIFY_BATCH_SYS = [
  '你给一批记忆各打两个标签，输出一个 JSON 数组。',
  '',
  'channel 三选一：',
  '  action = 自己动手做了一件具体的事。跑通、删掉 37 条、补完标注、部署。',
  '  dialog = 说了一段话，重点在话本身。他说他最怕漏诊、我吐槽像年糕、聊到爬山。',
  '  event  = 外面发生的事，不是自己主动做的。刷到视频、看到吵架、路上被撞。',
  '  分不清 action 和 event 时：自己动手 = action，外面发生的 = event。都不像就选 dialog。',
  '',
  'importance 三档：0.85 定原则或长期诉求；0.6 有结果的具体事件；0.25 闲聊琐事。',
  '',
  '★ 比例很重要：一批里绝大多数应该是 0.6 或 0.25，0.85 通常只有一两条。',
  '  0.85 只给「以后都这样做」的规则、禁令、长期偏好。',
  '  不确定时给 0.6，不要给 0.85。',
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
  '    3. 刷抖音刷到一个讲肺结节的  → {"i":3,"importance":0.6,"channel":"event"}',
  '    4. 今天有点困  → {"i":4,"importance":0.25,"channel":"dialog"}',
  '',
  '只输出 JSON 数组，不要解释。',
].join('\n')

/**
 * 本地前置规则：模型判反的几个典型，用规则兜住。
 *
 * 实测「今天有点困，喝了两杯咖啡」被模型判成 0.6 action —— 它把"喝咖啡"
 * 当成一个动作了。这类当下状态、身体感受，规则比模型稳。
 */
const LOW_PATTERNS = /^(今天|现在|刚刚)?[^，。]{0,8}(困|累|饿|渴|冷|热|无聊|头疼|失眠|睡不够)/
const HIGH_PATTERNS = /(以后|从今|一律|永远|不许|不准|不要|必须|只能|记住|原则|标准是|我说了算)/

/**
 * 「做了事 + 有数字结果」→ importance 至少 0.6
 *
 * 实测模型会把这类判成 0.25：
 *   「清了一轮空标注，删掉 37 个坏样本」→ 0.25（该是 0.6）
 *   「补完了 128 例标注，抽查了 15 例」→ 0.25（该是 0.6）
 * 它看到「清理」「补」这种日常动词就当琐事了，忽略了紧跟的数字结果。
 *
 * 这里只做**下限保护**（只抬不降），所以即使误判也不会把重要事压低。
 * 匹配要求「动作 + 近距离的数字或倍数词」，避免把「等了二十分钟」这种闲聊抬上来。
 */
/**
 * 解析「1,3,5」「1-5」「1—5」这几种写法，返回去重后的合法下标（1 起）。
 * 越界的一律丢掉——模型编出 99 号是常事，不能让它把路由带跑偏。
 */
function parseIndexList(raw, n) {
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

const RESULT_PATTERNS = /(跑通|改完|部署|提交|补完|删掉|清理|扩容|优化|压到|涨到|降到|过了|做完|写完|跑完|推进|上线)[^。，；]{0,24}?(\d|一半|翻倍|四成|三成|两倍)/

export function createSilicon(options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  // models 段允许每个阶段单独覆盖 { base, apiKey, model }，留空则继承顶层的 base/apiKey
  if (!cfg.models || typeof cfg.models !== 'object') cfg.models = {}

  const STAGES = ['embed', 'rerank', 'chat', 'summary']

  /**
   * 解析某个阶段的最终连接参数。
   * 优先级：models[stage].xxx > 顶层 cfg.xxx > 该阶段的默认模型名。
   * 这样既能"全部走硅基流动"，也能"摘要单独挂 DeepSeek 官方、向量走本地服务"。
   */
  function stage(name) {
    const over = cfg.models[name] || {}
    const base = String(over.base || cfg.base || '').replace(/\/+$/, '')
    const apiKey = over.apiKey || cfg.apiKey || ''
    const model = over.model || cfg[name + 'Model'] || ''
    // source: 'session' = 走 dsh 当前会话模型（不用我们的 key）；'api' = 走 HTTP
    const source = sessionStages.has(name) ? 'session' : 'api'
    return {
      base,
      apiKey,
      model,
      source,
      sessionModel: source === 'session' ? (session?.model || null) : null,
      chat: base + '/chat/completions',
      embed: base + '/embeddings',
      rerank: base + '/rerank',
    }
  }

  // 只要任意一个阶段拿到了 key 就能跑；全部为空才认为没配（由调用方降级到关键词检索）
  const anyKey = cfg.apiKey || STAGES.some((s) => cfg.models?.[s]?.apiKey)

  // 会话模型通道：这些阶段的请求改走 dsh 当前会话模型，不用我们的 key。
  //   传法：{ session: { call, stages: ['chat','summary'] } }
  //   没传、或调用失败，都安静回落 HTTP。
  const session = options.session && typeof options.session.call === 'function' ? options.session : null
  const sessionStages = new Set(Array.isArray(session?.stages) ? session.stages : [])
  const log = typeof options.onFallback === 'function' ? options.onFallback : null

  if (!anyKey && !session) throw new Error('[silicon] 缺少 apiKey（顶层或某个阶段的 models[s].apiKey），且没有会话模型通道')

  const chatUrl = `${cfg.base.replace(/\/+$/, '')}/chat/completions`
  const embedUrl = `${cfg.base.replace(/\/+$/, '')}/embeddings`
  const rerankUrl = `${cfg.base.replace(/\/+$/, '')}/rerank`

  // ============================================================
  // 用量账本 + 预算闸
  //
  // ★ token 限制该放哪？三个层次，别混：
  //
  //   ① 单次调用 max_tokens      —— 防单次跑飞。已经写在各能力里
  //                                 （summary 450 / classify 200 / relation 50）。
  //                                 这一层管"一次最多吐多少"。
  //   ② 本进程累计预算 budgetTokens —— 防"越跑越花"。这里实现的就是它。
  //                                 这一层管"这次跑了多少就停"，跟单次多少无关。
  //   ③ 账户余额                  —— 最后一道，撞上了是 402/403，属于事故。
  //
  // ★ 坚决**不要**用「输出 token ≤ 输入 token」当闸门。
  //   摘要本来就该输出多于输入：它要把 DL3 摘要 + 引用关系 + 层次的去向一起吐出来，
  //   输入是一堆原文，输出是三份结构化结果，倒挂是正常的。
  //   拿这个当异常信号，只会把正常行为判成 bug——我昨天就差点犯这个错。
  // ============================================================
  const budget = {
    limit: Number(cfg.budgetTokens) || 0,   // 0 = 不限
    used: 0,
    calls: 0,
    byKind: {},
    byModel: {},
    exhausted: false,
  }

  const guard = () => {
    if (budget.limit > 0 && budget.used >= budget.limit) {
      budget.exhausted = true
      throw new BudgetExceededError(budget.used, budget.limit)
    }
  }

  const note = (kind, tokens, model) => {
    const t = Number(tokens) || 0
    budget.used += t
    budget.calls++
    const k = kind || 'unknown'
    budget.byKind[k] = budget.byKind[k] || { calls: 0, tokens: 0 }
    budget.byKind[k].calls++
    budget.byKind[k].tokens += t
    const m = model || '(embed)'
    budget.byModel[m] = budget.byModel[m] || { calls: 0, tokens: 0 }
    budget.byModel[m].calls++
    budget.byModel[m].tokens += t

    if (typeof cfg.onUsage === 'function') {
      try { cfg.onUsage(kind, t, model) } catch { /* 记账失败不影响主流程 */ }
    }
  }

  /** 当前用量快照。跑完打这个，比翻账单快。 */
  const usage = () => ({
    ...budget,
    byKind: Object.fromEntries(Object.entries(budget.byKind).map(([k, v]) => [k, { ...v }])),
    byModel: Object.fromEntries(Object.entries(budget.byModel).map(([k, v]) => [k, { ...v }])),
    remaining: budget.limit > 0 ? Math.max(0, budget.limit - budget.used) : Infinity,
  })

  const resetUsage = () => {
    budget.used = 0
    budget.calls = 0
    budget.byKind = {}
    budget.byModel = {}
    budget.exhausted = false
    budget.limit = Number(cfg.budgetTokens) || 0
  }

  /**
   * 通用对话调用。
   *
   * 小模型必须显式关思考——实测开着的模型会把 token 全烧在 reasoning 上，
   * max_tokens 一到就直接返回空字符串。大模型那边则不传这个参数
   * （DeepSeek V4 系列自带少量思考，传了反而可能报错）。
   */
  async function chat(system, user, opts = {}) {
    const {
      maxTokens = 400,
      temperature = 0,
      stage: stageName = 'chat',
      model,
      timeout = cfg.timeoutMs,
      thinking,
    } = opts

    const st = stage(stageName)
    const useModel = model || st.model

    // 关思考：调用方没明说时按 cfg.noThink[stage]，默认 chat 关（判关系只要一个词）、
    // summary 默认不关（要它想清楚再压）。
    const noThink = thinking === undefined ? cfg.noThink?.[stageName] !== false : thinking === false

    // ★ 该阶段配置成"走会话模型"时，改用 dsh 自己的模型通道（不用我们的 key）。
    //   失败（没拿到服务 / 流式报错 / 空输出）一律安静回落 HTTP，不影响主流程。
    if (session?.call && sessionStages.has(stageName)) {
      try {
        const out = await session.call({
          system,
          user,
          maxTokens,
          temperature,
          disableThinking: noThink,
          timeoutMs: timeout,
        })
        const text = (typeof out === 'string' ? out : out?.text || '').trim()
        if (text) {
          note(stageName, 0, `session:${out?.model || useModel}`)
          return text
        }
        log?.('会话模型返回空，回落 HTTP：%s', stageName)
      } catch (err) {
        log?.('会话模型调用失败，回落 HTTP（%s）：%s', stageName, err?.message ?? err)
      }
    }

    const body = {
      model: useModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
      temperature,
    }
    if (noThink) body.enable_thinking = false

    // ★ 用该阶段自己的 url / key：摘要可以挂到另一家 provider 上
    const d = await post(st.chat, st.apiKey, body, timeout, cfg.retries, cfg.maxConcurrent, cfg.rateLimitRetries, cfg.rateLimitBaseMs, guard)
    note(stageName, d.usage?.total_tokens, useModel)
    return (d.choices?.[0]?.message?.content || '').trim()
  }

  // ---------- 对外能力 ----------

  /** 批量向量。失败返回 null，调用方退回关键词 */
  async function embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '').trim()).filter(Boolean)
    if (!list.length) return null
    try {
      const es = stage('embed')
      const d = await post(es.embed, es.apiKey, { model: es.model, input: list }, cfg.timeoutMs, cfg.retries, cfg.maxConcurrent, cfg.rateLimitRetries, cfg.rateLimitBaseMs, guard)
      note('embed', d.usage?.total_tokens || d.meta?.tokens?.input_tokens)
      const vecs = (d.data || []).map((x) => x.embedding)
      return vecs.length === list.length ? vecs : null
    } catch {
      return null
    }
  }

  /** 精排。返回 [{index, score}]，顺序即排名 */
  async function rerank(query, docs, topN = 0) {
    const list = (docs || []).map((t) => String(t || ''))
    if (!list.length) return null
    try {
      const rs = stage('rerank')
      const body = { model: rs.model, query: String(query || ''), documents: list }
      if (topN > 0) body.top_n = Math.min(topN, list.length)
      const d = await post(rs.rerank, rs.apiKey, body, cfg.timeoutMs, cfg.retries, cfg.maxConcurrent, cfg.rateLimitRetries, cfg.rateLimitBaseMs, guard)
      note('rerank', d.meta?.tokens?.input_tokens)
      return (d.results || []).map((x) => ({ index: x.index, score: Number(x.relevance_score) }))
    } catch {
      return null
    }
  }

  /**
   * 摘要。这是唯一走大模型的地方——低频，但一次要压几十条，
   * 压坏了整段记忆就废了，省这几百 token 没意义。
   *
   * 传进来的一定是同一 channel 的，所以提示词按 channel 换重点。
   * 这一点很关键：混着压的话，原则性的话（"评估以召回率为准"）
   * 会被"做了什么、结果如何"的要求挤掉——实测三个模型全漏了这条。
   */
  async function summarize(texts, hint = '', channel = 'dialog', people = []) {
    const list = (texts || []).map((t) => String(t || '').trim()).filter(Boolean)
    if (!list.length) return null

    const focus = channel === 'action'
      ? '重点：做了什么、结果如何、数字变化。'
      : channel === 'event'
        // 事件的记忆特点：记得"发生过"，细节本来就模糊。
        // 所以这里明确允许粗，但不允许丢"发生了什么事"这个骨架。
        ? '重点：发生了什么、在哪、大概经过。细节可以模糊，但"发生过这件事"这个骨架必须留住。'
        : channel === 'dialog'
          ? '重点：谁说了什么、定了什么、聊到哪了。特别注意对方表达的原则和长期诉求，这类一定要留下。'
          : '重点：发生了什么、得出什么结论。'

    const folks = (Array.isArray(people) ? people : []).filter(Boolean)

    // ★ 单次压多少条。
    //
    //   原来是 15 条一块，理由是怕撞 maxTokens 被截断。但那是**推理没关**的时候：
    //   模型先写一大段思考再写摘要，700 token 全花在思考上，摘要被砍断。
    //   推理关掉之后，15 条输入的输出只有 28 token（实测，恒定），
    //   分块就纯属浪费——每块都要一次往返、一次 system 提示词、一次上下文。
    //
    //   用户的原话：「摘要是大模型处理的，大批量来问题不大，反而可能比多次更省 token」。
    //   对。大模型按输入线性计费，但**每次调用的固定开销（system 提示词 + 指令）
    //   是要重复付的**。60 条一次 = 1 份开销；60 条分 4 次 = 4 份开销。
    //
    //   现在的上限改成 cfg.summaryChunk（默认 60），maxTokens 按条数动态给，
    //   不再写死 450。
    const CHUNK = Number(cfg.summaryChunk) || 60
    if (list.length > CHUNK) {
      const parts = []
      for (let i = 0; i < list.length; i += CHUNK) {
        const sub = await summarize(list.slice(i, i + CHUNK), hint, channel, people)
        if (sub) parts.push(sub)
      }
      // 各块结果直接拼，不再多调一次模型（那等于压第二遍，又贵又容易丢细节）
      return parts.length ? parts.join('\n') : null
    }

    const sys = '你把几条记忆压成摘要。只输出摘要正文，不要解释、不要标题、不要前后缀。'
    const user = [
      hint ? `要求：${hint}` : '',
      focus,
      '保留人名和具体数字。不许写原文里没有的事。',
      // 这条是防"一堆话不知道谁说的"的关键：
      // 摘要最怕把"张三说要爬山"压成"聊了爬山"，那这条记忆就废了
      folks.length
        ? `这批里出现过的人：${folks.join('、')}。摘要里写到具体的事，必须带上是谁说的/谁做的，这些人名不许丢。`
        : '原文里如果有人名，摘要里也要留着。',
      '压成 1-3 行，每行一条，以「·」开头，每条不超过 40 字。',
      '宁可少写一条，也不要把两件不相干的事挤成一句。',
      '',
      '原文：',
      ...list.map((t) => `- ${t}`),
    ].filter(Boolean).join('\n')

    try {
      const out = await chat(sys, user, {
        // 输出上限按输入条数给：每 10 条大约 1 行摘要（40 字 ≈ 30 token），
        // 再留 250 给"多写一行"的余量。上限 4000 是模型的安全区。
        maxTokens: Math.min(250 + 10 * list.length, 4000),
        temperature: 0.2,
        stage: 'summary',
        timeout: cfg.summaryTimeoutMs,
        // ★ 必须显式关掉推理。
        //   这里原来传的是 null，而 chat() 里只处理 `thinking === false`，
        //   null !== false 所以根本没往请求里塞 enable_thinking:false——
        //   等于让 DeepSeek 按默认走（开推理）。
        //   结果：每次摘要先输出一大段思考过程，写到 maxTokens 700 被截断，
        //   真正有用的摘要只有几十字。
        //   账单上表现为「输出 295K token 是输入 122K 的 2.4 倍」，
        //   2.36 元里绝大部分烧在这些被截断的思考上。
        thinking: false,
      })
      const body = out.replace(/^```[\s\S]*?```$/g, '').trim()
      return body || null
    } catch {
      return null
    }
  }

  /**
   * 摘要 + 出处：一次调用同时做两件事。
   *
   * ★ 为什么加这个：用户提的「摘要是根据哪些东西来的，把用到的资料放入 DL2，
   *   剩下的放回 DL1」。这句话让路由不再需要"重要度"这个数值。
   *
   *   原来的链路是两段：
   *     ① classifyBatch 40 条 → 判 0.85 / 0.6 / 0.3 三个数
   *     ② 按数字分三路 → 重要的再去摘要
   *   问题是模型给数字很不稳（实测本地规则 40 条全被改判，模型自己也不稳）。
   *
   *   现在合成一段：
   *     一次调用 → 摘要（带编号）→ 被引用的进 DL2，没被引用的进 DL1
   *
   *   模型不需要判断"这条多重要"，只需要回答"我这条摘要从哪几条来"——
   *   这是它擅长的（就是阅读理解 + 引用），也不用编数字。
   *
   * @return {{summaries:Array<{text:string, sources:number[]}>, keep:number[]}|null}
   *         sources / keep 都是 1 起的下标
   */
  async function summarizeWithSources(texts, channel = 'dialog', people = [], hint = '') {
    const list = (texts || []).map((t) => String(t || '').trim()).filter(Boolean)
    if (!list.length) return null

    const focus = channel === 'action'
      ? '重点：做了什么、结果如何、数字变化。'
      : channel === 'event'
        ? '重点：发生了什么、在哪、大概经过。细节可以模糊，但"发生过这件事"这个骨架必须留住。'
        : channel === 'dialog'
          ? '重点：谁说了什么、定了什么、聊到哪了。特别注意对方表达的原则和长期诉求，这类一定要留下。'
          : '重点：发生了什么、得出什么结论。'

    const folks = (Array.isArray(people) ? people : []).filter(Boolean)
    const CHUNK = Number(cfg.summaryChunk) || 60

    // 摘要条数上限：大约 5 条原文压成 1 条。40 条 → 8 条摘要。
    // 这个比例决定"有多少原文能进 DL2"——比例太松（一比一）等于没压缩。
    // 摘要条数上限：大约 10 条原文压成 1 条（2026-10-31 收紧，原 n/5）。
    //
    // ★ 用户明确：「L1 其实重点不在摘要，只有在特别重要的事或场景下才写摘要进 DL3，
    //   其余大部分其实进 L2 和 DL1。」所以 DL3 是稀有的长期记忆，不是每批都灌。
    //   n/5 太松（40 条出 8 条全进 DL3），n/10 才符合"大部分只当原文沉下去"。
    const maxLines = Math.max(2, Math.ceil(list.length / 10))

    // 超过一块就切，结果下标要加回偏移量
    if (list.length > CHUNK) {
      const summaries = []
      const keep = []
      for (let i = 0; i < list.length; i += CHUNK) {
        const sub = await summarizeWithSources(list.slice(i, i + CHUNK), channel, people, hint)
        if (!sub) continue
        for (const x of sub.summaries) {
          summaries.push({ text: x.text, sources: x.sources.map((k) => k + i), importance: x.importance })
        }
        for (const k of sub.keep) keep.push(k + i)
      }
      return summaries.length || keep.length ? { summaries, keep, maxLines: null } : null
    }

    const sys = '你把几条记忆压成摘要，并给每条摘要标明依据了哪几条原文。'
    const user = [
      hint ? `要求：${hint}` : '',
      focus,
      '保留人名和具体数字。不许写原文里没有的事。',
      folks.length
        ? `这批里出现过的人：${folks.join('、')}。摘要里写到具体的事，必须带上是谁说的/谁做的。`
        : '原文里如果有人名，摘要里也要留着。',
      '',
      // ★ 条数上限是"刹车"，不是"指标"。
      //
      //   不给上限：模型会一条原文配一条摘要（实测 33 条 → 32 条摘要），等于没压缩。
      //   给死上限：模型会为了凑数把不相干的事缝成一行（实测
      //     「周末爬山 + 地铁故障 + 鸡蛋涨价」被压成一句），这是质量事故。
      //
      //   所以两头都要说清楚：条数**最多** M 条，但**少写没关系**，
      //   而且"一条摘要只讲一件事"优先于"填满 M 条"。
      `这一批共 ${list.length} 条，最多写 ${maxLines} 条摘要——这是上限，不是任务量，写得比它少完全可以。`,
      `超过 ${maxLines} 条的摘要会被直接丢弃（白写），请务必合并。`,
      '一条摘要只讲一件事。两件不相干的事，**宁可各自不写，也绝不能挤进同一行**。',
      '同一件事的几句话合成一条，只写结论，不要把每句都复述一遍。',
      '单独拎出来没什么信息量的（打招呼、附和、嗯哦啊），不要为它写摘要。',
      '**大部分内容不该写摘要**——它们会作为原文沉到缓冲层或流水账，这是设计好的。',
      '只有真正值得长期记住的才写摘要。',
      '',
      '输出格式——每条摘要一行，行首用符号标重要性：',
      '',
      '★ 摘要正文（不超过40字）《1,3,5》',
      '· 摘要正文（不超过40字）《4》',
      '+ 2,7',
      '',
      '三个符号的区别：',
      '  ★ 特别重要 —— 原则、命令、长期承诺、关键结果、"以后一律…"。必须长期记住。',
      '  · 一般重要 —— 有信息量的日常，记着有好处，但不强制。',
      '  + 不用写摘要 —— 有信息量、值得留着以后查的（约定、数字、人名、时间地点）。',
      '',
      '★ 应该是少数，大部分值得写摘要的用 · 就行。',
      '**+ 也是少数（约二三成）**：只有真有信息量的才标，进了缓冲层比流水账留得久。',
      '打招呼、语气词、闲聊碎语、当下状态这些不重要的**不要标 +**，它们落进流水账、',
      '很快忘掉是正常的，别什么都往缓冲层塞。',
      '《》里填这条摘要依据了原文的哪几个编号，逗号分隔，连续的可以写成 1-3。',
      '一条摘要引用的编号，必须是在说同一件事。**编号之间毫无关系，就说明你在硬凑。**',
      '编号必须是上面真实存在的数字，不许编。',
      '没被这些行用到的条目就让它闲着——它们会被降级处理，这是设计好的。',
      '没有值得 + 的条目就不写 + 那行。不要为了凑数乱标。',
      '',
      '原文：',
      ...list.map((t, i) => `${i + 1}. ${t}`),
    ].filter(Boolean).join('\n')

    try {
      const out = await chat(sys, user, {
        maxTokens: Math.min(300 + 12 * list.length, 4000),
        temperature: 0.2,
        stage: 'summary',
        timeout: cfg.summaryTimeoutMs,
        thinking: false,
      })
      const res = []
      const keep = []
      for (const raw of out.split('\n')) {
        let line = raw.trim()
        if (!line) continue

        // ★ 「+ 12,15」这一行 = 不用写摘要、但值得留着以后查的条目 → L2
        const plus = line.match(/^[+＋]\s*([\d,，、\s\-—~～]+)$/)
        if (plus) {
          for (const k of parseIndexList(plus[1], list.length)) keep.push(k)
          continue
        }

        // ★ 行首符号决定重要性档位（2026-10-31）：
        //   ★ 特别重要 → 0.9（原则、命令、长期承诺、关键结果）
        //   · 一般重要 → 0.7（有信息量的日常）
        //   琐事不写摘要，靠「没被引用」自动落到 L2/DL1。
        let imp = 0.7
        if (/^[★☆]/.test(line)) imp = 0.9
        line = line.replace(/^[★☆·•\-*＋+]\s*/, '')
        if (!line) continue

        const m = line.match(/^(.*?)[《<【(（]\s*([\d,，、\s\-—~～]+)\s*[》>】)）]\s*$/)
        if (!m) {
          // 没带出处的行也留着，但 sources 为空——交给调用方决定（通常是丢掉）
          const plain = line.replace(/[《》]/g, '').trim()
          if (plain) res.push({ text: plain, sources: [], importance: imp })
          continue
        }
        const text = m[1].trim()
        if (!text) continue
        res.push({ text, sources: parseIndexList(m[2], list.length), importance: imp })
      }
      return res.length || keep.length ? { summaries: res, keep, maxLines } : null
    } catch {
      return null
    }
  }

  /** 分类：返回 {importance, channel}，失败返回 null */
  async function classify(text) {
    const body = String(text || '').trim()
    if (!body) return null

    // 先过本地规则：模型判反的典型，规则更稳也更省
    if (LOW_PATTERNS.test(body) && !HIGH_PATTERNS.test(body)) {
      return { importance: 0.25, channel: /跑通|完成|删|改|部署|提交/.test(body) ? 'action' : 'dialog', by: 'rule' }
    }

    try {
      const out = await chat(CLASSIFY_SYS, `记忆：${body}`, { maxTokens: 300 })
      const j = parseJson(out)
      if (!j) return null
      let importance = Number(j.importance)
      let channel = j.channel
      if (!Number.isFinite(importance)) return null
      if (!['dialog', 'action', 'event'].includes(channel)) channel = 'dialog'

      // 模型给的值可能不在三档里，归到最近的档
      importance = [0.85, 0.6, 0.25].reduce((a, b) => (Math.abs(b - importance) < Math.abs(a - importance) ? b : a))

      // 有数字结果的具体事件，至少 0.6——模型经常把这类判成 0.25
      if (RESULT_PATTERNS.test(body) && importance < 0.6) importance = 0.6

      // 明确的长期诉求，抬高到原则档——模型经常低估这类
      if (HIGH_PATTERNS.test(body) && importance < 0.85) importance = 0.85

      return { importance, channel, by: 'model' }
    } catch {
      return null
    }
  }

  /**
   * 批量分类
   *
   * 返回数组，跟输入一一对应。**失败的位置是 null**——
   * 让上层落到本地规则，而不是给个假值污染数据。
   *
   * 三件事按顺序做：
   *   ① 本地规则先过一遍（「今天有点困」这种模型老判错的），不浪费模型调用
   *   ② 剩下的按 chunk 分组问模型，每组一次往返
   *   ③ 用返回的 i 对齐（模型偶尔漏条或乱序，靠顺序不可靠）
   */
  async function classifyBatch(texts, { chunk = 20 } = {}) {
    const list = (texts || []).map((t) => String(t || '').trim())
    const out = new Array(list.length).fill(null)

    // ① 本地规则先过
    const need = []
    for (let i = 0; i < list.length; i++) {
      const b = list[i]
      if (!b) continue
      if (LOW_PATTERNS.test(b) && !HIGH_PATTERNS.test(b)) {
        out[i] = {
          importance: 0.25,
          channel: /跑通|完成|删|改|部署|提交/.test(b) ? 'action' : 'dialog',
          by: 'rule',
        }
      } else {
        need.push(i)
      }
    }
    if (!need.length) return out

    // ② 分组问模型
    for (let start = 0; start < need.length; start += chunk) {
      const idx = need.slice(start, start + chunk)
      const payload = idx.map((i, k) => `${k + 1}. ${list[i]}`).join('\n')

      try {
        const raw = await chat(CLASSIFY_BATCH_SYS, payload, {
          // 每条约 40 个 token 的输出，留点余量
          maxTokens: 200 + idx.length * 60,
        })
        const arr = parseJson(raw)
        if (!Array.isArray(arr)) continue      // 这一组失败，保持 null

        for (let k = 0; k < idx.length; k++) {
          const i = idx[k]
          // 优先按 i 对齐，没有 i 就按位置
          const item = arr.find((x) => Number(x?.i) === k + 1) || arr[k]
          if (!item) continue

          let importance = Number(item.importance)
          if (!Number.isFinite(importance)) continue
          let channel = item.channel
          if (!['dialog', 'action', 'event'].includes(channel)) channel = 'dialog'

          // 归到三档
          importance = [0.85, 0.6, 0.25].reduce(
            (a, b) => (Math.abs(b - importance) < Math.abs(a - importance) ? b : a)
          )
          // 有数字结果的具体事件，至少 0.6
          if (RESULT_PATTERNS.test(list[i]) && importance < 0.6) importance = 0.6

          // 明确的长期诉求，抬高到原则档——模型经常低估这类
          if (HIGH_PATTERNS.test(list[i]) && importance < 0.85) importance = 0.85

          out[i] = { importance, channel, by: 'model' }
        }
      } catch {
        // 这一组挂了就留 null，上层用本地规则兜底
      }
    }

    return out
  }

  /** 判重：两条是不是同一件事 */
  async function sameEvent(a, b) {
    try {
      const out = await chat('你判断两条记忆是不是在说同一件事。只输出 yes 或 no。',
        `A：${a}\nB：${b}\n\n是同一件事吗？`, { maxTokens: 20 })
      return /^yes/i.test(out.trim())
    } catch {
      return null
    }
  }

  /**
   * 判两条记忆的关系
   *
   * 为什么不能只用 yes/no 的 sameEvent：
   *   「别发表情」和「多发表情」确实是"同一件事"，但处置方式完全相反——
   *   前者要合并，后者要标记取代。只判"是不是同一件事"分不开这两种。
   *
   * 三类关系要分清，否则会误伤：
   *   update 最容易错判成 contradiction——「Dice 0.86」到「Dice 涨到 0.88」
   *   不是自相矛盾，是事情在推进。按矛盾处理会把进展史删掉。
   *
   * 返回 'duplicate' | 'contradiction' | 'update' | 'unrelated'，失败返回 null。
   */
  async function relation(a, b) {
    const sys = [
      '你判断两条记忆的关系，只输出一个词。',
      '',
      'duplicate      同一件事，只是措辞不同。「别发表情」和「不要发表情包」',
      'contradiction  后一条推翻了前一条。「别发表情」和「多发表情」',
      'update         后一条是前一条的进展或补充，不冲突。',
      '               「Dice 0.86」和「Dice 涨到 0.88」不是矛盾，是进展。',
      '               「补了 64 例标注」和「补到 128 例」也是进展。',
      'unrelated      两件不同的事。',
      '',
      '只输出这四个词之一，不要解释。',
    ].join('\n')

    try {
      const out = await chat(sys, `A：${a}\nB：${b}`, { maxTokens: 10 })
      const w = String(out || '').trim().toLowerCase()
      for (const k of ['contradiction', 'duplicate', 'update', 'unrelated']) {
        if (w.includes(k)) return k
      }
      return null
    } catch {
      return null
    }
  }

  /** 连通性自检 */
  async function ping() {
    const t0 = Date.now()
    const v = await embed(['自检'])
    if (!v) return { ok: false, error: 'embedding 调用失败' }
    return {
      ok: true,
      ms: Date.now() - t0,
      dim: v[0].length,
      models: {
        // 显示**实际生效**的值（阶段覆盖已合并），而不是原始配置
        embed: stage('embed').model,
        rerank: stage('rerank').model,
        chat: stage('chat').model,
        summary: stage('summary').model,
      },
      endpoints: {
        embed: stage('embed').base,
        rerank: stage('rerank').base,
        chat: stage('chat').base,
        summary: stage('summary').base,
      },
    }
  }

  return {
    embed, rerank, summarize, summarizeWithSources, classify, classifyBatch, sameEvent, relation, ping, cos,
    config: cfg, usage, resetUsage, budget,
    /** 给设置页/诊断用：某阶段最终解析成什么 */
    resolveStage: (name) => {
      const st = stage(name)
      return {
        base: st.base,
        model: st.model,
        hasKey: !!st.apiKey,
        // 'session' = 走 dsh 当前会话模型（不用我们的 key）；'api' = 走 HTTP
        source: st.source,
        sessionModel: st.sessionModel,
      }
    },
    stages: () => STAGES,
  }
}

/** 从 AstrBot 的 cmd_config.json 里取 siliconflow 的 key，省去手抄 */
export function keyFromAstrbot(configPath) {
  try {
    const raw = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')
    const d = JSON.parse(raw)
    const src = (d.provider_sources || []).find((s) => s?.id === 'siliconflow')
    if (!src) return null
    const k = Array.isArray(src.key) ? src.key[0] : src.key
    return k ? { apiKey: k, base: src.api_base || DEFAULT_BASE } : null
  } catch {
    return null
  }
}
