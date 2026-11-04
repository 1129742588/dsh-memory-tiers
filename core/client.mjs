/**
 * dsh-memory-tiers · 配置页（客户端半边）
 *
 * DSH「设置 → 记忆」里的一个 section。宿主给我们：
 *   window.__ModuleLoader__.load({ id, factory })   id 必须等于包名
 *   require('react')
 *   ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id, order, label }, Component))
 *
 * ★ 页面里**没有**字段清单：分组、标签、说明、类型、范围、显示条件全部来自
 *   GET /dsh-memory/api/config 返回的 schema。服务端加一个配置项，页面自动出现，
 *   不会再出现「页面写了、服务端不认」或者「服务端认、页面没这格」。
 *
 * 数据流：section ⇄ /dsh-memory/api/* ⇄ <DSH_HOME>/memory-tiers/config.json
 *        保存写文件；重载插件后生效（页面上写清楚了）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-tiers',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const API = '/dsh-memory/api'
    const CSS_TAG = 'dsh-memory-tiers/section.css'
    const POLL_MS = 5000

    const CSS = [
      '.dmt{max-width:780px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}',
      '.dmt-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dmt-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}',
      '.dmt-group{margin-top:16px;font-size:13px;font-weight:500;line-height:20px}',
      '.dmt-rows{display:flex;flex-direction:column}',
      '.dmt-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.dmt-row:last-child{border-bottom:none}',
      '.dmt-row>div:first-child{flex:1;min-width:200px}',
      '.dmt-label{font-size:13px;line-height:19px}',
      '.dmt-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}',
      '.dmt-input,.dmt-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:180px;outline:none}',
      '.dmt-input:focus-visible,.dmt-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
      '.dmt-input.dmt-wide{min-width:300px}',
      '.dmt-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}',
      '.dmt-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dmt-btn{height:28px;padding:0 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer}',
      '.dmt-btn:hover{border-color:var(--dsw-alias-border-l1)}',
      '.dmt-btn.dmt-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.dmt-btn:disabled{opacity:.5;cursor:default}',
      '.dmt-msg{font-size:12.5px;line-height:18px;white-space:pre-wrap}',
      '.dmt-ok{color:var(--dsw-alias-label-success,#3b6d11)}',
      '.dmt-warn{color:var(--dsw-alias-label-warning,#854f0b)}',
      '.dmt-err{color:var(--dsw-alias-label-danger,#a32d2d)}',
      '.dmt-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12.5px}',
      '.dmt-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);font-size:11.5px;padding:4px 8px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2))}',
      '.dmt-table td{padding:5px 8px 5px 0;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.12));vertical-align:top}',
      '.dmt-num{text-align:right;font-family:var(--dsw-font-mono,ui-monospace,monospace);white-space:nowrap}',
      '.dmt-tag{margin-left:6px;padding:0 5px;border-radius:4px;font-size:10.5px;background:var(--dsw-alias-bg-tertiary,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary)}',
      '.dmt-log{margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.06));font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto}',
      '.dmt-mono{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11.5px;word-break:break-all}',
      '.dmt-kv{display:flex;gap:18px;flex-wrap:wrap;margin-top:8px}',
      '.dmt-kv div{min-width:96px}',
      '.dmt-kv b{display:block;font-size:15px;font-weight:500;line-height:22px}',
      '.dmt-kv span{color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
      '.dmt-stage{display:flex;align-items:baseline;gap:8px;padding:4px 0;font-size:12.5px;flex-wrap:wrap}',
      '.dmt-stage b{font-weight:500;min-width:34px}',
      '.dmt-stage .dmt-tag{margin-left:0}',
      '.dmt-stage-model{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11.5px;word-break:break-all}',
      '.dmt-bad{background:var(--dsw-alias-label-danger,#a32d2d);color:#fff}',
      '.dmt-pending{margin-left:6px;padding:0 5px;border-radius:4px;font-size:10.5px;background:var(--dsw-alias-label-warning,#854f0b);color:#fff}',
      '.dmt-textarea{min-height:88px;height:auto;padding:8px;line-height:18px;resize:vertical;font-family:inherit}',
      '.dmt-mode{position:relative;display:inline-flex;align-items:center}',
      '.dmt-badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:99px;border:1px solid transparent;font-size:11px;line-height:1;cursor:pointer;user-select:none;white-space:nowrap}',
      '.dmt-badge-work{background:rgba(180,120,20,.16);border-color:rgba(180,120,20,.55);color:var(--dsw-alias-label-warning,#b47814)}',
      '.dmt-badge-exempt{background:transparent;border-color:rgba(180,120,20,.55);color:var(--dsw-alias-label-warning,#b47814)}',
      '.dmt-badge-takeover{background:rgba(59,109,17,.14);border-color:rgba(59,109,17,.45);color:var(--dsw-alias-label-success,#3b6d11)}',
      '.dmt-badge-plain{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
      '.dmt-pop{position:absolute;right:0;bottom:28px;z-index:50;width:270px;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,#fff);box-shadow:0 10px 32px rgba(0,0,0,.35);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.dmt-pop p{margin:0 0 8px}',
      '.dmt-pop .dmt-actions{margin-top:8px;padding-top:8px}',
      '.dmt-danger{color:var(--dsw-alias-label-danger,#a32d2d)}',
      '.dmt-btn.dmt-danger-btn{border-color:rgba(163,45,45,.55);color:var(--dsw-alias-label-danger,#a32d2d)}',
      // ── 主界面星图（shell.overlay 浮层）──
      // 注意：宿主浮层容器是 pointer-events:none + 仅直接子元素放行，
      // 且 Windows 标题栏是 app-region:drag 拖拽区——这里必须显式 pointer-events:auto
      // 和 no-drag，否则按钮进标题栏区域后点击全被窗口拖拽吃掉。
      '.dmt-star-fab{position:fixed;left:8px;top:calc(50% + 20px);transform:translateY(-50%);z-index:60;width:30px;height:30px;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#9aa7b8);font-size:14px;line-height:28px;cursor:pointer;opacity:.45;transition:opacity .15s;pointer-events:auto;-webkit-app-region:no-drag}',
      '.dmt-star-fab:hover{opacity:1}',
      // ★ 面板必须避开 dsh 标题栏：顶部菜单和窗口三钮（最小化/最大化/关闭）都在那里，
      //   且 z 层比浮层高。用宿主自己的 --dsh-windows-titlebar-height 变量往下让位。
      '.dmt-star-mask{position:fixed;inset:0;z-index:2000;display:flex;align-items:stretch;justify-content:center;background:rgba(0,0,0,.55);pointer-events:auto;-webkit-app-region:no-drag;padding:calc(var(--dsh-windows-titlebar-height, 40px) + 2px) 0 0}',
      '.dmt-star-panel{display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;border:0;background:#0b1020}',
      // ★ 顶栏用星图同款深色（星云页是纯黑背景，主题色白顶会突兀）；
      //   关闭按钮通栏等高贴右上角，和窗口控制钮一个视觉逻辑。
      '.dmt-star-head{display:flex;align-items:stretch;gap:10px;height:36px;padding:0 0 0 12px;border-bottom:1px solid #1c2c4a;background:#0b1020;flex:none}',
      '.dmt-star-title{font-size:13px;font-weight:500;color:#e3eeff;white-space:nowrap;flex:none;align-self:center}',
      '.dmt-star-center{flex:1;min-width:0;text-align:center;font-size:11px;color:#5c7295;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;align-self:center}',
      '.dmt-star-center .dmt-star-url{user-select:all;color:#7d95bd}',
      '.dmt-star-headbtn{padding:2px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}',
      '.dmt-star-headbtn:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}',
      '.dmt-star-head .dmt-hint{color:#5c7295;align-self:center;flex:none}',
      '.dmt-star-close{border:0;border-left:1px solid #1c2c4a;background:#0b1020;color:#e3eeff;font-size:12px;padding:0 16px;cursor:pointer;white-space:nowrap}',
      '.dmt-star-close:hover{background:#16233f}',
      '.dmt-star-frame{flex:1;width:100%;border:0;background:#0b1020}',
    ].join('\n')

    function ensureCss() {
      if (typeof document === 'undefined') return null
      const old = document.querySelector('style[data-dmt="' + CSS_TAG + '"]')
      if (old) return null
      const el = document.createElement('style')
      el.dataset.dmt = CSS_TAG
      el.textContent = CSS
      document.head.appendChild(el)
      return el
    }

    const getPath = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

    const setPath = (obj, path, value) => {
      const keys = String(path).split('.')
      const next = { ...obj }
      let cur = next
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]
        cur[k] = cur[k] && typeof cur[k] === 'object' ? { ...cur[k] } : {}
        cur = cur[k]
      }
      cur[keys[keys.length - 1]] = value
      return next
    }

    async function api(path, init) {
      const res = await fetch(API + path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      const text = await res.text()
      let data
      try { data = JSON.parse(text) } catch { data = { ok: false, error: text.slice(0, 200) } }
      if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status)
      return data
    }

    function visible(field, cfg) {
      if (!field.showIf) return true
      return getPath(cfg, field.showIf.path) === field.showIf.eq
    }

    function Field({ field, value, onChange, pending }) {
      const id = 'dmt-' + field.path.replace(/\./g, '-')
      let control
      if (field.type === 'boolean') {
        control = h('input', {
          id, className: 'dmt-check', type: 'checkbox',
          checked: value === true, onChange: (e) => onChange(e.target.checked),
        })
      } else if (field.type === 'select') {
        control = h('select', {
          id, className: 'dmt-select', value: value ?? '',
          onChange: (e) => onChange(e.target.value),
        }, (field.options || []).map((o) => h('option', { key: o.value, value: o.value }, o.label)))
      } else if (field.type === 'textarea') {
        control = h('textarea', {
          id,
          className: 'dmt-input dmt-wide dmt-textarea',
          rows: 4,
          value: value === undefined || value === null ? '' : String(value),
          onChange: (e) => onChange(e.target.value),
        })
      } else {
        const isNum = field.type === 'number'
        const isPwd = field.type === 'password'
        control = h('input', {
          id,
          className: 'dmt-input' + (field.wide ? ' dmt-wide' : ''),
          type: isNum ? 'number' : isPwd ? 'password' : 'text',
          // 数字留空 = 不修改（服务端会把空串当「没填」），所以这里不能用 0 兜底
          value: value === undefined || value === null ? '' : String(value),
          placeholder: isPwd
            ? (value === null ? '已设置（留空不改）' : '未设置')
            : '',
          ...(isNum && field.min !== undefined ? { min: field.min } : {}),
          ...(isNum && field.max !== undefined ? { max: field.max } : {}),
          ...(isNum && field.step !== undefined ? { step: field.step } : {}),
          onChange: (e) => {
            const raw = e.target.value
            if (!isNum) return onChange(raw)
            if (raw === '') return onChange('')
            const n = Number(raw)
            onChange(Number.isFinite(n) ? n : raw)
          },
        })
      }
      return h('div', { className: 'dmt-row' },
        h('div', null,
          h('label', { className: 'dmt-label', htmlFor: id }, field.label,
            field.reload && !pending ? h('span', { className: 'dmt-tag', title: '保存后需重载插件才生效' }, '需重载') : null,
            pending ? h('span', { className: 'dmt-pending', title: '文件已改，重载插件 后才生效' }, '待重载') : null),
          field.hint ? h('div', { className: 'dmt-hint' }, field.hint) : null,
        ),
        control,
      )
    }

    const LAYER_INFO = [
      ['L1', '即时', true],
      ['L2', '巩固', true],
      ['L3', '长期（视图）', true],
      ['DL1', '深层·遗忘中', false],
      ['DL2', '原文库', false],
      ['DL3', '摘要库', false],
    ]

    /**
     * 输入框旁的会话记忆模式标记（给人看，不写给模型）。
     * 状态与后端 resolveSessionMode 完全同源：工作模式 / 已豁免 / 记忆接管 / 普通。
     */
    function ModeBadge({ sessionId }) {
      const [info, setInfo] = useState(null)
      const [open, setOpen] = useState(false)
      const [askClear, setAskClear] = useState(false)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')

      const load = useCallback(async () => {
        if (!sessionId) return
        try { setInfo(await api('/session?sessionId=' + encodeURIComponent(sessionId))) } catch { /* 标记拿不到不影响对话 */ }
      }, [sessionId])

      useEffect(() => {
        load()
        const timer = setInterval(load, 8000)
        return () => clearInterval(timer)
      }, [load])

      if (!sessionId || !info) return null
      const kind = info.mode === 'work' ? 'work'
        : info.mode === 'exempt' ? 'exempt'
          : info.label === '记忆接管' ? 'takeover' : 'plain'
      const tone = kind === 'work' ? 'dmt-badge-work'
        : kind === 'exempt' ? 'dmt-badge-exempt'
          : kind === 'takeover' ? 'dmt-badge-takeover' : 'dmt-badge-plain'

      const act = async (action, confirm) => {
        setBusy(action)
        setErr('')
        try {
          const r = await api('/session', {
            method: 'POST',
            body: JSON.stringify({ sessionId, action, ...(confirm ? { confirm: true } : {}) }),
          })
          setInfo(r)
          setAskClear(false)
          setOpen(false)
        } catch (e) { setErr(String(e.message || e)) } finally { setBusy('') }
      }

      const pop = open ? h('div', { className: 'dmt-pop' },
        h('p', null, '当前会话：', h('b', null, info.label)),
        h('p', { className: 'dmt-hint' },
          info.mode === 'work'
            ? '工作模式：不注入记忆、不压缩历史，记忆照常记录（粗骨架）。'
            : info.mode === 'exempt'
              ? '这个会话开过工作模式且对话过，已永久保留历史、不再被记忆接管；即使关掉工作模式也不会恢复压缩。'
              : info.label === '记忆接管'
                ? '记忆接管：每轮注入记忆块，并用记忆替代对话历史。'
                : '普通：注入或历史接管至少有一项被配置关掉，记忆不接管这个会话。'),
        h('div', { className: 'dmt-actions' },
          info.mode === 'work'
            ? h('button', { className: 'dmt-btn', disabled: !!busy, onClick: () => act('work-off') }, busy === 'work-off' ? '切换中…' : '关闭工作模式')
            : h('button', { className: 'dmt-btn', disabled: !!busy, onClick: () => act('work-on') }, busy === 'work-on' ? '切换中…' : '开启工作模式'),
          h('button', { className: 'dmt-btn', onClick: () => setOpen(false) }, '关闭'),
        ),
        info.mode === 'exempt'
          ? (askClear
            ? h('div', null,
              h('p', { className: 'dmt-danger' },
                '解除后该会话会恢复记忆接管：下一轮可能把现有历史压缩成一条占位，历史可能被压到 0。原文仍会先归档进 L1，但界面上不再可见。'),
              h('div', { className: 'dmt-actions' },
                h('button', { className: 'dmt-btn dmt-danger-btn', disabled: !!busy, onClick: () => act('clear-exemption', true) },
                  busy === 'clear-exemption' ? '解除中…' : '确认解除'),
                h('button', { className: 'dmt-btn', onClick: () => setAskClear(false) }, '取消'),
              ))
            : h('div', { className: 'dmt-actions' },
              h('button', { className: 'dmt-btn dmt-danger-btn', onClick: () => setAskClear(true) }, '解除接管豁免…')))
          : null,
        err ? h('p', { className: 'dmt-danger' }, err) : null,
      ) : null

      return h('span', { className: 'dmt-mode' },
        h('span', {
          className: 'dmt-badge ' + tone,
          role: 'button',
          tabIndex: 0,
          title: '会话记忆模式：点击查看/切换',
          onClick: () => { setOpen((v) => !v); setAskClear(false) },
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } },
        }, (info.mode === 'work' ? '● ' : '') + info.label),
        pop,
      )
    }

    function MemorySection() {
      const [cfg, setCfg] = useState(null)
      const [schema, setSchema] = useState([])
      const [groups, setGroups] = useState([])
      const [secrets, setSecrets] = useState({})
      const [paths, setPaths] = useState(null)
      const [meta, setMeta] = useState(null)      // config 接口里的 status/run
      const [state, setState] = useState(null)    // state 接口
      const [sessions, setSessions] = useState([]) // 会话模式/豁免名单
      const [confirmClear, setConfirmClear] = useState('') // 二次确认要解除的会话
      const [pendingRestart, setPendingRestart] = useState([])  // 改了但还没重载的字段
      const [logs, setLogs] = useState([])
      const [showLog, setShowLog] = useState(false)
      // ★ 星图不要用 window.open：dsh 是 Electron，没有 setWindowOpenHandler 时
      //   弹窗被静默拦截（点了完全没反应，连报错都没有）。改成页内 iframe，
      //   同源、不依赖宿主放行、也不打断当前设置页。
      const [showStar, setShowStar] = useState(false)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)
      const [err, setErr] = useState(null)
      const styleRef = useRef(null)

      const load = useCallback(async () => {
        try {
          const d = await api('/config')
          setCfg(d.config || {})
          setSchema(d.schema || [])
          setGroups(d.groups || [])
          setSecrets(d.hasSecrets || {})
          setPaths(d.paths || null)
          setPendingRestart(Array.isArray(d.pendingRestart) ? d.pendingRestart : [])
          setMeta({ status: d.status, run: d.run })
          setErr(null)
        } catch (e) {
          setErr(String(e.message || e))
        }
      }, [])

      const loadState = useCallback(async () => {
        try { setState(await api('/state')) } catch { /* 状态拿不到不影响改配置 */ }
      }, [])

      const loadSessions = useCallback(async () => {
        try {
          const d = await api('/sessions')
          setSessions(Array.isArray(d.sessions) ? d.sessions : [])
        } catch { /* 会话名单拿不到不影响改配置 */ }
      }, [])

      const clearExemption = async (sid) => {
        setBusy('clear-exempt')
        setErr(null)
        try {
          await api('/session', {
            method: 'POST',
            body: JSON.stringify({ sessionId: sid, action: 'clear-exemption', confirm: true }),
          })
          setConfirmClear('')
          setMsg({ kind: 'ok', text: '已解除该会话的接管豁免：下一轮起恢复记忆接管。' })
          await loadSessions()
          await loadState()
        } catch (e) {
          setErr('解除失败：' + String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const loadLog = useCallback(async () => {
        try {
          const l = await api('/log')
          setLogs(l.lines || [])
        } catch { setLogs([]) }
      }, [])

      useEffect(() => {
        styleRef.current = ensureCss()
        load()
        loadState()
        loadSessions()
        const timer = setInterval(() => { loadState(); loadSessions() }, POLL_MS)
        return () => {
          clearInterval(timer)
          if (styleRef.current) { try { styleRef.current.remove() } catch { /* 已移除 */ } }
        }
      }, [load, loadState, loadSessions])

      const setField = (path, value) => {
        setCfg((cur) => setPath(cur || {}, path, value))
        setMsg(null)
      }

      const save = async () => {
        setBusy('save')
        setMsg(null)
        setErr(null)
        try {
          const r = await api('/config', { method: 'POST', body: JSON.stringify({ config: cfg }) })
          const changed = r.changed || []
          const applied = r.applied || []
          const needReload = r.needReload || []
          const bad = r.errors || []
          const warn = r.warnings || []
          if (r.applyError) {
            setMsg({ kind: 'warn', text: `已保存，但就地生效失败：${r.applyError}\n重载插件后按新配置运行。` })
          } else if (needReload.length && applied.length) {
            setMsg({
              kind: 'ok',
              text: `已保存。\n立即生效：${applied.join('、')}\n需重载插件：${needReload.join('、')}`,
            })
          } else if (needReload.length) {
            setMsg({ kind: 'ok', text: `已保存：${needReload.join('、')}\n这些项需重载插件后生效。` })
          } else if (applied.length) {
            setMsg({ kind: 'ok', text: `已保存并立即生效：${applied.join('、')}` })
          } else if (!bad.length && !warn.length) {
            setMsg({ kind: 'warn', text: '没有改动。' })
          } else {
            setMsg(null)
          }
          if (bad.length) setErr('这几项没存进去：\n' + bad.map((e) => `- ${e.path}：${e.error}`).join('\n'))
          if (warn.length && !r.applyError) setMsg({ kind: 'warn', text: warn.map((w) => `⚠ ${w.path}：${w.error}`).join('\n') })
          await load()
          await loadState()
          await loadSessions()
        } catch (e) {
          setErr('保存失败：' + String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const organize = async () => {
        setBusy('organize')
        setMsg(null)
        setErr(null)
        try {
          const r = await api('/organize', { method: 'POST', body: '{}' })
          const x = r.result || {}
          setMsg({
            kind: x.ok ? 'ok' : 'warn',
            text: x.ok
              ? `已整理：L1 搬走 ${x.l1Moved} 条，L2 搬走 ${x.l2Moved} 条，L3 视图 ${x.l3} 条，用时 ${x.elapsedMs}ms`
              : `没整理：${x.skipped || x.error || '未知原因'}`,
          })
          await loadState()
          if (showLog) await loadLog()
        } catch (e) {
          setErr('整理失败：' + String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      if (err && !cfg) {
        return h('div', { className: 'dmt' },
          h('h3', { className: 'dmt-title' }, '记忆'),
          h('div', { className: 'dmt-msg dmt-err' }, '读取配置失败：' + err),
          h('div', { className: 'dmt-actions' },
            h('button', { className: 'dmt-btn', onClick: load }, '重试'),
            paths ? h('span', { className: 'dmt-mono' }, paths.config) : null),
        )
      }
      if (!cfg) return h('div', { className: 'dmt' }, h('div', { className: 'dmt-hint' }, '加载中…'))

      const run = state || meta?.run || {}
      const caps = run.capabilities || {}
      const bootErrors = (run.boot?.errors || []).concat(meta?.status?.errors || [])
      const counts = run.layers?.count || {}
      const chars = run.layers?.chars || {}
      const needsRestart = (meta?.status?.repaired || meta?.status?.migrated || meta?.status?.created)
      const pending = pendingRestart || []
      const ignoredKeys = meta?.status?.ignored || []
      const stages = run.stages || {}
      const wm = run.workMode || {}
      const compactionOn = run.config?.compaction?.enabled !== false
      const keepTurns = Number(run.config?.compaction?.keepTurns) || 0
      const injectText = run.injection?.mode === 'context' ? '每轮'
        : run.injection?.mode === 'section' ? '每轮（旧接口）'
          : run.injection?.reason === 'work-mode' ? '关（工作模式）'
            : run.injection?.mode === 'off' ? '关' : '没挂上'
      const STAGES = [
        ['summary', '分流', '挑哪些写摘要、哪些留原文、哪些下沉'],
        ['chat', '融合', '分类 + 判重复/矛盾/进展'],
        ['embed', '嵌入', '向量检索'],
        ['rerank', '精排', '检索结果重排'],
      ]
      const sourceTag = (s) => (s?.source === 'session' ? '会话' : s?.source === 'api' ? 'API' : '—')
      const stageModel = (s) => (s?.source === 'session'
        ? (s.sessionModel || '（会话模型不可用）')
        : (s?.model || '（未配置）'))

      return h('div', { className: 'dmt' },
        h('h3', { className: 'dmt-title' }, '记忆'),
        h('div', { className: 'dmt-intro' },
          '六层本地记忆：L1 即时 / L2 巩固 / L3 长期（视图）/ DL1 遗忘中 / DL2 原文库 / DL3 摘要库。'
          + (compactionOn
            ? (keepTurns === 0
              ? '当前用记忆完全替代对话历史（模型只看得到记忆块）。'
              : `当前保留最近 ${keepTurns} 轮原文，其余归档进记忆。`)
            : '当前不替换对话历史。')
          + (pending.length ? '（文件已改，重载插件后生效）' : '')),

        // ── 模型阶段（实际生效）──
        h('div', { className: 'dmt-group' }, '模型与阶段（实际生效）'),
        h('div', null, STAGES.map(([k, label, desc]) => h('div', { key: k, className: 'dmt-stage' },
          h('b', null, label),
          h('span', { className: 'dmt-tag' }, sourceTag(stages[k])),
          h('span', { className: 'dmt-stage-model' }, stageModel(stages[k])),
          stages[k] && !stages[k].ready ? h('span', { className: 'dmt-tag dmt-bad' }, '不可用') : null,
          h('span', { className: 'dmt-hint' }, desc),
        ))),
        run.session?.model
          ? h('div', { className: 'dmt-hint' },
            `当前会话模型：${run.session.model}${run.session.provider ? `（${run.session.provider}）` : ''}`
            + '（只是「跟随当前对话模型」时的来源，不代表分流/融合一定用它）')
          : null,
        wm.enabled
          ? h('div', { className: 'dmt-msg dmt-warn', style: { marginTop: '6px' } },
            '工作模式：开启 —— 不注入记忆、不压缩历史；照常记录与整理，容量按工作模式那组配置。')
          : null,

        // ── 运行状态 ──
        h('div', { className: 'dmt-group' }, '现在怎么样（只读）'),
        h('div', { className: 'dmt-kv' },
          h('div', null, h('b', null, String(run.pending ?? '—')), h('span', null, '待整理条数')),
          h('div', null, h('b', null, String(run.vectors ?? '—')), h('span', null, '向量条数')),
          h('div', null, h('b', null, run.lock?.held ? '整理中' : '空闲'), h('span', null, '整理锁')),
          h('div', null, h('b', null, caps.embed ? '可用' : '关闭'), h('span', null, '语义检索')),
          h('div', null, h('b', null, caps.embedModel || '—'), h('span', null, '嵌入模型')),
          h('div', null, h('b', null, injectText), h('span', null, '注入记忆')),
          h('div', null, h('b', null, compactionOn ? '开' : '关'), h('span', null, '替代历史')),
        ),
        h('table', { className: 'dmt-table' },
          h('thead', null, h('tr', null,
            h('th', null, '层'), h('th', null, '说明'), h('th', { className: 'dmt-num' }, '条数'),
            h('th', { className: 'dmt-num' }, '字数'), h('th', null, '进上下文'))),
          h('tbody', null, LAYER_INFO.map(([k, name, inCtx]) => h('tr', { key: k },
            h('td', { className: 'dmt-mono' }, k),
            h('td', null, name),
            h('td', { className: 'dmt-num' }, String(counts[k] ?? '—')),
            h('td', { className: 'dmt-num' }, chars[k] === undefined ? '—' : chars[k].toLocaleString()),
            h('td', null, inCtx ? h('span', { className: 'dmt-tag' }, '是') : '—'),
          )))),
        h('div', { className: 'dmt-hint', style: { marginTop: '6px' } },
          '注入：' + (run.injection?.mode === 'context' ? '已挂上（每轮更新）'
            : run.injection?.mode === 'section' ? '已挂上（旧接口）'
              : run.injection?.mode === 'off' ? (run.injection?.reason === 'work-mode' ? '工作模式：关闭' : '已关闭') : '没挂上')
          + ' · 自动记录：' + (run.config?.capture === false ? '关闭' : '开启')
          + (run.last?.at ? ` · 上次整理 ${new Date(run.last.at).toLocaleString('zh-CN')}` : '')),
        h('div', { className: 'dmt-hint' },
          '配置：', h('span', { className: 'dmt-mono' }, paths?.config || '—')),
        h('div', { className: 'dmt-hint' },
          '记忆库：', h('span', { className: 'dmt-mono' }, paths?.data || run.dataDir || '—')),

        pending.length
          ? h('div', { className: 'dmt-msg dmt-warn', 'aria-live': 'polite', style: { marginTop: '8px' } },
            `有 ${pending.length} 项改动待重载插件生效：` + pending.slice(0, 6).join('、') + (pending.length > 6 ? ' …' : ''))
          : null,
        ignoredKeys.length
          ? h('div', { className: 'dmt-hint', style: { marginTop: '4px' } },
            '文件里已废弃/未知的键（不生效）：' + ignoredKeys.join('、'))
          : null,
        bootErrors.length
          ? h('div', { className: 'dmt-msg dmt-err', 'aria-live': 'polite', style: { marginTop: '8px' } },
            '装载时有 ' + bootErrors.length + ' 个问题：\n' + bootErrors.map((e) => `- ${e.step}：${e.error}`).join('\n'))
          : null,
        needsRestart
          ? h('div', { className: 'dmt-msg dmt-warn', style: { marginTop: '6px' } },
            '配置文件刚刚被生成/补齐/迁移过，重载插件 后按新配置运行。')
          : null,

        // ── 配置字段（全部来自服务端 schema）──
        ...groups.map((g) => h('div', { key: g },
          h('div', { className: 'dmt-group' }, g),
          h('div', { className: 'dmt-rows' },
            schema.filter((f) => f.group === g && visible(f, cfg)).map((f) => h(Field, {
              key: f.path,
              field: f,
              value: getPath(cfg, f.path),
              pending: pending.includes(f.path),
              onChange: (v) => setField(f.path, v),
            })),
          ),
        )),

        // ── 会话模式 / 接管豁免名单 ──
        h('div', { className: 'dmt-group' }, '会话模式与接管豁免'),
        sessions.length
          ? h('table', { className: 'dmt-table' },
            h('thead', null, h('tr', null,
              h('th', null, '会话'), h('th', null, '轮次'), h('th', null, '状态'), h('th', null, '最后活跃'), h('th', null, ''))),
            h('tbody', null, sessions.map((s) => h('tr', { key: s.sessionId },
              h('td', { className: 'dmt-mono' }, String(s.sessionId).slice(0, 18)),
              h('td', { className: 'dmt-num' }, String(s.turns ?? 0)),
              h('td', null, h('span', { className: 'dmt-tag' }, s.label)),
              h('td', { className: 'dmt-mono' }, s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleString('zh-CN') : '—'),
              h('td', null, s.exempt
                ? (confirmClear === s.sessionId
                  ? h('span', null,
                    h('span', { className: 'dmt-hint dmt-danger' }, '恢复接管可能把历史压到 0；原文仍会先归档。'),
                    h('button', { className: 'dmt-btn dmt-danger-btn', disabled: !!busy, onClick: () => clearExemption(s.sessionId) }, '确认解除'),
                    h('button', { className: 'dmt-btn', onClick: () => setConfirmClear('') }, '取消'))
                  : h('button', { className: 'dmt-btn dmt-danger-btn', onClick: () => setConfirmClear(s.sessionId) }, '解除豁免…'))
                : null),
            ))),
          )
          : h('div', { className: 'dmt-hint' }, '还没有记录过工作模式会话。开启工作模式并对话后，这里会出现豁免名单。'),

        // ── 操作 ──
        h('div', { className: 'dmt-actions' },
          h('button', { className: 'dmt-btn dmt-primary', onClick: save, disabled: !!busy },
            busy === 'save' ? '保存中…' : '保存'),
          h('button', { className: 'dmt-btn', onClick: load, disabled: !!busy }, '重新读取'),
          h('button', { className: 'dmt-btn', onClick: organize, disabled: !!busy },
            busy === 'organize' ? '整理中…' : '立即整理'),
          h('button', {
            className: 'dmt-btn',
            onClick: () => { if (overlayOk) starBus.set(true); else setShowStar((v) => !v) },
          }, overlayOk ? '记忆星图（主界面）' : (showStar ? '收起星图' : '记忆星图')),
          h('button', {
            className: 'dmt-btn',
            onClick: () => { setShowLog((v) => !v); if (!showLog) loadLog() },
          }, showLog ? '收起日志' : '看日志'),
        ),

        msg ? h('div', { className: 'dmt-msg ' + (msg.kind === 'ok' ? 'dmt-ok' : 'dmt-warn'), 'aria-live': 'polite' }, msg.text) : null,
        err && cfg ? h('div', { className: 'dmt-msg dmt-err', 'aria-live': 'polite' }, err) : null,

        showStar
          ? h('div', { style: { marginTop: '10px' } },
            h('iframe', {
              src: '/dsh-memory/star',
              title: '记忆星图',
              style: {
                width: '100%', height: '72vh', border: '0',
                borderRadius: '8px', background: '#0b1020',
              },
            }),
            h('div', { className: 'dmt-hint', style: { marginTop: '4px' } },
              // 注意不能用 location.origin：dsh 内嵌页是 dsh-app://app，粘到浏览器进不去。
              // 真实外链是服务端补写的 http://127.0.0.1:端口/dsh-memory/star
              '想看全屏：把这段地址粘到浏览器打开 —— ' + (state?.star?.url || '（重载插件后可从浮层标题栏复制）')))
          : null,

        showLog
          ? h('div', null,
            h('div', { className: 'dmt-log' }, logs.length ? logs.slice(-20).join('\n') : '（没有日志）'),
            h('div', { className: 'dmt-hint', style: { marginTop: '4px' } },
              `数据来源：${paths?.config ? paths.config.replace(/config\.json$/, 'log.txt') : 'log.txt'} 的最后 20 行`))
          : null,
      )
    }

    // ── 主界面星图浮层（shell.overlay）──
    // 设置页的 iframe 太憋屈，星图在主界面左侧留一颗悬浮钮，点开是近全屏浮层。
    // shell.overlay 是根作用域的 list 插槽（官方文档：需要浮层且位置已知时用它），
    // 旧宿主没有该插槽时注入会抛错，由 apply 里 try/catch 兜底回设置页内嵌。
    const starBus = {
      open: false,
      subs: new Set(),
      set(v) { this.open = v; for (const f of this.subs) f(v) },
    }
    let overlayOk = false  // shell.overlay 是否注册成功；设置页按钮据此走浮层还是页内 iframe

    function StarOverlay() {
      const [open, setOpen] = useState(starBus.open)
      const [url, setUrl] = useState('')
      useEffect(() => {
        ensureCss()  // ★ 浮层独立于设置页挂载，样式必须自己保证；否则按钮裸奔到左上角标题栏拖拽区里，点了没反应
        const f = (v) => setOpen(v)
        starBus.subs.add(f)
        return () => { starBus.subs.delete(f) }
      }, [])
      // 拿真实的外链地址（http://127.0.0.1:端口/...），status.json 里的 star.url 由服务端补写
      useEffect(() => {
        if (!open || url) return
        fetch(API + '/state').then((r) => r.json()).then((s) => {
          const u = s && s.star && s.star.url
          if (u) setUrl(u)
        }).catch(() => {})
      }, [open, url])
      // Esc 退出：全屏面板没有明显的窗口边缘，键盘逃生口必须有
      useEffect(() => {
        if (!open) return
        const onKey = (e) => { if (e.key === 'Escape') starBus.set(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])
      if (!open) {
        // 顶栏按钮注册成功时左侧悬浮钮就不需要了，避免两个入口重复
        return headerOk ? null : h('button', {
          className: 'dmt-star-fab',
          title: '记忆星图',
          onClick: () => starBus.set(true),
        }, '✦')
      }
      return h('div', {
        className: 'dmt-star-mask',
        onClick: (e) => { if (e.target === e.currentTarget) starBus.set(false) },
      },
        h('div', { className: 'dmt-star-panel' },
          h('div', { className: 'dmt-star-head' },
            h('span', { className: 'dmt-star-title' }, '✦ 记忆星图'),
            h('span', { className: 'dmt-star-center' },
              '打开浏览器输入 ',
              h('span', { className: 'dmt-star-url' }, url || '…'),
              ' 也可观看'),
            h('span', { className: 'dmt-hint' }, 'Esc 退出'),
            h('button', { className: 'dmt-star-close', onClick: () => starBus.set(false) }, '✕ 关闭')),
          h('iframe', {
            className: 'dmt-star-frame', src: '/dsh-memory/star', title: '记忆星图',
            // ★ 焦点在 iframe 里时主窗口收不到键盘事件，同源往里面也挂一份。
            //   必须用捕获阶段：星图页自己的 Esc（bubble）负责退沉浸，先退了沉浸
            //   body.immersive 就没了，我们分不清「它刚处理过」。捕获先跑、
            //   此刻沉浸还在 → 直接放行让它处理；不在沉浸 → 我们关面板。
            onLoad: (e) => {
              try {
                const w = e.target.contentWindow
                w.addEventListener('keydown', (ev) => {
                  if (ev.key !== 'Escape' || ev.defaultPrevented) return
                  let immersive = false
                  try { immersive = !!w.document.body.classList.contains('immersive') } catch { /* 拿不到就当不在沉浸 */ }
                  if (!immersive) starBus.set(false)
                }, true)
              } catch { /* 万一跨域就只靠按钮退出 */ }
            },
          }),
        ))
    }

    // 顶栏里的星图入口：conversation.session.header.actions 是会话顶栏的 list 插槽，
    // 作业按钮（job-list）就在这里。旧宿主没有时由 try/catch 兜底回左侧悬浮钮。
    let headerOk = false
    function HeaderStarButton() {
      return h('button', {
        className: 'dmt-star-headbtn',
        title: '记忆星图',
        onClick: () => starBus.set(true),
      }, '✦ 记忆星图')
    }

    const inject = ['slots']
    const NS = 'memory-tiers'

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: NS, order: 7, label: () => '记忆' },
        MemorySection,
      ), 'memory-tiers: settings section'), 'memory-tiers: settings section')

      // 输入框旁的模式标记；旧版宿主没有这个 slot 时只少标记，绝不能拖垮设置页。
      try {
        ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'memory-mode', order: 40 },
          ModeBadge,
        ), 'memory-tiers: conversation mode badge'), 'memory-tiers: conversation mode badge')
      } catch { /* 旧版没有该 slot：设置页里仍有会话表 */ }

      // 主界面星图浮层；注册失败（旧宿主无 shell.overlay）时设置页按钮退回页内 iframe。
      try {
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'memory-star', order: 90 },
          StarOverlay,
        ), 'memory-tiers: star overlay'), 'memory-tiers: star overlay')
        overlayOk = true
      } catch { overlayOk = false }

      // 会话顶栏的星图按钮（挨着「作业」等按钮）；失败时 StarOverlay 保留左侧悬浮钮。
      try {
        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'memory-star', order: 45 },
          HeaderStarButton,
        ), 'memory-tiers: star header button'), 'memory-tiers: star header button')
        headerOk = true
      } catch { headerOk = false }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
