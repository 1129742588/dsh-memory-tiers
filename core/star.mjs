// 记忆星图 v6（球状星云 / 时间螺旋 + 三着色 + 引用连线 + 双页侧栏 + 划过全文）
//
// 这个文件是**星图的唯一实现**：HTML/CSS/画布全部在这里，不额外拆静态资源。
// 页面由插件挂到已有的 webServer（/dsh-memory/star），数据来自引擎内存，
// 不再自己读盘、也不再另起端口。开发时仍可用 tools/star.mjs 走 CLI。
//
// 对外只导出纯函数：readLayers / layersFromMemory / buildPayload / renderHtml / countLayers。
//
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 从数据目录读六层（CLI / 兜底用；插件内优先走 layersFromMemory） */
export function readLayers(dir) {
  const read = (f) => {
    const p = join(dir, f)
    if (!existsSync(p)) return []
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      return Array.isArray(j) ? j : (j.items || [])
    } catch { return [] }
  }
  const layers = {
    L1: read('L1.json'), L2: read('L2.json'), L3: read('L3.json'),
    DL1: read('DL1.json'), DL2: read('DL2.json'), DL3: read('DL3.json'),
  }
  for (const k of Object.keys(layers)) layers[k] = layers[k].filter((it) => !it.supersededBy)
  return layers
}

/** 从引擎内存取六层：mem.list(layer)；L3 是视图层，单独取。 */
export function layersFromMemory(mem) {
  const get = (layer) => {
    try {
      const rows = mem?.list?.(layer)
      return Array.isArray(rows) ? rows.filter((it) => it && !it.supersededBy) : []
    } catch { return [] }
  }
  return {
    L1: get('L1'), L2: get('L2'), L3: get('L3'),
    DL1: get('DL1'), DL2: get('DL2'), DL3: get('DL3'),
  }
}

export function countLayers(layers) {
  return Object.values(layers || {}).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0)
}

/** 一次数据快照（页面与 /data 接口共用） */
export function buildPayload({ dir = '', layers = {} } = {}) {
  return { generated: new Date().toLocaleString('zh-CN'), dir: String(dir || ''), layers }
}

/** 渲染完整 HTML；payload 会被内嵌进页面，dir 只用于显示 */
export function renderHtml(payload, memDirEsc = '') {
  const body = JSON.stringify(payload).replace(/</g, '\\u003c')
  return html(body, String(memDirEsc).replace(/\\/g, '\\\\'))
}

