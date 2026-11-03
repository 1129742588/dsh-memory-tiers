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
      '.dmt-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12.5px}',
      '.dmt-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);font-size:11.5px;padding:4px 8px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2))}',
      '.dmt-table td{padding:5px 8px 5px 0;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.12));vertical-align:top}',
      '.dmt-num{text-align:right;font-family:var(--dsw-font-mono,ui-monospace,monospace);white-space:nowrap}',
      '.dmt-tag{margin-left:6px;padding:0 5px;border-radius:4px;font-size:10.5px;background:var(--dsw-alias-bg-tertiary,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary)}',
      '.dmt-preset{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}',
      '.dmt-card{flex:1 1 220px;min-width:200px;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.25));cursor:pointer}',
      '.dmt-card.dmt-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.06))}',
      '.dmt-card b{display:block;font-size:12.5px;font-weight:500}',
      '.dmt-card span{display:block;margin-top:3px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
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

    // ── 六层分别是什么，设置页顶部照这个表画 ──
    const LAYERS = [
      { key: 'L1', name: 'L1 即时', inCtx: true, desc: '当前会话的对话原话与事件，按时间保存；满了取最老一半往下分流' },
      { key: 'L2', name: 'L2 巩固', inCtx: true, desc: '较重要的原话，留得住细节；溢出时按是否被摘要引用决定去留' },
      { key: 'L3', name: 'L3 长期', inCtx: true, desc: '摘要视图（不落盘，从 DL3 排序截出），直接决定注入上下文多少字' },
      { key: 'DL1', name: 'DL1 遗忘中', inCtx: false, desc: '被判不重要的原文，慢慢遗忘；被再次关注会升回 L2' },
      { key: 'DL2', name: 'DL2 原文库', inCtx: false, desc: '被摘要引用过的重要原文，保细节，按需检索' },
      { key: 'DL3', name: 'DL3 摘要库', inCtx: false, desc: 'L3 溢出的摘要，长期沉淀；融合去重在这里做，按需检索' },
    ]

    // ── 字段定义：改这里就能增减配置项（服务端白名单见 settings.mjs 的 WRITABLE） ──
    const FIELDS = [
      {
        group: '基础（数据目录与写者）',
        path: ['dir'],
        label: '数据目录',
        type: 'text',
        wide: true,
        hint: '记忆存在哪。改成 dsh 和 astrbot 都能访问的路径就能共享同一份记忆。'
          + '它存在固定位置的指针文件里（不在 config.json 里——config.json 就在数据目录里面，'
          + '得先知道目录才能读它）。换目录要把旧目录里的文件一起搬过去。改完需重启。',
      },
      {
        group: '基础（数据目录与写者）',
        path: ['writer'],
        label: '写者标识',
        type: 'text',
        wide: true,
        hint: '共用同一个目录时，**每个程序必须填得不一样**（如 dsh / astrbot）。'
          + '它决定这个程序写哪份文件（store-<写者>.json）。填成一样的两个程序会互相覆盖。'
          + '只读字母、数字、下划线和短横线。改完需重启。',
      },
      {
        group: '向量 / 语义检索',
        path: ['apiKey'],
        label: 'API Key',
        type: 'password',
        wide: true,
        hint: '硅基流动的免费模型也要 key（去硅基流动官网领）。不填就没有语义检索，只走关键词。融合与摘要不受影响——它们默认跟当前会话模型走。改完需重启。',
      },
      {
        group: '向量 / 语义检索',
        path: ['apiBase'],
        label: 'API 地址（两者共用）',
        type: 'text',
        wide: true,
        showIf: (c) => (c?.preset || 'siliconflow') === 'custom',
        hint: '嵌入与重排的默认地址；下面各自还能单独覆盖。留空 = https://api.siliconflow.cn/v1。',
      },

      {
        group: '向量 / 语义检索',
        path: ['models', 'embed', 'model'],
        label: '嵌入模型',
        type: 'text',
        wide: true,
        showIf: (c) => (c?.preset || 'siliconflow') === 'custom',
        hint: '把记忆变成向量，检索和判重都靠它。硅基流动默认用 BAAI/bge-m3（免费、1024 维）。换模型必须跑一次 reindex，否则旧向量全是废的。',
      },
      {
        group: '向量 / 语义检索',
        path: ['models', 'embed', 'base'],
        label: '嵌入 API 地址',
        type: 'text',
        wide: true,
        showIf: (c) => (c?.preset || 'siliconflow') === 'custom',
        hint: '留空 = 用上面「模型连接」里的地址。例：https://api.siliconflow.cn/v1',
      },
      {
        group: '向量 / 语义检索',
        path: ['models', 'embed', 'apiKey'],
        label: '嵌入 API Key',
        type: 'password',
        wide: true,
        showIf: (c) => (c?.preset || 'siliconflow') === 'custom',
        hint: '留空 = 用上面的 API Key。',
      },
      {
        group: '向量 / 语义检索',
        path: ['models', 'rerank', 'model'],
        label: '重排模型',
        type: 'text',
        wide: true,
        showIf: (c) => (c?.preset || 'siliconflow') === 'custom',
        hint: '检索结果的精排（判断"这条到底相不相关"）。硅基流动默认 BAAI/bge-reranker-v2-m3，和 bge-m3 同门。',
      },
      {
        group: '向量 / 语义检索',
        path: ['models', 'rerank', 'base'],
        label: '重排 API 地址',
        type: 'text',
        wide: true,
        showIf: (c) => (c?.preset || 'siliconflow') === 'custom',
        hint: '留空 = 用上面「模型连接」里的地址。',
      },
      {
        group: '向量 / 语义检索',
        path: ['models', 'rerank', 'apiKey'],
        label: '重排 API Key',
        type: 'password',
        wide: true,
        showIf: (c) => (c?.preset || 'siliconflow') === 'custom',
        hint: '留空 = 用上面的 API Key。',
      },

      {
        group: '整理（模型与摘要）',
        path: ['models', 'chat', 'model'],
        label: '融合模型（自己指定时）',
        type: 'text',
        wide: true,
        showIf: (c) => c?.models?.chat?.source === 'api',
        hint: '判重 / 判矛盾 / 判进展 / 分类。这活只要一个词，用便宜快的小模型就够，别上大模型。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['models', 'chat', 'base'],
        label: '融合 API 地址',
        type: 'text',
        wide: true,
        showIf: (c) => c?.models?.chat?.source === 'api',
        hint: '留空 = 用上面「模型连接」里的地址。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['models', 'chat', 'apiKey'],
        label: '融合 API Key',
        type: 'password',
        wide: true,
        showIf: (c) => c?.models?.chat?.source === 'api',
        hint: '留空 = 用上面的 API Key。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['noThink', 'chat'],
        label: '融合时关思考',
        type: 'boolean',
        hint: '推荐开。判关系只要一个词，开思考既慢又费 token，还可能把词藏进推理里。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['models', 'summary', 'model'],
        label: '摘要模型（自己指定时）',
        type: 'text',
        wide: true,
        showIf: (c) => c?.models?.summary?.source === 'api',
        hint: '把一批对话压成摘要。要它读得多、写得准，建议用比融合模型大一号或多一号的。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['models', 'summary', 'base'],
        label: '摘要 API 地址',
        type: 'text',
        wide: true,
        showIf: (c) => c?.models?.summary?.source === 'api',
        hint: '留空 = 用上面「模型连接」里的地址。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['models', 'summary', 'apiKey'],
        label: '摘要 API Key',
        type: 'password',
        wide: true,
        showIf: (c) => c?.models?.summary?.source === 'api',
        hint: '留空 = 用上面的 API Key。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['noThink', 'summary'],
        label: '摘要时关思考',
        type: 'boolean',
        hint: '默认不关。摘要要想清楚再压，压错了信息就真丢了。',
      },

      {
        group: '注入（每轮拼进上下文的量）',
        path: ['memoryCfg', 'hotMaxChars'],
        label: 'L1 即时层',
        type: 'number',
        hint: '按时间保存的原文。满了取最老一半分流沉淀。默认 2000。',
      },
      {
        group: '注入（每轮拼进上下文的量）',
        path: ['memoryCfg', 'consolidateMaxChars'],
        label: 'L2 巩固层',
        type: 'number',
        hint: '较重要的原话。默认 2500。',
      },
      {
        group: '注入（每轮拼进上下文的量）',
        path: ['memoryCfg', 'hotQuotaOwn'],
        label: '自己那一端的配额',
        type: 'number',
        hint: '0~1，默认 0.7。L1 视图先紧着自己写的占这么多，剩下的留给另一端；两端用同一规则，注入块才不会来回跳。和 astrbot 的 hot_quota_own 对应。',
      },
      {
        group: '注入（每轮拼进上下文的量）',
        path: ['memoryCfg', 'longMaxChars'],
        label: 'L3 长期层',
        type: 'number',
        hint: '摘要。这个值直接决定每轮注入块的大小，默认 3000（和 astrbot 的 long_max_chars 对齐），调大更全但也更贵。',
      },

      {
        group: '注入（每轮拼进上下文的量）',
        path: ['bootMaxChars'],
        label: '注入总量上限（字）',
        type: 'number',
        hint: '0（推荐）= 不限制，注入多少由下面 L1/L2/L3 各自容量决定。astrbot 端没有这一项，它靠 hot_max_chars + long_max_chars 分别限制。',
      },
      {
        group: '注入（每轮拼进上下文的量）',
        path: ['inject'],
        label: '注入记忆',
        type: 'boolean',
        hint: '关掉 = 只写不读，适合先验证抓取是否正常。默认开。',
      },
      {
        group: '注入（每轮拼进上下文的量）',
        path: ['refreshMin'],
        label: 'L3 视图刷新间隔（分钟）',
        type: 'number',
        hint: '默认 30 分钟。只有 L3 需要节流：它排在注入块最前，一变后面 L2/L1 的缓存全断。L1/L2 不节流，写了就带上下一轮。',
      },
      {
        group: '注入（每轮拼进上下文的量）',
        path: ['semanticTtlMin'],
        label: '相关旧事有效期（分钟）',
        type: 'number',
        hint: '默认 3 分钟。超时就重新检索，避免把隔夜的话题带进这一轮。',
      },

      {
        group: '整理（模型与摘要）',
        path: ['quietMin'],
        label: '安静多久才整理（分钟）',
        type: 'number',
        hint: '默认 10 分钟：只把已经安静下来的轮次拿去压缩，避免聊到一半被摘要腰斩。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['memoryCfg', 'forgetThreshold'],
        label: '遗忘阈值',
        type: 'number',
        hint: '0~1，默认 0.25。DL1 里保持率低于这个值就忘掉，忘之前先写台账 graveyard/forgotten.jsonl。和 astrbot 的 forget_threshold 对应。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['memoryCfg', 'l2KeepMax'],
        label: '每轮最多沉淀几条',
        type: 'number',
        hint: '默认 10。一次整理里最多挑几条进 L2，其余落流水账（不丢，只是不再常驻上下文）。和 astrbot 的 l2_keep_max 对应。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['memoryCfg', 'summaryChunk'],
        label: '摘要分片（条）',
        type: 'number',
        hint: '默认 60。太大容易超上下文（十万条会一次打出百万 token），太小则摘要碎片化。和 astrbot 的 summary_chunk 对应。',
      },
      {
        group: '整理（模型与摘要）',
        path: ['organizeEveryMin'],
        label: '整理间隔（分钟）',
        type: 'number',
        hint: '默认 5 分钟补一轮。太勤会白跑——没到容量就不动。',
      },

      {
        group: '抓取',
        path: ['userCaptureChars'],
        label: '单条用户消息上限',
        type: 'number',
        hint: '默认 2000 字。超长消息只记前这么多。',
      },
      {
        group: '抓取',
        path: ['toolCaptureChars'],
        label: '工具输出上限',
        type: 'number',
        hint: '默认 500 字。bash 一次能吐几万字，L1 才 3000 字。',
      },
      {
        group: '抓取',
        path: ['botCaptureChars'],
        label: '回复截断',
        type: 'number',
        hint: '默认 400 字。一轮回复拼起来再截（不是每条消息截），和 astrbot 的 capture_bot_chars 对齐。',
      },

      {
        group: '自身历史压缩',
        path: ['autoCompact'],
        label: '每轮压缩 dsh 历史',
        type: 'boolean',
        hint: '把 dsh 自带会话历史压成一条占位（零 LLM 调用），被压掉的内容先归档进记忆。默认开。',
      },
      {
        group: '自身历史压缩',
        path: ['compactKeepTurns'],
        label: '压缩后保留几轮',
        type: 'number',
        hint: '0（默认）= 一条不留，全交给记忆（L1 就是历史）。想留点临时内容就调大。',
      },
      {
        group: '自身历史压缩',
        path: ['compactArchiveChars'],
        label: '每轮归档字数',
        type: 'number',
        hint: '默认 1200 字。压缩前把这一轮归档进记忆的字数上限。',
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
      const ch = live?.chars || {}

      // ── 嵌入/重排：硅基流动免费模型 还是 自己指定 ──
      const presetNow = cfg?.preset || 'siliconflow'
      const presetCards = h('div', { className: 'dmt-preset' },
        h('div', {
          className: 'dmt-card' + (presetNow === 'siliconflow' ? ' dmt-on' : ''),
          onClick: () => setField(['preset'], 'siliconflow'),
        },
          h('b', null, '硅基流动 · 免费模型'),
          h('span', null, '嵌入 BAAI/bge-m3 + 重排 BAAI/bge-reranker-v2-m3。中文够用，日常首选，只要一个 key。'),
        ),
        h('div', {
          className: 'dmt-card' + (presetNow === 'custom' ? ' dmt-on' : ''),
          onClick: () => setField(['preset'], 'custom'),
        },
          h('b', null, '自己指定来源'),
          h('span', null, '填下面的地址 / Key / 模型名，可以换更高级的或自建服务。'),
        ),
      )

      // ── 融合/摘要：跟当前会话模型走，还是自己指定 ──
      const sess = live?.session
      const sourceRow = (stage, title, tip) => {
        const cur = cfg?.models?.[stage]?.source || 'session'
        return h('div', { className: 'dmt-row', key: stage },
          h('div', null,
            h('div', { className: 'dmt-label' }, title),
            h('div', { className: 'dmt-hint' }, tip),
          ),
          h('div', { className: 'dmt-preset', style: { marginTop: 0, gap: 6 } },
            h('div', {
              className: 'dmt-card' + (cur === 'session' ? ' dmt-on' : ''),
              style: { flex: '0 0 auto', minWidth: 132 },
              onClick: () => setField(['models', stage, 'source'], 'session'),
            },
              h('b', null, '跟随当前会话模型'),
              h('span', null, sess?.available ? `现在：${sess.model}` : '（通道不可用）'),
            ),
            h('div', {
              className: 'dmt-card' + (cur === 'api' ? ' dmt-on' : ''),
              style: { flex: '0 0 auto', minWidth: 100 },
              onClick: () => setField(['models', stage, 'source'], 'api'),
            },
              h('b', null, '自己指定'),
              h('span', null, '填下面的模型 / 地址 / Key'),
            ),
          ),
        )
      }
      const sessionBlock = h('div', null,
        h('div', { className: 'dmt-hint', style: { marginBottom: 6 } },
          sess?.available
            ? `当前会话模型：${sess.model}（${sess.provider}）。选「跟随」就不用额外配 key，对话换模型它也跟着换。`
            : `没检测到会话模型通道（${sess?.reason || '未知'}）：这两个阶段只能自己指定外部来源。`),
        sourceRow('chat', '融合模型（判重 / 判矛盾 / 分类）', '只输出一个词，建议便宜快的小模型'),
        sourceRow('summary', '摘要模型', '要把几十条压成一段，建议用比融合模型大一号的'),
      )

      return h('div', { className: 'dmt' },
        h('h3', { className: 'dmt-title' }, '记忆'),
        h('p', { className: 'dmt-intro' },
          '六层记忆 + 零 LLM 历史压缩。同一会话里记忆负责「记得住」，压缩负责「上下文不涨」。改完需要重启 dsh 生效。'),

        // ── 每层存量（只读）：条数 + 字数 + 每层干什么 ──
        h('div', { className: 'dmt-group' }, '每层现在存了多少'),
        h('table', { className: 'dmt-table' },
          h('thead', null,
            h('tr', null,
              h('th', null, '层'),
              h('th', null, '条数'),
              h('th', null, '字数'),
              h('th', null, '存的是什么 / 怎么用'),
            ),
          ),
          h('tbody', null,
            LAYERS.map((l) => {
              const n = c[l.key] ?? 0
              const s = ch[l.key] ?? 0
              return h('tr', { key: l.key },
                h('td', null, h('b', null, l.name), l.inCtx ? h('span', { className: 'dmt-tag' }, '进上下文') : null),
                h('td', { className: 'dmt-num' }, String(n)),
                h('td', { className: 'dmt-num' }, s ? s.toLocaleString() : '0'),
                h('td', { className: 'dmt-hint' }, l.desc),
              )
            }),
            h('tr', { key: 'vec' },
              h('td', null, h('b', null, '向量')),
              h('td', { className: 'dmt-num' }, String(live?.vectors ?? 0)),
              h('td', { className: 'dmt-num' }, '-'),
              h('td', { className: 'dmt-hint' }, '有向量的条目才能语义检索；0 = 没接模型或还没重建'),
            ),
          ),
        ),
        h('div', { className: 'dmt-hint', style: { marginTop: 4 } },
          `合计 ${live?.total ?? 0} 条。` + (live?.semantic
            ? '语义检索已开启。'
            : '没接模型：检索只走关键词。')),
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
                .map(([k, v]) => k + ': ' + (v.source === 'session'
                  ? '跟随会话模型 ' + (v.sessionModel || '?')
                  : (v.model || '?') + ' @ ' + String(v.base || '').replace(/^https?:\/\//, '')))
                .join('\n')),
            )
          : null,

        // ── 配置字段 ──
        ...GROUPS.map((g) =>
          h('div', { key: g },
            h('div', { className: 'dmt-group' }, g),
            g === '向量 / 语义检索' ? presetCards : null,
            g === '整理（模型与摘要）' ? sessionBlock : null,
            h('div', { className: 'dmt-rows' },
              FIELDS.filter((f) => f.group === g && (!f.showIf || f.showIf(cfg, live))).map((f) =>
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
