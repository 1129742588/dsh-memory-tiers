/**
 * dsh 插件适配层 —— 接 memory5（六层记忆）。只干"接线"，不含记忆逻辑。
 *
 * v1（memory.mjs）→ v5（memory5.mjs）的四个接入口：
 *   ① 写：订阅 session/event，turn 结束时把这一轮合成记忆（自动，不靠模型自觉）
 *   ② 读：systemPrompt.section 注入 buildBlock（L3 视图 + L2 + L1）
 *   ③ 查：memory_search / memory_attend 工具（搜到不涨热度，确认才涨）
 *   ④ 维护：定时 flushSummaries（deferred 摘要）+ 周期 sweep
 *
 * 关于自动写入：dsh 的 session 是事件溯源的，每次 append 都会 post-commit 广播
 * `session/event`。一轮对话里会有 user/message、tool/call、tool/result、turn/end。
 * 我们**按 turn 聚合**——中途写会得到「问了还没答」的半截对话，而且写入次数翻倍。
 *
 * 没有 embedding key 时降级为本地哈希向量：语义检索会退化，但链路能跑通、不会崩。
 */

import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMemory5, LAYER, DEFAULTS as MEM_DEFAULTS } from './memory5.mjs'
import { createSilicon, keyFromAstrbot } from './silicon.mjs'
import { compactSurface } from './compaction.mjs'
import { installSettingsApi } from './settings.mjs'

export const name = 'memory-tiers'
export const inject = ['tools']

const PLUGIN_DEFAULTS = {
  dir: '',
  apiKey: '',
  apiBase: 'https://api.siliconflow.cn/v1',
  bootMaxChars: 0,               // 0 = 不限制，注入量由 L1/L2/L3 各自容量决定
  budgetTokens: 0,
  autoCapture: true,          // 自动订阅 session/event 写入 L1
  userCaptureChars: 2000,     // 单条用户消息最多记多少字
  toolCaptureChars: 500,      // 工具输出截断（bash 一次能吐几万字，L1 才 1500 字）
  injectHot: false,           // 是否把 L1「刚发生的」也注入。默认关：它每轮都变，会把缓存打掉
  refreshMinMs: 30 * 60 * 1000, // 记忆块变化后的最小刷新间隔。快照是**追加**不是替换，刷新一次就多几百上千 token，别调太小
  flushEveryMs: 5 * 60 * 1000,
  sweepEveryMs: 6 * 60 * 60 * 1000,
  autoCompact: true,          // 每轮结束把 dsh 自带历史压成一条占位（零 LLM）
  compactKeepTurns: 1,        // 保留最近几轮原文（太多上下文就大，太少模型没上下文）
  compactArchiveChars: 1200,  // 每轮压缩归档进记忆的字数上限
}

/** 数据放哪：优先 DSH_HOME，否则 ~/.dsh。v5 用独立目录，别和 v1 的 store 混。 */
/**
 * 记忆数据放哪。优先级（高 → 低）：
 *   1. 插件配置里的 dir（dsh 侧 cordis 配置，跨 agent 移植时最可靠）
 *   2. 环境变量 MEMORY_TIERS_DIR
 *   3. <DSH_HOME 或 ~/.dsh>/storages/memory-v5
 *
 * ★ 为什么不能从 config.json 读 dir：config.json 就在 dir 里面，
 *   要先知道 dir 才能读它，鸡生蛋。想换目录只有上面两种方式，
 *   换完把旧目录整个拷过去即可（store.json / vectors-part-*.json / archive/ 都在里面，自包含）。
 */
function expandHome(p) {
  const s = String(p || '').trim()
  if (!s) return ''
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2))
  return s
}

function defaultDir() {
  const fromEnv = expandHome(process.env.MEMORY_TIERS_DIR)
  if (fromEnv) return fromEnv
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'memory-v5')
}

