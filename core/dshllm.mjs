/**
 * 走 dsh 自己的会话模型（不需要额外的 key）
 *
 * 背景：融合判关系、摘要这类"小活"，用户希望直接跟着当前对话用的模型走——
 *   对话用 flash 它就 flash，用 pro 它就 pro，不用再单独配一家 provider。
 *
 * dsh 有两个服务能给到这件事：
 *   ctx.get('llm')                 → prepareCall({provider, model}, signal, configure)
 *                                    官方插件 dsh-session-title-llm 就是这么打辅助请求的
 *   ctx.get('agentDefaultModel')   → currentSelection() 返回 {provider, model, reasoningEffort}
 *
 * 流式返回，chunk 形状（照 dsh-llm 的 BlockAssembler）：
 *   {type:'block-start'} {type:'text-delta', text} {type:'reasoning-delta', text}
 *   {type:'block-end'} {type:'usage', usage} {type:'finish', reason}
 * 我们只收 text-delta，reasoning-delta 一律丢掉（那就是思考过程）。
 *
 * 关思考：没有统一的 enable_thinking 开关。做法是从 modelInfo.reasoning.efforts
 * 里取**最低档**（efforts 是从小到大排的），等价于这个模型能选的"最少思考"。
 */

const DEFAULT_TIMEOUT_MS = 30000

export function createSessionCaller(getCtx, opts = {}) {
  const log = opts.log
  let cached
  let cacheTried = false

  /** 拿到 llm / agentDefaultModel 两个服务；拿不到就记下来不再反复试 */
  function services() {
    if (cached || cacheTried) return cached || null
    cacheTried = true
    try {
      const ctx = typeof getCtx === 'function' ? getCtx() : getCtx
      if (!ctx) return null
      const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : null) ?? ctx.llm
      const dm = (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null) ?? ctx.agentDefaultModel
      if (!llm || typeof llm.prepareCall !== 'function') return null
      cached = { llm, dm }
    } catch (err) {
      log?.warn?.('[memory-tiers] 取 dsh llm 服务失败：%s', err?.message ?? err)
    }
    return cached || null
  }

  /** 当前会话模型：{provider, model, reasoningEffort} 或 null */
  function selection() {
    const s = services()
    if (!s?.dm || typeof s.dm.currentSelection !== 'function') return null
    try {
      const sel = s.dm.currentSelection()
      if (!sel?.provider || !sel?.model) return null
      return sel
    } catch { return null }
  }

  function available() {
    return !!selection()
  }

  /** 关思考用：取模型支持的最低 reasoningEffort */
  function lowestEffort(modelInfo) {
    const efforts = modelInfo?.reasoning?.efforts
    if (Array.isArray(efforts) && efforts.length && efforts[0]?.id) return efforts[0].id
    return undefined
  }

  /**
   * 打一次请求
   * @returns {string} 模型输出的纯文本（已 trim）；失败抛错，由调用方回落
   */
  async function call({
    system = '',
    user = '',
    maxTokens = 400,
    temperature = 0,
    disableThinking = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    const s = services()
    if (!s) throw new Error('拿不到 dsh 的 llm 服务')
    const sel = selection()
    if (!sel) throw new Error('取不到当前会话模型（agentDefaultModel 未就绪）')

    const signal = AbortSignal.timeout(timeoutMs)

    // prepareCall 的第三个参数是 configure(controls, modelInfo)：
    //   只能改 controls（推理强度/温度/上限），不能改路由（provider/model）
    const call = await s.llm.prepareCall(
      { provider: sel.provider, model: sel.model, maxTokens },
      signal,
      (controls, modelInfo) => {
        const next = { ...controls }
        if (temperature !== undefined) next.temperature = temperature
        if (disableThinking) {
          const effort = lowestEffort(modelInfo)
          if (effort !== undefined) next.reasoningEffort = effort
        }
        return next
      },
    )

    // ★ 不能再改 maxTokens / temperature：prepareCall 已经把配置冻住了，
    //   事后改会触发 "prepared LLM call config changed before adapter dispatch"。
    const options = {
      ...call.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(user) }] }],
      system: String(system || ''),
      purpose: 'memory-tiers',
      signal,
    }

    let text = ''
    let finish = null
    for await (const chunk of call.stream(options)) {
      const t = chunk?.type
      if (t === 'text-delta') text += chunk.text ?? ''
      else if (t === 'finish') { finish = chunk.reason; break }
      else if (t === 'error') finish = { kind: 'error', failure: { message: chunk?.message ?? '流式返回错误' } }
      else if (t === 'usage') { /* 不记账：会话模型的用量算在对话账上 */ }
    }

    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      throw new Error(String(finish?.failure?.message ?? finish?.kind ?? '会话模型调用失败'))
    }
    return { text: text.trim(), provider: sel.provider, model: sel.model }
  }

  /** 给设置页看的：能不能用、当前是哪个模型、支持的最低思考档 */
  function info() {
    const sel = selection()
    if (!sel) return { available: false, reason: services() ? 'agentDefaultModel 未就绪' : '未取到 llm 服务' }
    return {
      available: true,
      provider: sel.provider,
      model: sel.model,
      reasoningEffort: sel.reasoningEffort ?? null,
    }
  }

  return { available, selection, call, info }
}
