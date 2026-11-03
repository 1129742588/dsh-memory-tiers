/**
 * 设置页的服务端半边：读写 config.json + 暴露运行状态。
 *
 * 为什么要自己写 HTTP 接口而不是用 schemastery 声明 schema：
 * link 安装的插件 import 不到 @deepseek-ai/*，拿不到 dsh 的 schema 包（见 ARCHITECTURE 19.5）。
 * 走 webServer + 自己的 React 组件反而更可控——字段说明、分组、只读状态都能自己排版。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isIP } from 'node:net'

/** 可写字段白名单：只管运行参数，dir 和 _说明 不让前端改 */
const WRITABLE = {
  apiKey: 'string',
  apiBase: 'string',
  bootMaxChars: 'number',
  inject: 'boolean',        // 注入总开关：false = 只写不读
  refreshMin: 'number',     // L3 视图（DL3 排序）刷新间隔（分钟）；L1/L2 不节流
  semanticTtlMin: 'number', // 语义检索结果的有效期（分钟）
  autoCompact: 'boolean',
  compactKeepTurns: 'number',
  compactArchiveChars: 'number',
  userCaptureChars: 'number',
  toolCaptureChars: 'number',
  botCaptureChars: 'number',   // 一轮 assistant 正文拼起来后截多少（L1 当最近历史用）
  quietMin: 'number',          // 安静多少分钟才允许整理 L1
  organizeEveryMin: 'number',  // 整理定时器（分钟）
  budgetTokens: 'number',
  flushEveryMs: 'number',
  sweepEveryMs: 'number',
  // 'siliconflow' = 嵌入/重排用那两个免费模型；'custom' = 用 models 里自己填的
  preset: 'string',
  // ★ 布局：'split' = 六文件（默认）；'legacy' = 老的单文件分片（回退用）
  layout: 'string',
  // ★ 多写者标识：共用同一个数据目录时每个程序必须不同
  writer: 'string',
}

/** 数据目录：不写 config.json（它在目录里面，鸡生蛋），写固定位置的指针文件 */
function pointerFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'memory-tiers.json')
}

/** 指针文件里「已保存的目标目录」，空串 = 没设过（用默认目录）。
 *  回显必须用它而不是进程正在用的目录：改目录要重启才生效，
 *  要是回显运行目录，保存完一刷新就「弹回 memory-v5」，看起来像没保存（踩过）。 */
export function readPointerDir() {
  try {
    const raw = JSON.parse(readFileSync(pointerFile(), 'utf8'))
    const v = raw && typeof raw.dir === 'string' ? raw.dir.trim() : ''
    return v || ''
  } catch { return '' }
}

/** 关思考：chat（融合判关系）默认 true，summary 默认 false */
const NOTHINK_WRITABLE = { chat: 'boolean', summary: 'boolean' }

/** 三层容量在 memoryCfg 里，单独处理 */
const MEMORY_CFG_WRITABLE = {
  hotMaxChars: 'number',
  consolidateMaxChars: 'number',
  longMaxChars: 'number',
  dl2MaxChars: 'number',
  // 下面几项和 astrbot 端的配置项一一对应（hot_quota_own / l2_keep_max / summary_chunk / forget_threshold）
  hotQuotaOwn: 'number',
  l2KeepMax: 'number',
  summaryChunk: 'number',
  forgetThreshold: 'number',
}

/** 每个模型阶段可单独覆盖的连接参数；留空字符串 = 清除覆盖、回落到顶层 */
const STAGES = ['embed', 'rerank', 'chat', 'summary']
// source: 'session' 跟当前会话模型走；'api' 或留空则走下面的连接参数
const STAGE_FIELDS = { base: 'string', apiKey: 'string', model: 'string', source: 'string' }

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
      if (buf.length > 1 << 20) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(buf))
    req.on('error', reject)
  })
}

/** 只信任本机回环；远程连接交给 dsh 的 connection 服务判定 */
function isTrustedReq(ctx, req) {
  const addr = req.socket?.remoteAddress || ''
  const bare = addr.replace(/^::ffff:/, '')
  if (isIP(bare) && (bare === '127.0.0.1' || bare === '::1')) return true
  try {
    const conn = ctx.get?.('connection') || ctx.connection
    if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
  } catch { /* 栅栏不可用按不信任处理 */ }
  return false
}

