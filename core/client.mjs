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

    function MemorySection() {
      const [cfg, setCfg] = useState(null)
      const [schema, setSchema] = useState([])
      const [groups, setGroups] = useState([])
      const [secrets, setSecrets] = useState({})
      const [paths, setPaths] = useState(null)
      const [meta, setMeta] = useState(null)      // config 接口里的 status/run
      const [state, setState] = useState(null)    // state 接口
      const [pendingRestart, setPendingRestart] = useState([])  // 改了但还没重载的字段
      const [logs, setLogs] = useState([])
      const [showLog, setShowLog] = useState(false)
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
        const timer = setInterval(() => { loadState() }, POLL_MS)
        return () => {
          clearInterval(timer)
          if (styleRef.current) { try { styleRef.current.remove() } catch { /* 已移除 */ } }
        }
      }, [load, loadState])

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
          const bad = r.errors || []
          const warn = r.warnings || []
          const workTouched = changed.some((p) => p.startsWith('workMode'))
          if (workTouched) {
            setMsg({
              kind: 'ok',
              text: `已保存工作模式设置。\n⚠ 工作模式切换必须重载插件才生效（不会立刻切换）。`,
            })
          } else if (changed.length) {
            setMsg({
              kind: 'ok',
              text: `已保存 ${changed.length} 项：${changed.join('、')}\n重载插件后生效。`,
            })
          } else if (!bad.length && !warn.length) {
            setMsg({ kind: 'warn', text: '没有改动。' })
          } else {
            setMsg(null)
          }
          if (bad.length) setErr('这几项没存进去：\n' + bad.map((e) => `- ${e.path}：${e.error}`).join('\n'))
          if (warn.length && !workTouched) setMsg({ kind: 'warn', text: warn.map((w) => `⚠ ${w.path}：${w.error}`).join('\n') })
          await load()
          await loadState()
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

        // ── 操作 ──
        h('div', { className: 'dmt-actions' },
          h('button', { className: 'dmt-btn dmt-primary', onClick: save, disabled: !!busy },
            busy === 'save' ? '保存中…' : '保存（重载插件生效）'),
          h('button', { className: 'dmt-btn', onClick: load, disabled: !!busy }, '重新读取'),
          h('button', { className: 'dmt-btn', onClick: organize, disabled: !!busy },
            busy === 'organize' ? '整理中…' : '立即整理'),
          h('button', {
            className: 'dmt-btn',
            onClick: () => { setShowLog((v) => !v); if (!showLog) loadLog() },
          }, showLog ? '收起日志' : '看日志'),
        ),

        msg ? h('div', { className: 'dmt-msg ' + (msg.kind === 'ok' ? 'dmt-ok' : 'dmt-warn'), 'aria-live': 'polite' }, msg.text) : null,
        err && cfg ? h('div', { className: 'dmt-msg dmt-err', 'aria-live': 'polite' }, err) : null,

        showLog
          ? h('div', null,
            h('div', { className: 'dmt-log' }, logs.length ? logs.slice(-20).join('\n') : '（没有日志）'),
            h('div', { className: 'dmt-hint', style: { marginTop: '4px' } },
              `数据来源：${paths?.config ? paths.config.replace(/config\.json$/, 'log.txt') : 'log.txt'} 的最后 20 行`))
          : null,
      )
    }

    const inject = ['slots']
    const NS = 'memory-tiers'

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: NS, order: 7, label: () => '记忆' },
        MemorySection,
      ), 'memory-tiers: settings section'), 'memory-tiers: settings section')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