/**
 * 从数据目录读 config.json。
 *
 * 为什么不用 schemastery 声明配置 schema（那样设置页会有表单）：
 * 插件是 link 安装的，**import 不到 dsh 自己的包**（schemastery 也一样），
 * 和当年 defineTool 那个坑同源。所以配置走 JSON 文件，零依赖。
 *
 * 文件不存在就返回空对象；写坏了也不抛错，只当没配。
 */
function loadFileConfig(dir) {
  const p = join(dir, 'config.json')
  if (!existsSync(p)) return {}
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

/** 每个工具的返回值都是纯文本，渲染函数共用一个 */
const textRender = (_args, value) => [{ type: 'text', text: String(value ?? '') }]

/**
 * 找 embedding key：插件配置 > 环境变量 > AstrBot 配置
 * 找不到就返回 null（降级本地向量），不抛错——插件加载不该被 key 卡死。
 */
function resolveAuth(cfg) {
  if (cfg.apiKey) return { apiKey: cfg.apiKey, base: cfg.apiBase }
  const env = process.env.SILICONFLOW_API_KEY || process.env.SILICON_API_KEY
  if (env) return { apiKey: env, base: cfg.apiBase }
  const cands = [
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), '..', '.astrbot', 'data', 'cmd_config.json'),
    join(homedir(), '.astrbot', 'data', 'cmd_config.json'),
  ]
  for (const p of cands) {
    const hit = keyFromAstrbot(p)
    if (hit) return { apiKey: hit.apiKey, base: hit.base || cfg.apiBase }
  }
  return null
}

/** 本地哈希向量：没有 embedding 时的兜底（语义弱，但同话题仍有一定重叠） */
function hashEmbed(texts, dim = 1024) {
  return texts.map((t) => {
    const s = String(t || '')
    const v = new Array(dim).fill(0)
    for (let i = 0; i < s.length; i++) {
      v[s.charCodeAt(i) % dim] += 1
      if (i < s.length - 1) v[(s.charCodeAt(i) * 31 + s.charCodeAt(i + 1)) % dim] += 0.5
    }
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
    return v.map((x) => x / n)
  })
}

/**
 * 把记忆块注入上下文。
 *
 * ★ 优先用 systemPrompt.context() 而不是 section()，原因是缓存：
 *   - section() 拼进系统提示词。系统提示词整块是「前缀」，记忆一变，
 *     它后面那段稳定内容（工具说明等）也跟着重新计费。实测记忆块排在 2600
 *     （正好撞上 TOOL_WORKFLOW），把它后面的 3100 字也拖下水了，每轮多花约 4000 token。
 *   - context() 是「durable user-role snapshot」：作为一条 user 消息追加进历史，
 *     而且框架会比对文本，内容没变就不追加。系统提示词保持逐字节不变，
 *     缓存全命中；只有记忆真的变了才多一条消息。
 * section() 只作为老版本兜底，order 放到 10200 之后（persona suffix 之后）。
 */
function injectPrompt(ctx, getText) {
  const sp = ctx.systemPrompt
  if (!sp) return false
  const tryOnce = (fn) => { try { fn(); return true } catch { return false } }

  // 优先：追加式快照，不破坏系统提示词缓存
  if (typeof sp.context === 'function') {
    const ok = tryOnce(() => sp.context({
      name: 'memory-tiers',
      order: 250,          // 排在 working directory(100)/sandbox(110) 之后
      text: getText,
      interpolate: false,  // 记忆里可能出现 {{ }}，别当变量替换
    }))
    if (ok) return true
  }
  // 兜底：老版本没有 context()，塞系统提示词末尾（10200 之后已是最末）
  if (typeof sp.section === 'function') {
    return tryOnce(() => sp.section({
      name: 'memory-tiers',
      order: 10300,
      text: getText,
      interpolate: false,
    }))
  }
  return false
}

/**
 * 归档审计日志：每轮结束记一行，落到 <dir>/capture.log。
 *
 * 为什么要有：K1 那个 bug（tool/result 的 callId 读错字段）让所有 action 静默消失，
 * 内存里、日志里都看不出来，只有去数 store.json 才发现 action 是 0 条。
 * 有了这个文件，「本轮抓到几条 / 写了几条 / L1 里有几条」一目了然。
 */