function coerce(kind, value) {
  if (kind === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
  }
  if (kind === 'number') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  if (kind === 'string') return typeof value === 'string' ? value : undefined
  return undefined
}

/**
 * 挂上 /dsh-memory/api/*。
 * @returns {() => void} disposer；webServer 不可用时返回 null
 */
export function installSettingsApi(ctx, opts) {
  const { dir, getCfg, log, mem, getModels, getSession } = opts
  const webServer = ctx.webServer
  if (!webServer?.register) return null

  const cfgPath = join(dir, 'config.json')
  const disposers = []

  const readCfgFile = () => {
    try {
      if (!existsSync(cfgPath)) return {}
      return JSON.parse(readFileSync(cfgPath, 'utf8'))
    } catch (err) {
      log?.warn?.('[memory-tiers] 读 config.json 失败：%s', err?.message ?? err)
      return {}
    }
  }

  function route(path, handler) {
    const off = webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!isTrustedReq(ctx, req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
        try { await handler(req, res) } catch (err) {
          log?.warn?.('[memory-tiers] 设置接口出错：%s', err?.message ?? err)
          json(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    })
    if (typeof off === 'function') disposers.push(off)
  }

  // ── settings：读和写必须**合成一个 handler** ──
  //   踩过的坑：同一路径注册两次，若宿主「首个匹配即终止」，后注册的永远收不到请求。
  //   实测表现是 GET 正常、POST 405（或反之），排查半天。
  route('/dsh-memory/api/settings', async (req, res) => {
    if (req.method === 'GET') {
      const file = readCfgFile()
      const live = getCfg() || {}
      const stats = (() => {
        try { return mem?.stats?.() ?? null } catch { return null }
      })()
      json(res, 200, {
        ok: true,
        config: {
          ...file,
          // dir 不在 config.json 里（鸡生蛋）。回显「已保存的目标目录」（指针文件），
          // 不是进程正在用的目录——进程目录要重启才换，回显它会显得保存没生效。
          // 想看进程实际在用哪个，看下面 live.dir（界面上的「当前生效目录」）。
          dir: readPointerDir() || dir,
          writer: file.writer || 'default',
          memoryCfg: { ...(file.memoryCfg || {}) },
        },
        live: {
          dir,
          layout: live.layout || 'split',
          // 多写者：我自己是谁、还有谁在往这个目录写
          // split 布局看 L1.tmp/*.jsonl，legacy 看 store-*.json
          writer: live.writer || 'default',
          peers: (() => {
            try {
              const files = readdirSync(dir)
              if (files.includes('L1.tmp') || files.includes('L1.json')) {
                try {
                  return readdirSync(join(dir, 'L1.tmp'))
                    .filter((f) => f.endsWith('.jsonl'))
                    .map((f) => f.replace(/\.jsonl$/, '').split('.')[0])
                    .filter(Boolean)
                } catch { return [] }
              }
              return files
                .map((f) => f.match(/^store-([A-Za-z0-9_-]+)\.json$/)?.[1])
                .filter(Boolean)
            } catch { return [] }
          })(),
          pointerFile: pointerFile(),
          counts: stats?.count ?? null,
          chars: stats?.chars ?? null,        // 每层字数（设置页要写清楚"存了多少字"）
          vectors: stats?.vectors ?? null,
          total: stats?.total ?? null,
          byChannel: stats?.byChannel ?? null,
          temp: stats?.temp ?? null,
          lock: stats?.lock ?? null,
          last: stats?.last ?? null,
          semantic: !!(live.apiKey || process.env.SILICONFLOW_API_KEY ||
            Object.values(live.models || {}).some((m) => m?.apiKey)),
          inject: live.inject !== false,
          autoCompact: live.autoCompact !== false,
          preset: live.preset || 'siliconflow',
          noThink: { chat: true, summary: false, ...(file.noThink || {}) },
          // 会话模型通道：能不能用、当前是哪个模型
          session: (() => {
            try { return getSession?.() ?? null } catch { return null }
          })(),
          // 各阶段最终解析成什么（覆盖已合并），设置页拿来显示"实际生效"
          models: (() => {
            try { return getModels?.() ?? null } catch { return null }
          })(),
        },
        configPath: cfgPath,
      })
      return
    }

    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只接受 GET / POST' }); return }

    const raw = await readBody(req)
    let body
    try { body = JSON.parse(raw || '{}') } catch { json(res, 400, { ok: false, error: 'JSON 解析失败' }); return }

    // 兼容 { config: {...} } 和直接 {...} 两种写法（踩过：只认一种会「保存成功但没变」）
    const incoming = (body && typeof body.config === 'object' && body.config) || body || {}

    const cur = readCfgFile()
    const next = { ...cur }
    const applied = []
    const ignored = []

    // 数据目录单独处理：写指针文件，不写 config.json
    if (typeof incoming.dir === 'string') {
      const v = incoming.dir.trim()
      if (v) {
        try {
          writeFileSync(pointerFile(), JSON.stringify({ dir: v }, null, 2), 'utf8')
          applied.push('dir(指针文件)')
        } catch {
          ignored.push('dir')
        }
      }
    }

    for (const [k, kind] of Object.entries(WRITABLE)) {
      if (!(k in incoming)) continue
      const v = coerce(kind, incoming[k])
      if (v === undefined) { ignored.push(k); continue }
      next[k] = v
      applied.push(k)
    }

    if (incoming.memoryCfg && typeof incoming.memoryCfg === 'object') {
      const mc = { ...(cur.memoryCfg || {}) }
      for (const [k, kind] of Object.entries(MEMORY_CFG_WRITABLE)) {
        if (!(k in incoming.memoryCfg)) continue
        const v = coerce(kind, incoming.memoryCfg[k])
        if (v === undefined) { ignored.push('memoryCfg.' + k); continue }
        mc[k] = v
        applied.push('memoryCfg.' + k)
      }
      next.memoryCfg = mc
    }

    // ── 每阶段模型覆盖 ──
    // 语义：填了就覆盖，留空（空字符串）= 删掉这条覆盖，回落到顶层的 apiKey/apiBase 和默认模型名。
    // 这样「全走一家」和「摘要单独挂别家」都能表达，不用区分"没填过"和"清空了"。
    if (incoming.models && typeof incoming.models === 'object') {
      const mm = { ...(cur.models || {}) }
      for (const st of STAGES) {
        const src = incoming.models[st]
        if (!src || typeof src !== 'object') continue
        const dst = { ...(mm[st] || {}) }
        for (const [k, kind] of Object.entries(STAGE_FIELDS)) {
          if (!(k in src)) continue
          const v = coerce(kind, src[k])
          if (v === undefined) { ignored.push(`models.${st}.${k}`); continue }
          if (v === '') delete dst[k]
          else dst[k] = v
          applied.push(`models.${st}.${k}`)
        }
        // source 只接受 session / api，别的值（含乱写）一律当"没配"
        if (typeof dst.source === 'string' && dst.source !== 'session' && dst.source !== 'api') {
          delete dst.source
          ignored.push(`models.${st}.source`)
        }
        if (Object.keys(dst).length) mm[st] = dst
        else delete mm[st]
      }
      next.models = mm
    }

    // ── 关思考 ──
    if (incoming.noThink && typeof incoming.noThink === 'object') {
      const nt = { ...(cur.noThink || {}) }
      for (const [k, kind] of Object.entries(NOTHINK_WRITABLE)) {
        if (!(k in incoming.noThink)) continue
        const v = coerce(kind, incoming.noThink[k])
        if (v === undefined) { ignored.push('noThink.' + k); continue }
        nt[k] = v
        applied.push('noThink.' + k)
      }
      next.noThink = nt
    }

    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(cfgPath, JSON.stringify(next, null, 2), 'utf8')
    } catch (err) {
      json(res, 500, { ok: false, error: '写入失败：' + String(err?.message ?? err) })
      return
    }
    log?.info?.('[memory-tiers] 设置已更新：%s 项，重启 dsh 生效', applied.length)
    json(res, 200, { ok: true, applied, ignored, needRestart: true })
  })

  // ── 最近归档/压缩审计（设置页底部展示） ──
  route('/dsh-memory/api/log', async (req, res) => {
    if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
    let lines = []
    try {
      const p = join(dir, 'capture.log')
      if (existsSync(p)) {
        const all = readFileSync(p, 'utf8').trim().split('\n')
        lines = all.slice(-15)
      }
    } catch { /* 读不到就当空 */ }
    json(res, 200, { ok: true, lines })
  })

  return () => { for (const off of disposers) { try { off() } catch { /* 已卸 */ } } }
}
