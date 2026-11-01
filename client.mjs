/**
 * dsh-memory-tiers —— 客户端半边：DSH「设置」里的 **记忆** section。
 *
 * 宿主提供的运行时：window.__ModuleLoader__.load({ id, factory }) + require('react')。
 * 挂载点：ctx.slots.register('settings.section', { id, order, label }, Component)。
 * 数据来源：本插件服务端的 /dsh-memory/api/*（settings.mjs）。
 *
 * 为什么不用 schemastery 声明 schema 让 dsh 自动生成表单：
 * link 安装的插件 import 不到 @deepseek-ai/*（见 ARCHITECTURE 19.5），拿不到那个包。
 * 手写反而能把「只读运行状态」「三层容量对照」「重启提示」排在一起。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-tiers',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const API = '/dsh-memory/api'
    const CSS_TAG = 'dsh-memory-tiers/section.css'
    const CSS = [
      '.dmt{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}',
      '.dmt-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dmt-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}',
      '.dmt-group{margin-top:16px;font-size:13px;font-weight:500;line-height:20px}',
      '.dmt-rows{display:flex;flex-direction:column}',
      '.dmt-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.dmt-row:last-child{border-bottom:none}',
      '.dmt-row>div:first-child{flex:1;min-width:190px}',
      '.dmt-label{font-size:13px;line-height:19px}',
      '.dmt-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}',
      '.dmt-input,.dmt-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:180px;outline:none}',
      '.dmt-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
      '.dmt-input.dmt-wide{min-width:280px}',
      '.dmt-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}',
      '.dmt-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dmt-btn{height:28px;padding:0 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer}',
      '.dmt-btn:hover{border-color:var(--dsw-alias-border-l1)}',
      '.dmt-btn.dmt-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.dmt-btn:disabled{opacity:.5;cursor:default}',
      '.dmt-msg{font-size:12.5px;line-height:18px}',
      '.dmt-msg.dmt-ok{color:var(--dsw-alias-label-success,#3b6d11)}',
      '.dmt-msg.dmt-warn{color:var(--dsw-alias-label-warning,#854f0b)}',
      '.dmt-msg.dmt-err{color:var(--dsw-alias-label-danger,#a32d2d)}',
      '.dmt-stats{display:flex;gap:18px;flex-wrap:wrap;margin-top:8px}',
      '.dmt-stat{min-width:92px}',
      '.dmt-stat b{display:block;font-size:15px;font-weight:500;line-height:22px}',
      '.dmt-stat span{color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
      '.dmt-log{margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.06));font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto}',
      '.dmt-mono{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11.5px;word-break:break-all}',
    ].join('\n')

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dmt="' + CSS_TAG + '"]')) return
      const el = document.createElement('style')
      el.dataset.dmt = CSS_TAG
      el.textContent = CSS
      document.head.appendChild(el)
    }

    const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj)
    const setPath = (obj, path, value) => {
      const next = { ...obj }
      let cur = next
      for (let i = 0; i < path.length - 1; i++) {
        const k = path[i]
        cur[k] = { ...(cur[k] || {}) }
        cur = cur[k]
      }
      cur[path[path.length - 1]] = value
      return next
    }

    // ── 字段定义：改这里就能增减配置项（服务端白名单见 settings.mjs 的 WRITABLE） ──
    const FIELDS = [
      {
        group: '模型连接',
        path: ['apiKey'],
        label: 'API Key',
        type: 'password',
        wide: true,
        hint: '不填就没有语义检索（只走关键词命中，也没有摘要）。本插件不再用本地哈希向量充数。改完需重启。',
      },
      {
        group: '模型连接',
        path: ['apiBase'],
        label: 'API 地址',
        type: 'text',
        wide: true,
        hint: '默认 https://api.siliconflow.cn/v1。换别家兼容 OpenAI 接口的服务时改这里。',
      },

      {
        group: '模型（每个阶段可分开指定，留空走默认）',
        path: ['models', 'summary', 'model'],
        label: '摘要模型',
        type: 'text',
        wide: true,
        hint: '把一批对话压成摘要用哪个。留空 = deepseek-ai/DeepSeek-V4.1-Flash。摘要量最大，想单独走一家便宜的就填这里，并配上下面两项地址和 key。',
      },
      {
        group: '模型（每个阶段可分开指定，留空走默认）',
        path: ['models', 'summary', 'base'],
        label: '摘要 API 地址',
        type: 'text',
        wide: true,
        hint: '留空 = 用上面「模型连接」里的 API 地址。例：https://api.deepseek.com',
      },
      {
        group: '模型（每个阶段可分开指定，留空走默认）',
        path: ['models', 'summary', 'apiKey'],
        label: '摘要 API Key',
        type: 'password',
        wide: true,
        hint: '留空 = 用上面的 API Key。填了就表示摘要单独走另一家。',
      },
      {
        group: '模型（每个阶段可分开指定，留空走默认）',
        path: ['models', 'chat', 'model'],
        label: '轻任务模型',
        type: 'text',
        wide: true,
        hint: '判重、判矛盾、分类这些高频小任务，选快而便宜的。留空 = inclusionAI/Ling-mini-2.0。',
      },
      {
        group: '模型（每个阶段可分开指定，留空走默认）',
        path: ['models', 'embed', 'model'],
        label: '向量模型',
        type: 'text',
        wide: true,
        hint: '检索和入库判重都靠它。留空 = Qwen/Qwen3-Embedding-0.6B。换模型后向量维度不同，旧库要重建。',
      },
      {
        group: '模型（每个阶段可分开指定，留空走默认）',
        path: ['models', 'rerank', 'model'],
        label: '重排模型',
        type: 'text',
        wide: true,
        hint: '检索结果精排。留空 = Qwen/Qwen3-Reranker-0.6B。',
      },

      {
        group: '三层容量（决定每轮注入多少字）',
        path: ['memoryCfg', 'hotMaxChars'],
        label: 'L1 即时层',
        type: 'number',
        hint: '按时间保存的原文。满了取最老一半分流沉淀。默认 2000。',
      },
      {
        group: '三层容量（决定每轮注入多少字）',
        path: ['memoryCfg', 'consolidateMaxChars'],
        label: 'L2 巩固层',
        type: 'number',
        hint: '较重要的原话。默认 2500。',
      },
      {
        group: '三层容量（决定每轮注入多少字）',
        path: ['memoryCfg', 'longMaxChars'],
        label: 'L3 长期层',
        type: 'number',
        hint: '摘要。这个值直接决定每轮注入块的大小，默认 2000，调大更全但也更贵。',
      },

      {
        group: '上下文注入',
        path: ['injectHot'],
        label: '把 L1 也注入上下文',
        type: 'boolean',
        hint: '默认关。当前会话的对话本来就在历史里，重复注入会让注入块每轮变化、打掉 prompt cache。',
      },
      {
        group: '上下文注入',
        path: ['refreshMinMs'],
        label: '记忆块刷新间隔（毫秒）',
        type: 'number',
        hint: '默认 1800000（30 分钟）。内容变了也要等过节流窗口才刷新，保护缓存。',
      },

      {
        group: '历史压缩',
        path: ['autoCompact'],
        label: '自动压缩历史',
        type: 'boolean',
        hint: '每轮结束把宿主的会话历史压成一条占位，原文归档进记忆，不调用模型。',
      },
      {
        group: '历史压缩',
        path: ['compactKeepTurns'],
        label: '保留最近几轮原文',
        type: 'number',
        hint: '默认 1。设 0 会让模型完全看不见上一句问了什么，不建议。',
      },
      {
        group: '历史压缩',
        path: ['compactArchiveChars'],
        label: '单次归档字数上限',
        type: 'number',
        hint: '默认 1200。超出的部分截断收录，不会整段丢。',
      },

      {
        group: '写入捕获',
        path: ['userCaptureChars'],
        label: '单条用户消息上限',
        type: 'number',
        hint: '默认 2000 字。超长消息只记前这么多。',
      },
      {
        group: '写入捕获',
        path: ['toolCaptureChars'],
        label: '工具输出上限',
        type: 'number',
        hint: '默认 500 字。bash 一次能吐几万字，L1 才 2000 字。',
      },
    ]

    const GROUPS = []
    for (const f of FIELDS) if (!GROUPS.includes(f.group)) GROUPS.push(f.group)

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

    function Field({ field, value, onChange }) {
      const kind = field.type
      const id = 'dmt-' + field.path.join('-')
      let control
      if (kind === 'boolean') {
        control = h('input', {
          id,
          className: 'dmt-check',
          type: 'checkbox',
          checked: value === true,
          onChange: (e) => onChange(e.target.checked),
        })
      } else {
        control = h('input', {
          id,
          className: 'dmt-input' + (field.wide ? ' dmt-wide' : ''),
          type: kind === 'number' ? 'number' : kind === 'password' ? 'password' : 'text',
          value: value === undefined || value === null ? '' : String(value),
          placeholder: kind === 'password' ? '不填就不启用语义检索' : '',
          onChange: (e) => onChange(kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value),
        })
      }
      return h('div', { className: 'dmt-row' },
        h('div', null,
          h('label', { className: 'dmt-label', htmlFor: id }, field.label),
          field.hint ? h('div', { className: 'dmt-hint' }, field.hint) : null,
        ),
        control,
      )
    }

    function MemoryTiersSection() {
      const [cfg, setCfg] = useState(null)
      const [live, setLive] = useState(null)
      const [logs, setLogs] = useState([])
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      const [err, setErr] = useState(null)

      const load = useCallback(async () => {
        try {
          const d = await api('/settings')
          setCfg(d.config || {})
          setLive(d.live || null)
          const l = await api('/log').catch(() => ({ lines: [] }))
          setLogs(l.lines || [])
          setErr(null)
        } catch (e) {
          setErr(String(e.message || e))
        }
      }, [])

      useEffect(() => { ensureCss(); load() }, [load])

      const setField = (path, value) => {
        setCfg((cur) => setPath(cur || {}, path, value))
        setMsg(null)
      }

      const save = async () => {
        setBusy(true)
        setMsg(null)
        setErr(null)
        try {
          const r = await api('/settings', { method: 'POST', body: JSON.stringify({ config: cfg }) })
          const applied = r.applied?.length ?? 0
          setMsg(applied > 0
            ? '已保存 ' + applied + ' 项。重启 dsh 后生效。'
            : '没有可保存的改动。')
          await load()
        } catch (e) {
          setErr('保存失败：' + String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      if (err && !cfg) {
        return h('div', { className: 'dmt' },
          h('h3', { className: 'dmt-title' }, '记忆'),
          h('div', { className: 'dmt-msg dmt-err' }, '读取配置失败：' + err),
          h('div', { className: 'dmt-actions' }, h('button', { className: 'dmt-btn', onClick: load }, '重试')),
        )
      }

      if (!cfg) return h('div', { className: 'dmt' }, h('div', { className: 'dmt-hint' }, '加载中…'))

      const c = live?.counts || {}

      return h('div', { className: 'dmt' },
        h('h3', { className: 'dmt-title' }, '记忆'),
        h('p', { className: 'dmt-intro' },
          '六层记忆 + 零 LLM 历史压缩。同一会话里记忆负责「记得住」，压缩负责「上下文不涨」。改完需要重启 dsh 生效。'),

        // ── 运行状态（只读） ──
        h('div', { className: 'dmt-group' }, '运行状态'),
        h('div', { className: 'dmt-stats' },
          h('div', { className: 'dmt-stat' }, h('b', null, String(c.L1 ?? '-')), h('span', null, 'L1 即时')),
          h('div', { className: 'dmt-stat' }, h('b', null, String(c.L2 ?? '-')), h('span', null, 'L2 巩固')),
          h('div', { className: 'dmt-stat' }, h('b', null, String(c.L3 ?? '-')), h('span', null, 'L3 长期')),
          h('div', { className: 'dmt-stat' }, h('b', null, String(c.DL3 ?? '-')), h('span', null, 'DL3 摘要库')),
          h('div', { className: 'dmt-stat' }, h('b', null, String(live?.vectors ?? '-')), h('span', null, '向量')),
        ),
        h('div', { className: 'dmt-row' },
          h('div', null,
            h('div', { className: 'dmt-label' }, '数据目录'),
            h('div', { className: 'dmt-hint' }, '整个目录是自包含的，拷走即可备份或迁移；用环境变量 MEMORY_TIERS_DIR 可换位置。'),
          ),
          h('div', { className: 'dmt-mono' }, live?.dir || '-'),
        ),
        h('div', { className: 'dmt-row' },
          h('div', null,
            h('div', { className: 'dmt-label' }, '语义检索'),
            h('div', { className: 'dmt-hint' }, live?.semantic
              ? '已接真模型'
              : '未连接模型：语义检索关闭，只按关键词命中（没有假向量）'),
          ),
          h('div', { className: 'dmt-msg ' + (live?.semantic ? 'dmt-ok' : 'dmt-warn') }, live?.semantic ? '开' : '关'),
        ),
        live?.semantic ? null : h('div', { className: 'dmt-row', style: { borderLeft: '2px solid var(--dsw-alias-border-warning, #BA7517)', paddingLeft: 12 } },
          h('div', null,
            h('div', { className: 'dmt-label' }, '需要先接模型'),
            h('div', { className: 'dmt-hint' }, '在上面「API Key」填硅基流动的 key 并保存，重启 dsh 后语义检索才会启用。已经有的旧向量不会被读取，也不会被删。'),
          ),
        ),
        live?.models
          ? h('div', { className: 'dmt-row' },
              h('div', null,
                h('div', { className: 'dmt-label' }, '实际生效的模型'),
                h('div', { className: 'dmt-hint' }, '留空的项已回落到顶层配置或默认值。改完需重启才会重新解析。'),
              ),
              h('div', {
                className: 'dmt-mono',
                style: { whiteSpace: 'pre-line', textAlign: 'right' },
              }, Object.entries(live.models)
                .map(([k, v]) => k + ': ' + (v.model || '?') + ' @ ' + String(v.base || '').replace(/^https?:\/\//, ''))
                .join('\n')),
            )
          : null,

        // ── 配置字段 ──
        ...GROUPS.map((g) =>
          h('div', { key: g },
            h('div', { className: 'dmt-group' }, g),
            h('div', { className: 'dmt-rows' },
              FIELDS.filter((f) => f.group === g).map((f) =>
                h(Field, {
                  key: f.path.join('.'),
                  field: f,
                  value: getPath(cfg, f.path),
                  onChange: (v) => setField(f.path, v),
                }),
              ),
            ),
          ),
        ),

        // ── 操作 ──
        h('div', { className: 'dmt-actions' },
          h('button', { className: 'dmt-btn dmt-primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          h('button', { className: 'dmt-btn', onClick: load, disabled: busy }, '重新读取'),
          msg ? h('span', { className: 'dmt-msg dmt-ok' }, msg) : null,
          err ? h('span', { className: 'dmt-msg dmt-err' }, err) : null,
        ),

        // ── 最近审计 ──
        h('div', { className: 'dmt-group' }, '最近归档 / 压缩（capture.log 末尾）'),
        logs.length
          ? h('div', { className: 'dmt-log' }, logs.join('\n'))
          : h('div', { className: 'dmt-hint' }, '还没有记录。聊几轮后这里会出现每轮的归档与压缩行。'),
      )
    }

    const inject = ['slots']
    const NS = 'memory-tiers'
    const NAMES = { nav: '记忆' }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: NS, order: 7, label: () => NAMES.nav },
              MemoryTiersSection,
            ),
            'memory-tiers: settings section',
          ),
        'memory-tiers: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.MemoryTiersSection = MemoryTiersSection
    exports.FIELDS = FIELDS
    return module.exports
  },
})
