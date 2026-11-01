/**
 * 设置页的服务端半边：读写 config.json + 暴露运行状态。
 *
 * 为什么要自己写 HTTP 接口而不是用 schemastery 声明 schema：
 * link 安装的插件 import 不到 @deepseek-ai/*，拿不到 dsh 的 schema 包（见 ARCHITECTURE 19.5）。
 * 走 webServer + 自己的 React 组件反而更可控——字段说明、分组、只读状态都能自己排版。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isIP } from 'node:net'

/** 可写字段白名单：只管运行参数，dir 和 _说明 不让前端改 */
const WRITABLE = {
  apiKey: 'string',
  apiBase: 'string',
  bootMaxChars: 'number',
  injectHot: 'boolean',
  refreshMinMs: 'number',
  autoCompact: 'boolean',
  compactKeepTurns: 'number',
  compactArchiveChars: 'number',
  userCaptureChars: 'number',
  toolCaptureChars: 'number',
  budgetTokens: 'number',
  flushEveryMs: 'number',
  sweepEveryMs: 'number',
}

/** 三层容量在 memoryCfg 里，单独处理 */
const MEMORY_CFG_WRITABLE = {
  hotMaxChars: 'number',
  consolidateMaxChars: 'number',
  longMaxChars: 'number',
  dl2MaxChars: 'number',
}

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
  const { dir, getCfg, log, mem } = opts
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
          memoryCfg: { ...(file.memoryCfg || {}) },
        },
        live: {
          dir,
          counts: stats?.count ?? null,
          vectors: stats?.vectors ?? null,
          semantic: !!(live.apiKey || process.env.SILICONFLOW_API_KEY),
          autoCompact: live.autoCompact !== false,
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