// ══════════════════ HTML 模板 ══════════════════
const html = (payload, memDirEsc) => `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆星图 · 星云</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box }
  html,body { height:100%; overflow:hidden; background:#04070f; color:#c6d4e8;
    font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif }
  body { display:flex }

  /* ── 滚动条深色化：默认白条在黑底上非常突兀 ── */
  ::-webkit-scrollbar { width:8px; height:8px }
  ::-webkit-scrollbar-track { background:transparent }
  ::-webkit-scrollbar-thumb { background:#1c2c4a; border-radius:99px }
  ::-webkit-scrollbar-thumb:hover { background:#2a4068 }
  ::-webkit-scrollbar-corner { background:transparent }

  /* ── 左侧：范围 / 布局 / 着色（默认展开，可收起）── */
  aside { width:236px; min-width:236px; height:100vh; padding:16px 14px; display:flex;
    flex-direction:column; gap:10px; background:linear-gradient(180deg,#070c18,#050912);
    border-right:1px solid #16223c; overflow-y:auto; z-index:20;
    transition:margin-left .24s ease }
  aside.collapsed { margin-left:-236px }
  .brand { font-size:15px; letter-spacing:2px; color:#eaf2ff; font-weight:600 }
  .brand small { display:block; font-size:10px; color:#4d5f80; letter-spacing:0; margin-top:5px; font-weight:400; line-height:1.7 }
  .mode-live { color:#5ee6a8 } .mode-snap { color:#e6b95e }
  .sec { font-size:10px; color:#4a5d80; letter-spacing:2px; margin-top:4px }
  .layer-btn { display:flex; align-items:center; gap:9px; padding:9px 11px; border-radius:10px;
    border:1px solid #17233e; background:#0a1122; cursor:pointer; font-size:12.5px; transition:.15s; color:#b9c8de }
  .layer-btn:hover { border-color:#3b82f688 }
  .layer-btn.active { border-color:#5aa7ff; background:#10204237; color:#fff; box-shadow:0 0 14px #1e4d8c55 }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; box-shadow:0 0 7px currentColor; background:currentColor }
  .cnt { margin-left:auto; font-size:10.5px; color:#5c7295; background:#0a0f1e; padding:1px 7px; border-radius:99px }
  .chips { display:flex; flex-wrap:wrap; gap:6px }
  .chip { padding:5px 10px; border-radius:99px; border:1px solid #22355c; background:#0b1428;
    color:#8fa5c6; font-size:11px; cursor:pointer; user-select:none }
  .chip.on { border-color:#5aa7ff; color:#fff; background:#16305c }

  /* ── 中间：星云 + 底部搜索 ── */
  main { flex:1; position:relative; min-width:0 }
  canvas { display:block; width:100%; height:100vh }
  .searchbar { position:absolute; left:50%; bottom:34px; transform:translateX(-50%);
    width:min(640px,78%); display:flex; gap:8px; z-index:6 }
  .searchbar input { flex:1; padding:13px 18px; border-radius:14px; border:1px solid #24406e;
    background:#0a1428e6; color:#eaf3ff; font-size:14px; outline:none;
    box-shadow:0 6px 30px #000a, 0 0 22px #1c3f7744 }
  .searchbar input:focus { border-color:#5aa7ff; box-shadow:0 6px 30px #000a, 0 0 28px #2c6bc066 }
  .searchbar .go { padding:0 16px; border-radius:14px; border:1px solid #24406e; background:#12234aee;
    color:#cfe4ff; cursor:pointer; font-size:13px; white-space:nowrap }
  .searchbar .go:hover { background:#1a3260 }
  .hint { position:absolute; top:14px; left:18px; font-size:11px; color:#3c4f72; pointer-events:none }

  /* ── 划过提示：直接展开全文 ── */
  #tip { position:absolute; pointer-events:none; background:#0b1526f7; border:1px solid #2b4272;
    color:#e3eeff; font-size:12px; padding:9px 12px; border-radius:9px;
    max-width:min(440px, 70vw); max-height:min(340px, 60vh); overflow:hidden;
    display:none; line-height:1.65; z-index:9; box-shadow:0 10px 34px #000b }
  #tip .tt-head { color:#8fb7ff; font-size:11px; margin-bottom:4px }
  #tip .tt-body { white-space:pre-wrap; color:#dbe7f8 }

  /* ── 沉浸模式 ── */
  body.immersive aside, body.immersive .side, body.immersive .searchbar,
  body.immersive .hint { display:none !important }
  .imm-exit { display:none; position:fixed; top:14px; right:16px; z-index:60;
    padding:8px 14px; border-radius:10px; border:1px solid #2b4272; background:#0a1428cc;
    color:#cfe4ff; font-size:12px; cursor:pointer; opacity:.35; transition:opacity .2s }
  .imm-exit:hover { opacity:1 }
  body.immersive .imm-exit { display:block }

  /* ── 右侧：两页（搜索结果 / 详情）── */
  .side { width:300px; min-width:300px; height:100vh; display:flex; flex-direction:column;
    background:linear-gradient(180deg,#070c18,#050912); border-left:1px solid #16223c; z-index:20;
    transition:transform .22s ease }
  .side-tabs { display:flex; border-bottom:1px solid #16223c; flex:none }
  .side-tabs .tab { flex:1; text-align:center; padding:11px 0; font-size:12px; color:#6d84a8;
    cursor:pointer; border-bottom:2px solid transparent }
  .side-tabs .tab.on { color:#eaf3ff; border-bottom-color:#5aa7ff; background:#0d1730 }
  .page { flex:1; display:flex; flex-direction:column; min-height:0 }
  .page[hidden] { display:none }
  .filters { padding:12px 14px; border-bottom:1px solid #16223c; display:flex; flex-direction:column; gap:9px; flex:none }
  .filters h2 { font-size:10.5px; color:#5d739a; letter-spacing:2px; font-weight:600 }
  .frow { display:flex; gap:8px }
  .frow input[type=date] { flex:1; padding:7px 9px; border-radius:8px; border:1px solid #1c2c4e;
    background:#0a1226; color:#b9cbe4; font-size:11.5px; outline:none; color-scheme:dark }
  .results { flex:1; overflow-y:auto; padding:10px 12px 20px }
  .rstat { font-size:11px; color:#54688c; padding:2px 4px 10px }
  .ritem { padding:9px 10px; border-radius:9px; border:1px solid transparent; cursor:pointer;
    transition:.12s; margin-bottom:6px }
  .ritem:hover { background:#0e1a33; border-color:#20365c }
  .ritem.sel { background:#12234a; border-color:#3b6cb4 }
  .ritem .head { display:flex; align-items:center; gap:6px; font-size:10.5px; color:#7187ab; margin-bottom:3px }
  .ritem .head .ld { width:7px; height:7px; border-radius:50%; box-shadow:0 0 5px currentColor; background:currentColor }
  .ritem .txt { font-size:11.5px; color:#c2d2e8; line-height:1.55 }

  /* 详情页 */
  .detail-page { flex:1; overflow-y:auto; padding:14px }
  .detail-page .back { font-size:11.5px; color:#6f8bb4; cursor:pointer; margin-bottom:10px; display:inline-block }
  .detail-page .back:hover { color:#a9c7f0 }
  .detail-page h3 { font-size:13px; margin-bottom:8px; font-weight:600 }
  .detail-page .meta { font-size:11px; color:#8296b5; line-height:1.9 }
  .detail-page .meta b { color:#a9bdd8; font-weight:500 }
  .detail-page .full { white-space:pre-wrap; color:#dbe7f8; font-size:12.5px; line-height:1.75;
    margin-top:10px; padding-top:10px; border-top:1px solid #1a2846 }
  .detail-page .refs { margin-top:10px; font-size:11px; color:#8f7bbd; line-height:1.8 }

  /* ── 窄屏：收窄两侧栏（不再提供独立收放）── */
  @media (max-width:1280px) {
    aside { width:200px; min-width:200px; padding:12px 10px }
    .side { width:250px; min-width:250px }
    .searchbar { width:min(640px, 92%); bottom:22px; flex-wrap:wrap }
    #tip { max-width:min(360px, 86vw) }
  }
</style>
</head>
<body>

<aside id="aside">
  <div class="brand">✦ 记忆星图<small>六层记忆 · 球状星云<br>
    <span id="modeTag">…</span> · 共 <span id="totalCount">0</span> 条<br>
    库目录：__DIR__</small></div>

  <div class="sec">范围</div>
  <div id="layerBtns"></div>

  <div class="sec" style="margin-top:2px">布局</div>
  <div class="chips" id="layoutChips"></div>

  <div class="sec" style="margin-top:2px">着色</div>
  <div class="chips" id="colorChips"></div>

  <div class="sec" style="margin-top:2px">性能（上限条数 / 截断顺序）</div>
  <div class="chips" id="renderChips" style="align-items:center;gap:6px">
    <input type="number" id="renderMaxInput" min="0" step="10" placeholder="全部"
      style="width:80px;padding:5px 8px;border-radius:8px;border:1px solid #22355c;background:#0b1428;color:#b9cbe4;font-size:11.5px;outline:none">
    <span style="font-size:10px;color:#54688c">条（空或 0 = 全部）</span>
  </div>
  <div class="chips" id="truncChips"></div>
  <div class="chips" id="autoChips"></div>

  <div style="margin-top:auto; font-size:10.5px; color:#3c4f72; line-height:1.8">
    拖拽旋转星云 · 滚轮缩放<br>划过看全文 · 点击看详情（右侧）<br>点选 DL3/L3 摘要显示引用连线 · 双击启停自转
  </div>
</aside>

<main>
  <canvas id="cv"></canvas>
  <div class="hint" id="hint"></div>
  <div id="tip"></div>
  <div class="searchbar">
    <input id="q" placeholder="搜索记忆 —— 关键词、人名、任意内容…" autocomplete="off">
    <button class="go" id="goBtn">搜索</button>
    <button class="go" id="resetBtn">重置</button>
    <button class="go" id="refreshBtn">⟳ 刷新库</button>
    <button class="go" id="exportBtn">⤓ 导出</button>
    <button class="go" id="immersiveBtn" title="只留星云（再点或按 ESC 退出）">◱ 沉浸</button>
  </div>
  <button class="imm-exit" id="immExitBtn">▣ 退出沉浸（ESC）</button>
</main>

<div class="side" id="side">
  <div class="side-tabs">
    <div class="tab on" id="tabResults">搜索结果</div>
    <div class="tab" id="tabDetail">详情</div>
  </div>

  <div class="page" id="pageResults">
    <div class="filters">
      <h2>过滤条件</h2>
      <div class="frow">
        <input type="date" id="dFrom"><span style="color:#41557a; align-self:center">→</span><input type="date" id="dTo">
      </div>
      <div class="chips" id="chCh"></div>
      <div class="chips" id="chKind"></div>
    </div>
    <div class="results" id="results"></div>
  </div>

  <div class="page" id="pageDetail" hidden>
    <div class="detail-page">
      <span class="back" id="backToResults">‹ 返回结果</span>
      <div id="detailBody"><div class="meta">在星图里点一颗星，这里显示详情</div></div>
    </div>
  </div>
</div>

<script>
// ── 数据 ──
const FALLBACK = __DATA__
let DATA = FALLBACK, liveMode = false

const LAYERS = [
  { key:'L1',  name:'L1 即时层',    color:'#dff4ff' },
  { key:'L2',  name:'L2 巩固层',    color:'#7de8ff' },
  { key:'L3',  name:'L3 长期视图',  color:'#ffd28f' },
  { key:'DL1', name:'DL1 流水账',   color:'#8b93b8' },
  { key:'DL2', name:'DL2 长久原文', color:'#6fb6ff' },
  { key:'DL3', name:'DL3 长久摘要', color:'#ff9db8' },
]
const COLORS = Object.fromEntries(LAYERS.map(l => [l.key, l.color]))
const NAMES  = Object.fromEntries(LAYERS.map(l => [l.key, l.name]))
const LI     = Object.fromEntries(LAYERS.map((l, i) => [l.key, i]))
const CHANNELS = [['dialog','对话'],['action','动作'],['event','事件'],['note','笔记']]

let NODES = [], tMin = 0, tMax = 1, nodeById = new Map()
function rebuildNodes() {
  const prevSelId = selId
  NODES = []
  for (const [k, items] of Object.entries(DATA.layers)) for (const it of items) NODES.push({ ...it, _layer:k })
  const ts = NODES.map(n => (n.createdAt || n.consolidatedAt || 0)).filter(Boolean)
  tMin = Math.min(...ts, Date.now()); tMax = Math.max(...ts, Date.now() + 1)
  nodeById = new Map(NODES.map(n => [n.id, n]))
  for (const n of NODES) Object.assign(n, posOf(n))
  sel = prevSelId ? (NODES.find(n => n.id === prevSelId) || null) : null
  selId = sel ? sel.id : null
  if (sel) renderDetail(sel)
}
const tsOf = (n) => n.createdAt || n.consolidatedAt || 0
const fmt = (t) => { if (!t) return '—'; const d = new Date(t)
  return d.toLocaleString('zh-CN',{ month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) }
const timeNorm = (n) => Math.max(0, Math.min(1, (tsOf(n) - tMin) / Math.max(1, tMax - tMin)))

// ── 布局 ──
let layoutMode = 'sphere'
function hash01(s, salt) { let h = 2166136261 ^ salt; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return ((h >>> 0) % 100000) / 100000 }
function spherePos(n) {
  const u1 = hash01(n.id, 1), u2 = hash01(n.id, 2), u3 = hash01(n.id, 3)
  const r = Math.pow(u1, 1/2.2), th = u2 * Math.PI * 2, ph = Math.acos(2 * u3 - 1)
  return { x: r * Math.sin(ph) * Math.cos(th), y: r * Math.sin(ph) * Math.sin(th), z: r * Math.cos(ph) }
}
function spiralPos(n) {
  const t = timeNorm(n)
  const ang = (LI[n._layer] / 6) * Math.PI * 2 + t * Math.PI * 3.2 + hash01(n.id, 5) * 0.10
  const r = 0.14 + t * 0.86
  return { x: r * Math.cos(ang), y: (hash01(n.id, 9) - 0.5) * 0.16 * (0.35 + t * 0.65), z: r * Math.sin(ang) }
}
const posOf = (n) => layoutMode === 'spiral' ? spiralPos(n) : spherePos(n)

let DUST = [], CORE = []
function buildDust() {
  DUST = []; CORE = []
  const GOLD = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < 950; i++) {
    let x, y, z
    if (layoutMode === 'spiral') {
      const t = hash01('dt' + i, 3), li = Math.floor(hash01('dl' + i, 5) * 6)
      const ang = (li / 6) * Math.PI * 2 + t * Math.PI * 3.2 + (hash01('dj' + i, 7) - 0.5) * 0.35
      const r = 0.14 + t * 0.86
      x = r * Math.cos(ang); y = (hash01('dy' + i, 11) - 0.5) * 0.3; z = r * Math.sin(ang)
    } else {
      const zz = 1 - (2 * (i + 0.5)) / 950, rr = Math.sqrt(Math.max(0, 1 - zz * zz)), th = i * GOLD
      const rad = Math.pow(hash01('dust' + i, 7), 0.42) * 0.98
      x = Math.cos(th) * rr * rad + (hash01('dx' + i, 11) - 0.5) * 0.14
      y = Math.sin(th) * rr * rad + (hash01('dy' + i, 13) - 0.5) * 0.14
      z = zz * rad + (hash01('dz' + i, 17) - 0.5) * 0.14
    }
    DUST.push({ x, y, z, s: 0.45 + hash01('ds' + i, 19) * 1.15, warm: hash01('dc' + i, 23) < 0.16 })
  }
  for (let i = 0; i < 250; i++) {
    let x, y, z
    if (layoutMode === 'spiral') {
      const t = Math.pow(hash01('ct' + i, 29), 1.6) * 0.5
      const ang = t * Math.PI * 3.2 + (hash01('cj' + i, 31) - 0.5) * 0.6
      const r = 0.05 + t * 0.9
      x = r * Math.cos(ang); y = (hash01('cy' + i, 37) - 0.5) * 0.1; z = r * Math.sin(ang)
    } else {
      const zz = 1 - (2 * (i + 0.5)) / 250, rr = Math.sqrt(Math.max(0, 1 - zz * zz)), th = i * GOLD
      const rad = Math.pow(hash01('c' + i, 29), 0.8) * 0.38
      x = Math.cos(th) * rr * rad; y = Math.sin(th) * rr * rad; z = zz * rad
    }
    CORE.push({ x, y, z, s: 0.35 + hash01('cs' + i, 31) * 0.75 })
  }
}
buildDust()

// ── 光晕贴图 ──
function withAlpha(c, a) {
  if (c.startsWith('#')) return c + Math.round(a * 255).toString(16).padStart(2, '0')
  if (c.startsWith('hsl(')) return 'hsla(' + c.slice(4, -1) + ',' + a + ')'
  if (c.startsWith('rgb(')) return 'rgba(' + c.slice(4, -1) + ',' + a + ')'
  return c
}
function makeSprite(color, soft) {
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2)
  grad.addColorStop(0, '#ffffff')
  grad.addColorStop(0.12, color)
  grad.addColorStop(soft ? 0.35 : 0.28, withAlpha(color, 0.4))
  grad.addColorStop(1, 'transparent')
  g.fillStyle = grad; g.fillRect(0, 0, S, S)
  return c
}
const SPR = {}
function getSprite(color, soft) { const k = color + (soft ? 's' : ''); return SPR[k] || (SPR[k] = makeSprite(color, soft)) }

// ── 着色模式 ──
let colorMode = 'layer'
function colorOf(n) {
  if (colorMode === 'layer') return COLORS[n._layer]
  if (colorMode === 'time') {
    const t = timeNorm(n)
    const hue = t < 0.5 ? 248 + (192 - 248) * (t * 2) : 192 + (40 - 192) * ((t - 0.5) * 2)
    return 'hsl(' + hue.toFixed(0) + ',' + (78 + t * 14).toFixed(0) + '%,' + (56 + t * 12).toFixed(0) + '%)'
  }
  const imp = typeof n.importance === 'number' ? n.importance : 0.5
  return 'hsl(' + (218 - 176 * imp).toFixed(0) + ',' + (38 + 58 * imp).toFixed(0) + '%,' + (50 + 12 * imp).toFixed(0) + '%)'
}

// ── 状态 ──
let view = 'ALL', rotY = 0.6, rotX = 0.25, zoom = 1, spin = true
// 画面平移（屏幕像素）：滚轮缩放时用来把「光标下的点」钉住，0 表示星云居中
let panX = 0, panY = 0
let wheeling = false, wheelT = 0   // 滚轮进行中：星尘层不做隔帧降频，避免缩放时背景滞后
// 选中聚焦会临时暂停自转；取消选中时按这个标记还原（用户手动双击关掉的自转不还原）
let spinPausedBySelect = false
let sel = null, selId = null, hover = null, dragging = null, moved = false
const chOn = new Set(CHANNELS.map(c => c[0]))
let kindOn = new Set(['raw','summary'])
let q = '', dFrom = null, dTo = null

function passFilter(n) {
  if (view !== 'ALL' && n._layer !== view) return false
  if (!chOn.has(n.channel || 'dialog')) return false
  if (!kindOn.has(n.kind || 'raw')) return false
  const t = tsOf(n)
  if (dFrom && t < dFrom) return false
  if (dTo && t > dTo + 86400e3 - 1) return false
  if (q) { const hay = ((n.text||'') + ' ' + (n.speaker||'') + ' ' + (n.people||[]).join(' ')).toLowerCase()
    if (!hay.includes(q.toLowerCase())) return false }
  return true
}
const filteredSorted = () => NODES.filter(passFilter).sort((a,b) => tsOf(b) - tsOf(a))

// ── 渲染上限与截断策略（性能设置）──
let renderMax = 0            // 0 = 全部
let autoRefresh = true        // 30 秒自动刷新开关
let truncMode = 'imp'        // imp 重要度 | time 时间（新优先）| layer 按层
function renderSet() {
  const list = filteredSorted()
  if (!renderMax || list.length <= renderMax) return list
  const sorted = [...list]
  if (truncMode === 'imp') sorted.sort((a, b) => (b.importance || 0) - (a.importance || 0) || tsOf(b) - tsOf(a))
  else if (truncMode === 'layer') sorted.sort((a, b) => LI[a._layer] - LI[b._layer] || tsOf(b) - tsOf(a))
  // time：filteredSorted 本身已按时间降序
  return sorted.slice(0, renderMax)
}
const renderIds = () => new Set(renderSet().map(n => n.id))

// ── canvas ──
const cv = document.getElementById('cv'), ctx = cv.getContext('2d')
let W, H, DPR
function resize() { DPR = devicePixelRatio||1; W = cv.clientWidth; H = cv.clientHeight
  cv.width = W*DPR; cv.height = H*DPR; ctx.setTransform(DPR,0,0,DPR,0,0)
  clampPan()   // 窗口尺寸变化后上限也跟着变，顺带把越界的平移夹回来
}
addEventListener('resize', () => { resize(); draw() })

function project(n, R) {
  const cy = Math.cos(rotY), sy = Math.sin(rotY), cx = Math.cos(rotX), sx = Math.sin(rotX)
  const x1 = n.x * cy + n.z * sy
  const z1 = -n.x * sy + n.z * cy
  const y1 = n.y * cx - z1 * sx
  const z2 = n.y * sx + z1 * cx
  return { x: x1 * R, y: y1 * R, z: z2 }
}

const dustCv = document.createElement('canvas')
const dustCtx = dustCv.getContext('2d')
let dustKey = '', dustSkip = 0
function drawDustLayer(R, ox, oy) {
  const key = layoutMode + '|' + rotY.toFixed(4) + '|' + rotX.toFixed(4) + '|' + zoom.toFixed(3) + '|' + panX.toFixed(1) + ',' + panY.toFixed(1) + '|' + W + 'x' + H
  if (key === dustKey) return
  dustSkip++
  if (!dragging && !wheeling && dustSkip % 2 !== 0) return
  dustKey = key
  if (dustCv.width !== cv.width || dustCv.height !== cv.height) { dustCv.width = cv.width; dustCv.height = cv.height }
  dustCtx.setTransform(DPR, 0, 0, DPR, 0, 0)
  dustCtx.clearRect(0, 0, W, H)
  dustCtx.globalCompositeOperation = 'lighter'
  const haze = dustCtx.createRadialGradient(ox, oy, 0, ox, oy, R * 1.18)
  haze.addColorStop(0, '#2c4b7e66'); haze.addColorStop(0.35, '#1a2f542a'); haze.addColorStop(0.75, '#0e1b3112'); haze.addColorStop(1, 'transparent')
  dustCtx.fillStyle = haze; dustCtx.fillRect(0, 0, W, H)
  const dust = []
  for (const d of DUST) { const p = project(d, R * 1.02); dust.push({ d, ...p }) }
  dust.sort((a, b) => a.z - b.z)
  for (const p of dust) {
    const depth = (p.z / R + 1) / 2
    const pr = Math.min(1, Math.hypot(p.x, p.y) / (R * 1.02))
    const edge = 1 - Math.max(0, pr - 0.72) * 1.9
    const a = (0.12 + depth * 0.66) * Math.max(0.06, edge)
    const r = (p.d.s * 1.7 + depth * 3.2) * zoom
    const spr = getSprite(p.d.warm ? '#ff9db8' : (depth > 0.8 ? '#d8ecff' : '#7fb4e8'), true)
    dustCtx.globalAlpha = a
    dustCtx.drawImage(spr, ox + p.x - r, oy + p.y - r, r * 2, r * 2)
  }
  for (const c of CORE) {
    const p = project(c, R * 1.02), depth = (p.z / R + 1) / 2
    const r = (c.s * 1.6 + depth * 2.2) * zoom
    const spr = getSprite(depth > 0.72 ? '#eaf5ff' : '#9cc6ef', false)
    dustCtx.globalAlpha = 0.3 + depth * 0.6
    dustCtx.drawImage(spr, ox + p.x - r, oy + p.y - r, r * 2, r * 2)
  }
  dustCtx.globalAlpha = 1
}

function draw() {
  ctx.setTransform(DPR,0,0,DPR,0,0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#04070f'; ctx.fillRect(0,0,W,H)
  const R = Math.min(W,H) * 0.40 * zoom
  const ox = W/2 + panX, oy = H/2 + panY

  drawDustLayer(R, ox, oy)
  ctx.globalCompositeOperation = 'lighter'
  ctx.drawImage(dustCv, 0, 0, W, H)
  ctx.globalAlpha = 1

  // 引用连线：点选 DL3/L3 摘要 → 按真实 sources 连到原文
  const focus = sel && (sel._layer === 'DL3' || sel._layer === 'L3') ? sel : null
  if (focus && focus.sources && focus.sources.length) {
    const f = project(focus, R)
    ctx.globalCompositeOperation = 'source-over'
    ctx.save()
    for (const id of focus.sources) {
      const tgt = nodeById.get(id)
      if (!tgt) continue
      const p = project(tgt, R)
      ctx.strokeStyle = 'rgba(190,130,255,0.55)'; ctx.lineWidth = 1.3
      ctx.beginPath(); ctx.moveTo(ox+f.x, oy+f.y); ctx.lineTo(ox+p.x, oy+p.y); ctx.stroke()
      ctx.strokeStyle = 'rgba(200,150,255,0.9)'; ctx.lineWidth = 1.4
      ctx.beginPath(); ctx.arc(ox+p.x, oy+p.y, 5.5, 0, 7); ctx.stroke()
      ctx.fillStyle = '#ffffff'
      ctx.beginPath(); ctx.arc(ox+p.x, oy+p.y, 1.6, 0, 7); ctx.fill()
    }
    ctx.restore()
  }

  const proj = []
  const ids = renderMax ? renderIds() : null
  for (const n of NODES) {
    if (ids && !ids.has(n.id)) continue     // 超出渲染上限的节点不绘制
    const p = project(n, R); proj.push({ n, ...p })
  }
  proj.sort((a,b) => a.z - b.z)
  ctx.globalCompositeOperation = 'lighter'
  const now = performance.now()
  for (const p of proj) {
    const n = p.n
    const pass = passFilter(n)
    const isHot = n === hover || n === sel
    const depth = (p.z / R + 1) / 2
    const base = (n.kind === 'summary' ? 2.2 : 1.6) * (layoutMode === 'spiral' ? 0.9 : 1)
    const r = (base + depth * 2.2) * zoom * (isHot ? 2.2 : 1)
    const alpha = pass ? (0.3 + depth * 0.7) : 0.06
    const col = colorOf(n)
    const spr = getSprite(col, false)
    ctx.globalAlpha = alpha * (isHot ? 0.95 : 0.62)
    const gr = r * (isHot ? 6.5 : 4.6)
    ctx.drawImage(spr, ox + p.x - gr, oy + p.y - gr, gr * 2, gr * 2)
    ctx.globalAlpha = alpha; ctx.fillStyle = col
    ctx.beginPath(); ctx.arc(ox + p.x, oy + p.y, r * 0.72, 0, 7); ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath(); ctx.arc(ox + p.x, oy + p.y, r * 0.34, 0, 7); ctx.fill()
    ctx.fillStyle = col
    if (isHot) { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 0.95
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.1
      ctx.beginPath(); ctx.arc(ox + p.x, oy + p.y, r * 2.2 + 4, 0, 7); ctx.stroke()
      ctx.globalCompositeOperation = 'lighter' }
    if (pass && q && !isHot) {
      const ph = (now / 900) % 1
      ctx.globalAlpha = (1 - ph) * 0.55
      ctx.strokeStyle = col; ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.arc(ox + p.x, oy + p.y, r * 2 + 6 + ph * 16, 0, 7); ctx.stroke()
    }
    n._sx = ox + p.x; n._sy = oy + p.y; n._sr = r * 2 + 6
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  document.getElementById('hint').textContent =
    (view === 'ALL' ? '全部记忆' : NAMES[view]) + ' · ' + (layoutMode === 'spiral' ? '时间螺旋' : '球状星云') +
    ' · 命中 ' + filteredSorted().length + ' / ' + NODES.length + ' 条'
}

// ── 交互 ──
cv.addEventListener('mousedown', e => { dragging = { x:e.clientX, y:e.clientY, ry:rotY, rx:rotX }; moved = false })
addEventListener('mousemove', e => {
  if (dragging) {
    const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y
    if (Math.abs(dx)+Math.abs(dy) > 3) moved = true
    // 水平与垂直统一为「转相机」手感（拖动方向与画面位移相反，与上下一致）
    rotY = dragging.ry - dx * 0.006; rotX = Math.max(-1.2, Math.min(1.2, dragging.rx + dy * 0.006))
    draw(); return
  }
  const r = cv.getBoundingClientRect()
  hover = null
  for (const n of NODES) { if (!n._sx) continue
    if (Math.hypot(e.clientX - r.left - n._sx, e.clientY - r.top - n._sy) <= n._sr) { hover = n; break } }
  cv.style.cursor = hover ? 'pointer' : 'default'
  const tip = document.getElementById('tip')
  if (hover) {
    // 划过即展开全文
    tip.innerHTML = '<div class="tt-head"><b style="color:' + colorOf(hover) + '">' + NAMES[hover._layer] + '</b> · ' +
      fmt(tsOf(hover)) + (hover.channel ? ' · ' + hover.channel : '') + '</div><div class="tt-body">' +
      (hover.text || '').replace(/</g,'&lt;') + '</div>'
    tip.style.display = 'block'
    const tw = tip.offsetWidth, th = tip.offsetHeight
    let tx = e.clientX - r.left + 16, ty = e.clientY - r.top + 12
    if (tx + tw > r.width - 8) tx = Math.max(8, e.clientX - r.left - tw - 16)
    if (ty + th > r.height - 8) ty = Math.max(8, r.height - th - 8)
    tip.style.left = tx + 'px'; tip.style.top = ty + 'px'
  } else tip.style.display = 'none'
  draw()
})
cv.addEventListener('mouseleave', () => {
  document.getElementById('tip').style.display = 'none'
  hover = null
  draw()
})
addEventListener('mouseup', (e) => {
  if (dragging && !moved && hover) {
    selectNode(hover, true)
  } else if (dragging && !moved && !hover) {
    clearSelection(); renderResults(); draw()
  }
  dragging = null
})
// 缩放锚定：把光标正下方的那一点钉住不动（pan' = m − (m − pan)·k）
// 平移上限按「星云超出视口多少」算：星云整体还放得下时上限为 0（强制回中），
// 只有放大到溢出才允许偏移。这样边缘放大再缩回时偏移会被逐步收紧到 0，不会留在偏位。
function clampPan() {
  const R = Math.min(W, H) * 0.40 * zoom
  const lx = Math.max(0, R * 0.92 - (W/2 - 80))
  const ly = Math.max(0, R * 0.92 - (H/2 - 80))
  panX = Math.max(-lx, Math.min(lx, panX))
  panY = Math.max(-ly, Math.min(ly, panY))
}
cv.addEventListener('wheel', e => { e.preventDefault()
  const r = cv.getBoundingClientRect()
  const mx = e.clientX - r.left - W/2, my = e.clientY - r.top - H/2   // 光标相对画布中心
  const prev = zoom
  zoom = Math.max(0.3, Math.min(3.2, zoom * (e.deltaY < 0 ? 1.12 : 1/1.12)))
  const k = zoom / prev
  panX = mx - (mx - panX) * k
  panY = my - (my - panY) * k
  clampPan()
  wheeling = true; clearTimeout(wheelT)
  wheelT = setTimeout(() => { wheeling = false; draw() }, 130)
  draw() }, { passive:false })
cv.addEventListener('dblclick', () => { spin = !spin; spinPausedBySelect = false })

// 选中节点：星图聚焦 + 右侧切到「详情」页（不弹浮卡、不额外展示）
function selectNode(n, fly) {
  sel = n; selId = n.id
  if (fly) {
    if (spin) { spin = false; spinPausedBySelect = true }   // 只有「原本在转」才记暂停，取消选中时还原
    const pose = poseToCenter(n.x, n.y, n.z)
    flyTo(pose.ry, pose.rx)
  }
  renderDetail(n); switchPage('detail'); openSide()
  renderResults(); draw()
}

// 取消选中：恢复被选中暂停掉的自转
function clearSelection() {
  sel = null; selId = null
  if (spinPausedBySelect) { spin = true; spinPausedBySelect = false }
}

// ── 旋转缓动 ──
let tween = null
// 求把某个点转到「正前方 + 画面正中」所需视角：
//   x1 = x·cosθ + z·sinθ = 0 → rotY；再算旋转后的视轴深度 z1，令 y1 = y·cosφ − z1·sinφ = 0 → rotX
function poseToCenter(x, y, z) {
  const ry = Math.atan2(-x, z)
  const z1 = -x * Math.sin(ry) + z * Math.cos(ry)   // >0 表示该点落在正面（不会被中心遮住）
  return { ry, rx: Math.atan2(y, z1) }
}
function flyTo(toY, toX) {
  let d = toY - rotY
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  tween = { fromY: rotY, fromX: rotX, toY: rotY + d, toX, fromPX: panX, fromPY: panY, t0: performance.now(), dur: 480 }
}
function stepTween() {
  if (!tween) return false
  const k = Math.min(1, (performance.now() - tween.t0) / tween.dur)
  const e = 1 - Math.pow(1 - k, 3)
  rotY = tween.fromY + (tween.toY - tween.fromY) * e
  rotX = tween.fromX + (tween.toX - tween.fromX) * e
  // 聚焦时把平移量一并归零，被选的星最终落在正中心
  panX = tween.fromPX * (1 - e); panY = tween.fromPY * (1 - e)
  if (k >= 1) tween = null
  draw()
  return true
}
// ── 形态过渡（球形 ↔ 螺旋）──
let morph = null
function stepMorph() {
  if (!morph) return false
  const k = Math.min(1, (performance.now() - morph.t0) / morph.dur)
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
  for (const it of morph.items) {
    it.n.x = it.from.x + (it.to.x - it.from.x) * e
    it.n.y = it.from.y + (it.to.y - it.from.y) * e
    it.n.z = it.from.z + (it.to.z - it.from.z) * e
  }
  rotY = morph.fromRot.rotY + (morph.toRot.rotY - morph.fromRot.rotY) * e
  rotX = morph.fromRot.rotX + (morph.toRot.rotX - morph.fromRot.rotX) * e
  zoom = morph.fromRot.zoom + (morph.toRot.zoom - morph.fromRot.zoom) * e
  panX = morph.fromRot.panX + (morph.toRot.panX - morph.fromRot.panX) * e
  panY = morph.fromRot.panY + (morph.toRot.panY - morph.fromRot.panY) * e
  if (k >= 1) { morph = null; dustKey = '' }
  draw()
  return true
}

function pulseActive() { return !!q && filteredSorted().length > 0 }
setInterval(() => {
  if (stepMorph()) return
  if (stepTween()) return
  if (spin && !dragging) { rotY += 0.0026; draw(); return }
  if (pulseActive()) draw()   // 静止状态下也持续重绘：搜索命中的脉冲光环才会动
}, 46)

// ── 左侧：范围 / 布局 / 着色 ──
function refreshBtns() {
  const box = document.getElementById('layerBtns'); box.innerHTML = ''
  const mk = (key, name, color, cnt) => {
    const b = document.createElement('div')
    b.className = 'layer-btn' + (key === view ? ' active' : '')
    b.innerHTML = '<span class="dot" style="color:'+color+'"></span>'+name+'<span class="cnt">'+cnt+'</span>'
    b.onclick = () => { view = key; clearSelection(); refreshBtns(); renderResults(); draw() }
    box.appendChild(b)
  }
  mk('ALL','全部（星云）','#e8f2ff', NODES.length)
  for (const l of LAYERS) mk(l.key, l.name, l.color, (DATA.layers[l.key]||[]).length)
}
function refreshModeChips() {
  const lb = document.getElementById('layoutChips'); lb.innerHTML = ''
  for (const [key, name] of [['sphere','球形星云'],['spiral','时间螺旋']]) {
    const el = document.createElement('span')
    el.className = 'chip' + (layoutMode === key ? ' on' : '')
    el.textContent = name
    el.onclick = () => { if (layoutMode === key || morph) return
      // 形态过渡：节点从当前位置插值到目标布局，视角与缩放同时缓动
      const toRot = key === 'spiral' ? { rotY: 0.5, rotX: 0.95, zoom: 1, panX: 0, panY: 0 } : { rotY: 0.6, rotX: 0.25, zoom: 1, panX: 0, panY: 0 }
      morph = {
        t0: performance.now(), dur: 720,
        fromRot: { rotY, rotX, zoom, panX, panY }, toRot,
        items: NODES.map(n => ({
          n,
          from: { x: n.x, y: n.y, z: n.z },
          to: key === 'spiral' ? spiralPos(n) : spherePos(n),
        })),
      }
      layoutMode = key
      buildDust(); dustKey = ''
      refreshModeChips() }
    lb.appendChild(el)
  }
  const cb = document.getElementById('colorChips'); cb.innerHTML = ''
  for (const [key, name] of [['layer','层级'],['time','时间'],['imp','重要度']]) {
    const el = document.createElement('span')
    el.className = 'chip' + (colorMode === key ? ' on' : '')
    el.textContent = name
    el.onclick = () => { colorMode = key; refreshModeChips(); draw() }
    cb.appendChild(el)
  }
}

// ── 右侧：两页（搜索结果 / 详情）──
function switchPage(which) {
  document.getElementById('pageResults').hidden = which !== 'results'
  document.getElementById('pageDetail').hidden = which !== 'detail'
  document.getElementById('tabResults').classList.toggle('on', which === 'results')
  document.getElementById('tabDetail').classList.toggle('on', which === 'detail')
}
function openSide() { document.getElementById('side').classList.add('open') }
function renderDetail(n) {
  const box = document.getElementById('detailBody')
  if (!n) { box.innerHTML = '<div class="meta">在星图里点一颗星，这里显示详情</div>'; return }
  const refs = (n.sources || []).slice(0, 8)
  box.innerHTML = '<h3 style="color:' + colorOf(n) + '">' + NAMES[n._layer] +
    (n.kind === 'summary' ? ' · 摘要' : ' · 原话') + '</h3>' +
    '<div class="meta">' +
      '时间：<b>' + fmt(tsOf(n)) + '</b><br>' +
      '通道：<b>' + (n.channel || '—') + '</b> · 说话：<b>' + (n.speaker || '—') + '</b><br>' +
      '重要度：<b>' + (n.importance ?? '—') + '</b> · 热度：<b>' + (n.heat ?? '—') + '</b><br>' +
      '牢固度：<b>' + (n.repeatStrength ?? 1) + '</b> · 融合次数：<b>' + (n.fusionCount ?? 0) + '</b> · 关注次数：<b>' + (n.recallCount ?? 0) + '</b><br>' +
      (n.lastFusedAt || n.lastRecalledAt
        ? '最近融合：<b>' + (n.lastFusedAt ? fmt(n.lastFusedAt) : '—') + '</b> · 最近关注：<b>' + (n.lastRecalledAt ? fmt(n.lastRecalledAt) : '—') + '</b><br>'
        : '') +
      'id：' + n.id +
      (n.spanFrom ? '<br>摘要跨度：<b>' + fmt(n.spanFrom) + ' ~ ' + fmt(n.spanTo || n.createdAt) + '</b>' : '') +
    '</div>' +
    '<div class="full">' + (n.text || '').replace(/</g,'&lt;') + '</div>' +
    (refs.length ? '<div class="refs">引用原文 ' + (n.sources || []).length + ' 条：' +
      refs.map(id => { const t = nodeById.get(id); return t ? '#' + t.id.slice(-6) : null }).filter(Boolean).join(' · ') +
      '（星图中已用紫线连接）</div>' : '')
}
function refreshChips() {
  const ch = document.getElementById('chCh'); ch.innerHTML = ''
  for (const [key, name] of CHANNELS) {
    const el = document.createElement('span')
    el.className = 'chip' + (chOn.has(key) ? ' on' : '')
    el.textContent = name
    el.onclick = () => { chOn.has(key) ? chOn.delete(key) : chOn.add(key); refreshChips(); renderResults(); draw() }
    ch.appendChild(el)
  }
  const kd = document.getElementById('chKind'); kd.innerHTML = ''
  for (const [key, name] of [['raw','原话'],['summary','摘要']]) {
    const el = document.createElement('span')
    el.className = 'chip' + (kindOn.has(key) ? ' on' : '')
    el.textContent = name
    el.onclick = () => { kindOn.has(key) ? kindOn.delete(key) : kindOn.add(key); refreshChips(); renderResults(); draw() }
    kd.appendChild(el)
  }
}
function renderResults() {
  const box = document.getElementById('results')
  const hits = renderSet()
  const total = filteredSorted().length
  const truncName = { imp: '重要度', time: '时间', layer: '层级' }[truncMode]
  box.innerHTML = '<div class="rstat">命中 ' + total + ' 条' +
    (hits.length < total ? ' · 按' + truncName + '截断，亮出前 ' + hits.length + ' 条' : '') +
    '（点击查看详情并定位星点）</div>'
  for (const n of hits) {
    const el = document.createElement('div')
    el.className = 'ritem' + (n.id === selId ? ' sel' : '')
    el.innerHTML = '<div class="head"><span class="ld" style="color:'+colorOf(n)+'"></span>' +
      NAMES[n._layer] + ' · ' + fmt(tsOf(n)) + (n.channel ? ' · ' + n.channel : '') + '</div>' +
      '<div class="txt">' + (n.text||'').slice(0,64).replace(/</g,'&lt;') + ((n.text||'').length>64?'…':'') + '</div>'
    el.onclick = () => selectNode(n, true)
    box.appendChild(el)
  }
}

// ── 性能设置 chips ──
function refreshPerfChips() {
  const ri = document.getElementById('renderMaxInput')
  if (ri && !ri.dataset.bound) {
    ri.dataset.bound = '1'
    ri.value = renderMax ? String(renderMax) : ''
    ri.oninput = () => {
      const v = parseInt(ri.value, 10)
      renderMax = Number.isFinite(v) && v > 0 ? v : 0
      renderResults(); draw()
    }
  }
  const tc = document.getElementById('truncChips'); tc.innerHTML = ''
  for (const [v, name] of [['imp','按重要度'],['time','按时间'],['layer','按层级']]) {
    const el = document.createElement('span')
    el.className = 'chip' + (truncMode === v ? ' on' : '')
    el.textContent = name
    el.onclick = () => { truncMode = v; refreshPerfChips(); renderResults(); draw() }
    tc.appendChild(el)
  }
  const ac = document.getElementById('autoChips'); ac.innerHTML = ''
  for (const [v, name] of [[true,'自动刷新 开'],[false,'自动刷新 关']]) {
    const el = document.createElement('span')
    el.className = 'chip' + (autoRefresh === v ? ' on' : '')
    el.textContent = name
    el.onclick = () => { autoRefresh = v; refreshPerfChips() }
    ac.appendChild(el)
  }
}

// ── 搜索：过滤 + 命中聚焦 + 自动弹结果页 ──
let focusTimer = null
function scheduleAutoFocus() { clearTimeout(focusTimer); focusTimer = setTimeout(autoFocus, 480) }
function autoFocus() {
  if (!q) return
  const hits = filteredSorted()
  if (!hits.length || hits.length > 60) return
  let cx = 0, cy = 0, cz = 0
  for (const n of hits) { cx += n.x; cy += n.y; cz += n.z }
  const L = hits.length; cx /= L; cy /= L; cz /= L
  const len = Math.hypot(cx, cy, cz) || 1
  const pose = poseToCenter(cx/len, cy/len, cz/len)
  flyTo(pose.ry, pose.rx)
  zoom = hits.length <= 12 ? 1.75 : hits.length <= 30 ? 1.4 : 1.15
  panX = 0; panY = 0
}
const qEl = document.getElementById('q')
qEl.addEventListener('input', () => { q = qEl.value.trim(); switchPage('results'); openSide(); renderResults(); draw(); scheduleAutoFocus() })
document.getElementById('goBtn').onclick = () => { q = qEl.value.trim(); switchPage('results'); openSide(); renderResults(); draw(); autoFocus() }
document.getElementById('tabResults').onclick = () => switchPage('results')
document.getElementById('tabDetail').onclick = () => switchPage('detail')
document.getElementById('backToResults').onclick = () => switchPage('results')
document.getElementById('resetBtn').onclick = () => {
  q = ''; qEl.value = ''; dFrom = null; dTo = null
  document.getElementById('dFrom').value = ''; document.getElementById('dTo').value = ''
  chOn.clear(); CHANNELS.forEach(c => chOn.add(c[0])); kindOn = new Set(['raw','summary'])
  view = 'ALL'; zoom = 1; panX = 0; panY = 0; refreshBtns(); refreshChips(); switchPage('results'); renderResults(); draw()
}
document.getElementById('dFrom').onchange = (e) => { dFrom = e.target.value ? new Date(e.target.value).getTime() : null; renderResults(); draw() }
document.getElementById('dTo').onchange = (e) => { dTo = e.target.value ? new Date(e.target.value).getTime() : null; renderResults(); draw() }

// ── 实时数据 ──
// 数据指纹：条数 + 每层末尾 id，用来判断「数据真的变了没」
function dataFingerprint(d) {
  let s = ''
  for (const k of ['L1','L2','L3','DL1','DL2','DL3']) {
    const arr = d.layers[k] || []
    s += k + ':' + arr.length + ':' + ((arr[arr.length - 1] || {}).id || '') + ';'
  }
  return s
}
let lastFp = ''
async function loadData(manual) {
  const before = lastFp
  try {
    const res = await fetch('/dsh-memory/star/data', { cache: 'no-store' })
    if (!res.ok) throw new Error(res.status)
    DATA = await res.json(); liveMode = true
  } catch { DATA = FALLBACK; liveMode = false }
  document.getElementById('modeTag').innerHTML = liveMode
    ? '<span class="mode-live">● 实时（插件内 · 30 秒自动刷新）</span>'
    : '<span class="mode-snap">● 静态快照（重跑 star.mjs 更新）</span>'
  document.getElementById('totalCount').textContent = countOfData()
  // 数据没变化 → 不重建任何 DOM（避免每 30 秒闪一下/滚动位置丢失）；首次必然重建
  const fpNow = dataFingerprint(DATA)
  if (!manual && before !== '' && fpNow === before) {
    if (!liveMode) draw()
    return
  }
  lastFp = fpNow
  // 数据有变：保留当前页与滚动位置，只重建必要部分
  const onDetail = !document.getElementById('pageDetail').hidden
  const scroll = document.getElementById('results').scrollTop
  rebuildNodes(); refreshBtns(); renderResults(); draw()
  document.getElementById('results').scrollTop = scroll
  switchPage(onDetail ? 'detail' : 'results')
  if (manual) { const b = document.getElementById('refreshBtn'); b.textContent = '✓ 已刷新'
    setTimeout(() => b.textContent = '⟳ 刷新库', 1200) }
}
const countOfData = () => Object.values(DATA.layers).reduce((s, v) => s + v.length, 0)
document.getElementById('refreshBtn').onclick = () => loadData(true)
document.getElementById('exportBtn').onclick = () => {
  const a = document.createElement('a'), d = new Date()
  a.download = '记忆星图-' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') +
    '-' + String(d.getHours()).padStart(2,'0') + String(d.getMinutes()).padStart(2,'0') + '.png'
  a.href = cv.toDataURL('image/png'); a.click()
}

// ── 沉浸模式：只留星云，ESC 或按钮退出 ──
function toggleImmersive(on) {
  const v = typeof on === 'boolean' ? on : !document.body.classList.contains('immersive')
  document.body.classList.toggle('immersive', v)
  setTimeout(() => { resize(); draw() }, 30)
}
document.getElementById('immersiveBtn').onclick = () => toggleImmersive(true)
document.getElementById('immExitBtn').onclick = () => toggleImmersive(false)
addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleImmersive(false) })

// 启动
refreshModeChips(); refreshChips(); refreshPerfChips(); loadData(false); resize(); draw()
setInterval(() => { if (autoRefresh) loadData(false) }, 30000)
</script>
</body>
</html>`.replace('__DATA__', () => payload).replace('__DIR__', () => memDirEsc)

// CLI 在 tools/star.mjs：这里只保留页面与纯数据函数，import 本身没有副作用。