function appendCaptureLog(dir, line) {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'capture.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* 日志写不了不影响主流程 */ }
}

/** 从 ContentBlock[] 里只取可见文本（reasoning 是草稿、image 是附件，都不进记忆） */
function takeText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

export function apply(ctx, config = {}) {
  const baseDir = config.dir || defaultDir()
  // 优先级：默认值 < config.json < 调用方传入 config
  const cfg = { ...PLUGIN_DEFAULTS, ...loadFileConfig(baseDir), ...config }
  const log = ctx.logger ?? console
  const dir = baseDir

  // 第一次启动时落一份示例配置，用户知道该去哪改（JSON 不能写注释，用字段名兜住）
  try {
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'config.json')
    if (!existsSync(p)) {
      writeFileSync(p, JSON.stringify({
        apiKey: '',
        apiBase: 'https://api.siliconflow.cn/v1',
        bootMaxChars: 0,               // 0 = 不限制，注入量由 L1/L2/L3 各自容量决定
        autoCapture: true,
        userCaptureChars: 2000,
        toolCaptureChars: 500,
        budgetTokens: 0,
        injectHot: false,
        refreshMinMs: 1800000,
        autoCompact: true,
        compactKeepTurns: 1,
        compactArchiveChars: 1200,
        memoryCfg: { longMaxChars: 4000 },
        _说明: [
          'apiKey 填硅基流动的 key（也可以设环境变量 SILICONFLOW_API_KEY）；',
          '留空则用本地哈希向量，语义检索会变弱。改完重启 dsh 生效。',
          'bootMaxChars = 总闸门，0 = 不限制（推荐）。注入多少由 memoryCfg 的三层容量自己决定。',
          'memoryCfg.longMaxChars = L3 视图容量（长期记忆能进上下文的字数）。',
          'injectHot = 是否注入 L1「刚发生的」。默认 false：当前会话的对话本来就在历史里，',
          '  重复注入会让注入块每轮变化，每轮多烧几千 token 的缓存。跨会话恢复靠 L2/L3 + 检索。',
          'refreshMinMs = 记忆块变化后的最小刷新间隔（毫秒），默认 1800000（30 分钟）。',
          'autoCompact = 每轮结束时把 dsh 自带历史压成一条占位（零 LLM），被压掉的内容先归档进记忆。',
          'compactKeepTurns = 压完保留最近几轮原文。默认 1：上下文恒定 = 系统提示 + 记忆块 + 最近 1 轮。',
        ],
      }, null, 2), 'utf8')
    }
  } catch { /* 写不了不影响主流程 */ }

  // ── 模型层：有 key 接 silicon，没 key 降级本地向量 ──
  const auth = resolveAuth(cfg)
  let silicon = null
  if (auth) {
    try {
      silicon = createSilicon({ apiKey: auth.apiKey, base: auth.base, budgetTokens: cfg.budgetTokens })
    } catch (err) {
      log.warn?.('[memory-tiers] silicon 初始化失败：%s', err?.message ?? err)
    }
  } else {
    log.warn?.('[memory-tiers] 没有 embedding key（配置 apiKey / 环境变量 SILICONFLOW_API_KEY），'
      + '降级为本地哈希向量：能跑，但语义检索变弱')
  }

  const models = silicon
    ? {
        embed: (t) => silicon.embed(t),
        classify: (t) => silicon.classify(t),
        classifyBatch: (t) => silicon.classifyBatch(t),
        judgeRelation: (a, b) => silicon.relation(a, b),
        // ★ 参数顺序要包装：memory5 调 (lines, channel, folks)，silicon 是 (texts, hint, channel, people)
        summarize: (lines, channel, folks) => silicon.summarize(lines, '', channel, folks),
        summarizeWithSources: (lines, ch, folks) => silicon.summarizeWithSources(lines, ch, folks),
        rerank: (q, docs) => silicon.rerank(q, docs),
      }
    : { embed: hashEmbed }

  const mem = createMemory5({
    dir,
    ...models,
    // memoryCfg 允许 config.json 覆盖 v5 的底层参数（如 longMaxChars = L3 视图容量）
    cfg: { ...MEM_DEFAULTS, ...(cfg.memoryCfg || {}), summarizeMode: 'deferred' },
  })

  // 启动补结算：关机期间该忘的、该沉的要补上。异步，不阻塞加载。
  Promise.resolve()
    .then(() => mem.sweep())
    .catch((err) => log.warn?.('[memory-tiers] 启动结算失败：%s', err?.message ?? err))

  /** 统一注册工具，单个失败不影响其他 */
  let toolCount = 0
  const register = (def) => {
    try {
      ctx.tools.register(def)
      toolCount += 1
    } catch (err) {
      log.warn?.('[memory-tiers] 工具 %s 注册失败：%s', def.name, err?.message ?? err)
    }
  }

  register({
    name: 'memory_write',
    description:
      '把值得长期记住的信息写入记忆。适用于：用户的偏好/习惯、已确定的决定、' +
      '项目背景、踩过的坑与结论。不要用来记临时性的中间过程。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一条独立可读的结论，别用代词' },
        importance: { type: 'number', description: '0~1，默认由本地规则判断。用户明确强调的给 0.8 以上' },
        channel: { type: 'string', description: 'dialog / action / event，默认 dialog' },
      },
      required: ['text'],
    },
    output: { schema: {}, render: textRender },
    async execute(args = {}) {
      const text = String(args.text || '').trim()
      if (!text) return '写入失败：text 不能为空'
      const r = await mem.write({
        text,
        speaker: 'user',
        channel: args.channel || 'dialog',
        importance: Number.isFinite(Number(args.importance)) ? Number(args.importance) : null,
      })
      return `已记住 [${r.id}]（${r.layer}）`
    },
  })

  register({
    name: 'memory_search',
    description:
      '检索长期记忆。当用户提到过去聊过的事、旧约定、项目历史时调用。' +
      'depth：summary（只搜摘要，默认）/ detail（摘要+原文）/ full（再加流水账）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或短句，别写整段问题' },
        depth: { type: 'string', description: 'summary / detail / full，默认 auto' },
        limit: { type: 'number', description: '返回条数，默认 6' },
      },
      required: ['query'],
    },
    output: { schema: {}, render: textRender },
    async execute(args = {}) {
      const q = String(args.query || '').trim()
      if (!q) return '检索失败：query 不能为空'
      const r = await mem.search(q, {
        depth: args.depth || 'auto',
        limit: Math.min(20, Number(args.limit) || 6),
      })
      if (!r.hits.length) return '没有找到相关记忆。'
      const lines = r.hits.map((h) => `- [${h.id}] (${h.layer} ${h.when}) ${h.text}`)
      lines.push('', '（确认这些确实相关后，请调用 memory_attend 传 id 列表；只搜到不算数）')
      return lines.join('\n')
    },
  })

  register({
    name: 'memory_attend',
    description:
      '确认哪些检索结果真的相关。被确认的记忆热度 +1，冷层条目会回到观察层。' +
      '搜到但不调用它，热度不会涨——这是防止回音室的设计。',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '相关的记忆 id 列表' },
      },
      required: ['ids'],
    },
    output: { schema: {}, render: textRender },
    async execute(args = {}) {
      const ids = Array.isArray(args.ids) ? args.ids : (args.ids ? [args.ids] : [])
      if (!ids.length) return '没有提供 id'
      const n = mem.attend(ids)
      return `已确认 ${n} 条相关（热度 +1）`
    },
  })

  register({
    name: 'memory_forget',
    description: '删除一条记错的记忆。发现记忆与用户实际说法冲突时，先 forget 再 write，不要硬留。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的记忆 id' } },
      required: ['id'],
    },
    output: { schema: {}, render: textRender },
    async execute(args = {}) {
      if (!args.id) return '删除失败：id 不能为空'
      const r = mem.forget(String(args.id))
      return r.ok ? `已删除 ${args.id}` : `未找到 ${args.id}`
    },
  })

  register({
    name: 'memory_stats',
    description: '查看六层记忆分布、调用统计和待摘要队列。排查"为什么它想不起来"时先调这个。',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: textRender },
    async execute() {
      const s = mem.stats()
      const layers = Object.entries(s.count).map(([k, v]) => `${k}=${v}`).join(' ')
      const pending = mem.pendingSummaries()
      const calls = Object.entries(s.calls || {})
        .filter(([, v]) => v && v.rounds)
        .map(([k, v]) => `${k}:${v.rounds}`)
        .join(' ')
      return [
        `总条数 ${s.total} · 向量 ${s.vectors}`,
        `分层 ${layers}`,
        `待摘要 ${pending} 条 · 调用 ${calls || '（无）'}`,
        `数据目录 ${dir}`,
      ].join('\n')
    },
  })

  // ── 自动捕获：session/event → 按 turn 聚合写入 L1 ──
  if (cfg.autoCapture !== false && typeof ctx.on === 'function') {
    ctx.effect(() => {
      const bufs = new Map()   // sessionId -> { user: [], tools: Map }

      const bufOf = (sid) => {
        if (!bufs.has(sid)) bufs.set(sid, { user: [], tools: new Map() })
        return bufs.get(sid)
      }

      const off = ctx.on('session/event', (session, event) => {
        const d = event?.data || {}
        const sid = session?.id || 'default'
        const buf = bufOf(sid)

        if (event.type === 'user/message') {
          // ★ 只记人类输入。agent.inject / skill 内容 / cron 通知也走这个事件，
          //   它们的 source.kind 不是 'user'。全记会让 L1 被系统注入污染，
          //   而且每轮重复注入会让「重复度=重要性」信号失真。
          if (d.source?.kind === 'user') {
            const t = takeText(d.content)
            if (t) buf.user.push(t.slice(0, cfg.userCaptureChars))
          }
          return
        }

        if (event.type === 'tool/call') {
          buf.tools.set(d.callId, { name: String(d.name || 'tool'), args: String(d.arguments || '') })
          return
        }

        if (event.type === 'tool/result') {
          // ★ 坑：callId / isError 不在 event.data 顶层，而在 message 里。
          //   data = { turn, step, message: { role:'tool', toolCallId, isError, content } }
          //   早期版本写成 d.callId，永远 undefined → 匹配不上 → 所有 action 被静默丢掉（K1）。
          const cid = d.callId ?? d.message?.toolCallId ?? d.message?.source?.callId
          const c = cid ? buf.tools.get(cid) : undefined
          if (c) {
            c.out = takeText(d.message?.content).slice(0, cfg.toolCaptureChars)
            c.err = !!(d.isError ?? d.message?.isError)
            c.done = true
          }
          return
        }

        if (event.type === 'turn/end') {
          const rows = []
          for (const t of buf.user) rows.push({ text: t, speaker: 'user', channel: 'dialog' })
          for (const c of buf.tools.values()) {
            // ★ 没配到 result 的也要记：被中断/超时的调用同样是「做过的事」，
            //   漏掉它们会让"记录确确实实进了 L1"这个保证出现缺口。
            const out = c.done ? (c.out || '（无输出）') : '（被中断，无结果）'
            const head = c.err ? '失败' : (c.done ? '完成' : '未完成')
            rows.push({
              text: `运行 ${c.name}「${c.args.slice(0, 120)}」→ ${head}：${out}`,
              speaker: 'bot',
              channel: 'action',
            })
          }
          const stat = { user: buf.user.length, tool: buf.tools.size, rows: rows.length }
          bufs.delete(sid)

          // ★ 顺序很重要：先归档进记忆，再压缩历史。
          //   压缩函数内部也会自己归档一次（它要保证「写成功才丢」），
          //   两者不冲突：这里记的是本轮原始消息，那里记的是被压掉的整段对话。
          const doCompact = async () => {
            if (cfg.autoCompact === false || !session) return
            try {
              const cr = await compactSurface(session, mem, {
                keepTurns: cfg.compactKeepTurns,
                archiveChars: cfg.compactArchiveChars,
                log,
              })
              if (cr.compacted) {
                log.info?.('[memory-tiers] 压缩历史 removed=%d archived=%d', cr.removed, cr.archived)
                appendCaptureLog(dir, `压缩 removed=${cr.removed} archived=${cr.archived}`)
              }
            } catch (err) {
              log.warn?.('[memory-tiers] 压缩失败：%s', err?.message ?? err)
              appendCaptureLog(dir, `压缩失败 err=${err?.message ?? err}`)
            }
          }

          if (rows.length) {
            Promise.resolve()
              .then(() => mem.writeMany(rows))
              .then((res) => {
                // ★ 审计：这是 K1 那类 bug 唯一的照妖镜。
                //   写入条数和实际进 L1 的条数都要记，光看 rows.length 看不出来。
                const n = mem.stats?.().count?.L1 ?? '?'
                log.info?.('[memory-tiers] turn 归档 user=%d tool=%d 写入=%d L1=%s',
                  stat.user, stat.tool, rows.length, n)
                appendCaptureLog(dir, `turn 归档 user=${stat.user} tool=${stat.tool} ` +
                  `rows=${rows.length} written=${Array.isArray(res) ? res.length : '?'} L1=${n}`)
                return doCompact()
              })
              .catch((err) => {
                log.warn?.('[memory-tiers] 自动写入失败：%s', err?.message ?? err)
                appendCaptureLog(dir, `turn 归档失败 user=${stat.user} tool=${stat.tool} rows=${rows.length} err=${err?.message ?? err}`)
              })
          } else {
            appendCaptureLog(dir, `turn 归档空 user=${stat.user} tool=${stat.tool}`)
            Promise.resolve().then(doCompact).catch(() => {})
          }
        }
      })

      return () => { try { off?.() } catch { /* 已卸 */ } }
    })
  }

  // ── 注入上下文：每轮实时生成，但带节流 ──
  //
  // ★ 为什么要节流：L3 视图按 importance×heat 截取，而 heat 随时间衰减，
  //   边界条目的分数会此消彼长，导致入选集合时不时变一条。文本一变，
  //   快照就刷新一次、多一条 user 消息，前缀缓存也就断一次。
  //   5 分钟内的变化先压住，返回上一次的文本 —— 记忆晚几分钟进上下文没人察觉，
  //   但每轮多几千 token 是真金白银。
  let lastBlock = ''
  let lastBlockAt = 0
  const getBlock = () => {
    const fresh = mem.buildBlock(cfg.bootMaxChars, { includeHot: cfg.injectHot === true })
    const now = Date.now()
    const gap = now - lastBlockAt
    // 首次（空→有）立刻生效；之后变化要等过节流窗口
    if (!lastBlock || fresh === lastBlock || gap >= cfg.refreshMinMs) {
      lastBlock = fresh
      lastBlockAt = now
      return fresh
    }
    return lastBlock
  }

  ctx.inject(['systemPrompt'], (c) => {
    const ok = injectPrompt(c, getBlock)
    // 写一份状态文件，方便不用翻日志就知道插件有没有接上
    try {
      writeFileSync(
        join(dir, 'status.json'),
        JSON.stringify({
          loadedAt: new Date().toISOString(),
          tools: toolCount,
          promptInjected: ok,
          semantic: !!silicon,
          autoCapture: cfg.autoCapture !== false,
          dir,
        }, null, 2),
        'utf8',
      )
    } catch { /* 状态文件写不了不影响主流程 */ }
    if (!ok) {
      throw new Error('[memory-tiers] systemPrompt 注入失败：当前版本的 section() 签名与插件不匹配')
    }
    log.info?.('[memory-tiers] 已加载，注册 %d 个工具（语义=%s，自动捕获=%s）',
      toolCount, !!silicon, cfg.autoCapture !== false)
  })

  // ── 设置页的服务端接口：读写 config.json（前端见 client.mjs） ──
  //    webServer 可能比插件晚就绪，用 inject 等它，而不是直接读 ctx.webServer。
  ctx.inject(['webServer'], (c) => {
    const off = installSettingsApi(c, { dir, getCfg: () => cfg, log, mem })
    if (typeof off === 'function') {
      try { c.effect(() => off, 'memory-tiers: settings api') } catch { /* 老版本没有 effect 也不影响接口可用 */ }
    } else {
      log.warn?.('[memory-tiers] webServer 不可用，设置页接口没挂上')
    }
    log.info?.('[memory-tiers] 设置页接口已挂：/dsh-memory/api/settings')
  })

  // ── 斜杠命令：手动查看/维护入口 ──
  ctx.inject(['commands'], (c) => {
    c.commands.register({
      name: 'memory',
      description: '记忆：/memory 概览 · /memory list · /memory search 关键词 · /memory flush · /memory sweep',
      input: { hint: '[list | search 关键词 | flush | sweep]' },
      async handler(invocation) {
        const raw = String(invocation.rawInput || '').trim()

        if (raw === 'list') {
          const all = mem.list()
          if (!all.length) return { kind: 'success', text: '还没有任何记忆。' }
          const byLayer = {}
          for (const it of all) {
            byLayer[it.layer] = byLayer[it.layer] || []
            byLayer[it.layer].push(it)
          }
          const parts = Object.entries(byLayer).map(([l, rows]) => [
            `### ${l}（${rows.length}）`,
            ...rows.slice(0, 8).map((i) => `- [${i.id}] ${String(i.text).slice(0, 40)}`),
          ].join('\n'))
          return { kind: 'success', text: parts.join('\n\n') }
        }

        if (raw.startsWith('search ')) {
          const r = await mem.search(raw.slice(7).trim(), { depth: 'full', limit: 8 })
          return {
            kind: 'success',
            text: r.hits.length
              ? r.hits.map((h) => `[${h.layer}] ${h.text}`).join('\n')
              : '没有命中。',
          }
        }

        if (raw === 'flush') {
          const n = await mem.flushSummaries()
          return { kind: 'success', text: `处理了 ${n} 条待摘要` }
        }

        if (raw === 'sweep') {
          await mem.sweep()
          const s = mem.stats()
          return { kind: 'success', text: `已收敛：总 ${s.total} 条，L3 视图 ${s.count[LAYER.LONG]} 条` }
        }

        const s = mem.stats()
        return {
          kind: 'success',
          text: [
            `六层：${Object.entries(s.count).map(([k, v]) => `${k}=${v}`).join(' · ')}`,
            `总条数 ${s.total} · 向量 ${s.vectors} · 待摘要 ${mem.pendingSummaries()}`,
            `数据目录 ${dir}`,
          ].join('\n'),
        }
      },
    })
  })

  // ── 定时维护：deferred 摘要 + 周期收敛 ──
  // ctx.effect 的返回值是清理函数，插件卸载时 dsh 会调用；不写会泄漏定时器。
  ctx.effect?.(() => {
    const flushTimer = setInterval(() => {
      mem.flushSummaries().catch((err) => log.warn?.('[memory-tiers] flush 失败：%s', err?.message ?? err))
    }, cfg.flushEveryMs)

    const sweepTimer = setInterval(() => {
      mem.sweep().catch((err) => log.warn?.('[memory-tiers] sweep 失败：%s', err?.message ?? err))
    }, cfg.sweepEveryMs)

    if (flushTimer.unref) flushTimer.unref()
    if (sweepTimer.unref) sweepTimer.unref()
    return () => {
      clearInterval(flushTimer)
      clearInterval(sweepTimer)
    }
  })
}
