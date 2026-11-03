/**
 * dsh-memory-tiers · 配置
 *
 * 一个文件干四件事：
 *   ① 唯一一份 schema：默认值、类型、范围、分组、说明全在 SCHEMA 里（页面也读它）
 *   ② 读写配置文件：<DSH_HOME>/memory-tiers/config.json，位置固定、不由代码移动
 *   ③ 校验：类型、范围、目录可写、交叉项警告
 *   ④ 配置页的服务端接口（GET/POST config、GET state/log、POST organize）
 *
 * 三处路径的分工（要求第 3 条）：
 *   核心代码   core/           发布物，用户不改
 *   配置       <DSH_HOME>/memory-tiers/config.json   用户可改，位置不变
 *   存储       <DSH_HOME>/storages/memory（默认）     用户可改、可搬
 * 日志 / 状态 / 上下文导出也放配置目录，不往 ~/.dsh 根目录撒。
 *
 * 启动流程（要求第 5 条）：
 *   没有配置文件 → 用默认值生成一份
 *   有但残缺    → 补齐并写回
 *   有但坏了    → 改名留档，重建
 *   有旧版文件  → 迁移成新结构，旧文件留 .v1-bak
 * 用户永远不会「必须」手改这个文件：页面能改的都在 schema 里。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { isIP } from 'node:net'

export const CONFIG_VERSION = 2
export const DEFAULT_DATA_SUBDIR = join('storages', 'memory')

// ============================================================
// 路径
// ============================================================

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

/** 配置目录（固定；配置、日志、状态、上下文导出都在这里） */
export const configDir = (env = process.env) => join(dshHome(env), 'memory-tiers')
export const configPath = (env = process.env) => join(configDir(env), 'config.json')
export const logPath = (env = process.env) => join(configDir(env), 'log.txt')
export const statusPath = (env = process.env) => join(configDir(env), 'status.json')
export const contextPath = (env = process.env) => join(configDir(env), 'context.txt')
/** 旧版的配置就在 ~/.dsh 根，迁移用 */
export const legacyConfigPath = (env = process.env) => join(dshHome(env), 'memory-tiers.json')

export function expandHome(p, env = process.env) {
  const s = String(p || '').trim()
  if (!s) return ''
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2))
  return s
}

/** 数据目录：配置里的 storage.dir 优先，空则用默认值 */
export function resolveDataDir(cfg, env = process.env) {
  const raw = expandHome(cfg?.storage?.dir, env)
  return raw || join(dshHome(env), DEFAULT_DATA_SUBDIR)
}

// ============================================================
// schema：唯一真相
//
// 每个字段：{ group, path, type, default, label, hint, min?, max?, step?, options?, showIf? }
//   type: text | password | number | boolean | select | dir
//   showIf: { path, eq } —— 页面据此显示/隐藏（服务端不据此丢弃值）
// 新增配置项只改这里：默认值、校验、页面渲染、文档提示全部跟着变。
// ============================================================

export const SCHEMA = [
  // —— 存储 ——
  {
    group: '存储', path: 'storage.dir', type: 'dir', default: '',
    label: '记忆库目录', wide: true,
    hint: '六层数据放这里。留空 = <DSH_HOME>/storages/memory。改完重载插件生效，旧目录内容不会自动搬过去。',
  },
  {
    group: '存储', path: 'writer', type: 'text', default: 'dsh',
    label: '写者标识',
    hint: '两个进程共用一个记忆库时，必须填得不一样（只允许字母、数字、_、-）。单进程不用改。',
  },

  // —— 抓取（第 1 步：收）——
  {
    group: '抓取', path: 'capture.enabled', type: 'boolean', default: true,
    label: '自动记录对话',
    hint: '每轮结束把「你问的、模型答的、工具做的」写进 L1（即时层）。关掉就只读不写。',
  },
  {
    group: '抓取', path: 'capture.userChars', type: 'number', default: 2000, min: 100, max: 20000, step: 100,
    label: '单条用户消息上限（字）',
    hint: '一条消息太长时截断后再进 L1。',
  },
  {
    group: '抓取', path: 'capture.botChars', type: 'number', default: 400, min: 100, max: 5000, step: 50,
    label: '一轮回复上限（字）',
    hint: '一轮里模型的正文拼起来再截断（不是每条消息各截一次）。',
  },
  {
    group: '抓取', path: 'capture.toolChars', type: 'number', default: 500, min: 0, max: 5000, step: 50,
    label: '单条工具输出上限（字）',
    hint: '一次命令能吐几万字，进 L1 前先截断。',
  },
  {
    group: '抓取', path: 'capture.semantic.enabled', type: 'boolean', default: false,
    label: '每轮检索相关旧事',
    hint: '开启后每轮用你说的话做一次语义检索，命中的旧记忆拼进注入块末尾。代价是每轮多一次嵌入调用。',
  },
  {
    group: '抓取', path: 'capture.semantic.topK', type: 'number', default: 5, min: 1, max: 20, step: 1,
    label: '相关旧事最多几条', showIf: { path: 'capture.semantic.enabled', eq: true },
  },
  {
    group: '抓取', path: 'capture.semantic.minSim', type: 'number', default: 0.35, min: 0, max: 1, step: 0.05,
    label: '相关度下限', showIf: { path: 'capture.semantic.enabled', eq: true },
    hint: '低于这个相似度不拼（避免字面擦边）。',
  },
  {
    group: '抓取', path: 'capture.semantic.ttlMin', type: 'number', default: 3, min: 1, max: 120, step: 1,
    label: '检索结果有效期（分钟）', showIf: { path: 'capture.semantic.enabled', eq: true },
    hint: '超时的结果不注入，免得把隔夜的话题塞进来。',
  },

  // —— 注入（第 6 步：喂）——
  {
    group: '注入', path: 'inject.enabled', type: 'boolean', default: true,
    label: '把记忆注入上下文',
    hint: '关掉 = 只写不读。注意：如果同时「历史保留 0 轮」，模型会什么都看不到。',
  },
  {
    group: '注入', path: 'inject.maxChars', type: 'number', default: 0, min: 0, max: 200000, step: 500,
    label: '注入总量上限（字）',
    hint: '0 = 不限制，由下面 L1/L2/L3 各自容量决定。填了就在总字数上再压一道（按整行裁）。',
  },

  // —— 六层容量（第 2/4 步的闸门）——
  {
    group: '六层容量', path: 'layers.hotChars', type: 'number', default: 3000, min: 200, max: 100000, step: 100,
    label: 'L1 即时层（字）',
    hint: '超过这么多字就准备分流。L1 同时是要注入进上下文的那部分。',
  },
  {
    group: '六层容量', path: 'layers.consolidateChars', type: 'number', default: 2500, min: 200, max: 100000, step: 100,
    label: 'L2 巩固层（字）',
    hint: '超过就下沉：少量留在 L2，其余进 DL1，被摘要引用的原文进 DL2。',
  },
  {
    group: '六层容量', path: 'layers.longChars', type: 'number', default: 3000, min: 200, max: 100000, step: 100,
    label: 'L3 长期层（字）',
    hint: '决定「一直记得的」那一段最多多少字（从 DL3 按热度截取，不落盘）。',
  },
  {
    group: '六层容量', path: 'layers.l2KeepMax', type: 'number', default: 10, min: 0, max: 200, step: 1,
    label: '每轮最多沉淀几条',
    hint: '第二次整理时，「+」最多留几条在 L2；其余下沉 DL1。',
  },
  {
    group: '六层容量', path: 'layers.forgetThreshold', type: 'number', default: 0.25, min: 0.01, max: 1, step: 0.01,
    label: '遗忘阈值',
    hint: 'DL1 里保持率低于它的条目会被遗忘（先写遗忘台账）。0.25 ≈ 半个月不提起就忘。',
  },
  {
    group: '六层容量', path: 'layers.dl1MaxChars', type: 'number', default: 20000, min: 1000, max: 500000, step: 1000,
    label: 'DL1 容量上限（字）',
    hint: '超过就按「越旧越先清」清到 80%（先写遗忘台账）。遗忘曲线管「该不该忘」，这个上限管「库不能无限长」。',
  },

  // —— 整理节奏（第 2 步的时机）——
  {
    group: '整理节奏', path: 'organize.everyMin', type: 'number', default: 5, min: 1, max: 1440, step: 1,
    label: '整理定时器（分钟）',
    hint: '没拿到钥匙时的补漏：每隔这么久试一次。L1 一过容量就分流，不用等安静期。',
  },
  {
    group: '整理节奏', path: 'organize.refreshMin', type: 'number', default: 30, min: 1, max: 1440, step: 1,
    label: 'L3 快照刷新（分钟）',
    hint: 'L3 排在注入块最前面，一动后面缓存全断，所以只有内容变了或到点才重排。',
  },
  {
    group: '整理节奏', path: 'organize.fusionPrefilter', type: 'number', default: 0.82, min: 0.5, max: 0.99, step: 0.01,
    label: '融合预筛阈值',
    hint: '判重复/判矛盾之前，先用向量筛到这个相似度才问模型。调低更容易发现矛盾（多花判关系调用），调高更省。',
  },

  // —— 模型 ——
  {
    group: '模型', path: 'model.preset', type: 'select', default: 'siliconflow',
    options: [{ value: 'siliconflow', label: '硅基流动（免费嵌入/精排）' }, { value: 'custom', label: '自己指定' }],
    label: '嵌入 / 精排来源',
    hint: '选「硅基流动」会用 BAAI/bge-m3 + bge-reranker-v2-m3；选「自己指定」就填下面的地址和模型名。',
  },
  {
    group: '模型', path: 'model.apiKey', type: 'password', default: '', wide: true,
    label: 'API Key',
    hint: '页面不回显。留空提交 = 清除；不提交 = 不改。本地端点可以不填。',
  },
  {
    group: '模型', path: 'model.apiBase', type: 'text', default: 'https://api.siliconflow.cn/v1', wide: true,
    label: 'API 地址',
    hint: 'OpenAI 兼容接口的 base（不带 /chat/completions）。',
  },
  {
    group: '模型', path: 'model.stages.embed.model', type: 'text', default: 'BAAI/bge-m3',
    label: '嵌入模型', showIf: { path: 'model.preset', eq: 'custom' },
    hint: '只在「自己指定」时生效。换模型会让旧向量失效（不报错，但检索命中率会变差）。',
  },
  { group: '模型', path: 'model.stages.embed.base', type: 'text', default: '', label: '嵌入 API 地址', showIf: { path: 'model.preset', eq: 'custom' }, hint: '留空 = 用上面的 API 地址。' },
  { group: '模型', path: 'model.stages.embed.apiKey', type: 'password', default: '', label: '嵌入 API Key', showIf: { path: 'model.preset', eq: 'custom' }, hint: '留空 = 用上面的 API Key。' },
  {
    group: '模型', path: 'model.stages.rerank.model', type: 'text', default: 'BAAI/bge-reranker-v2-m3',
    label: '精排模型', showIf: { path: 'model.preset', eq: 'custom' },
  },
  { group: '模型', path: 'model.stages.rerank.base', type: 'text', default: '', label: '精排 API 地址', showIf: { path: 'model.preset', eq: 'custom' }, hint: '留空 = 用上面的 API 地址。' },
  { group: '模型', path: 'model.stages.rerank.apiKey', type: 'password', default: '', label: '精排 API Key', showIf: { path: 'model.preset', eq: 'custom' }, hint: '留空 = 用上面的 API Key。' },
  {
    group: '模型', path: 'model.stages.chat.source', type: 'select', default: 'session',
    options: [{ value: 'session', label: '跟随当前对话模型' }, { value: 'api', label: '用下面的地址' }],
    label: '融合模型（分类 + 判关系）',
    hint: '融合 = 给条目分类、判两条摘要「重复 / 矛盾 / 进展 / 无关」。跟随当前对话模型就不用另配 key。',
  },
  { group: '模型', path: 'model.stages.chat.model', type: 'text', default: '', label: '融合模型名', showIf: { path: 'model.stages.chat.source', eq: 'api' }, hint: '留空 = inclusionAI/Ling-mini-2.0。' },
  { group: '模型', path: 'model.stages.chat.base', type: 'text', default: '', label: '融合 API 地址', showIf: { path: 'model.stages.chat.source', eq: 'api' } },
  { group: '模型', path: 'model.stages.chat.apiKey', type: 'password', default: '', label: '融合 API Key', showIf: { path: 'model.stages.chat.source', eq: 'api' } },
  {
    group: '模型', path: 'model.stages.summary.source', type: 'select', default: 'session',
    options: [{ value: 'session', label: '跟随当前对话模型' }, { value: 'api', label: '用下面的地址' }],
    label: '分流模型（挑选 + 摘要 + 保留）',
    hint: '分流 = 决定哪些写成摘要、哪些留原文、哪些下沉；要读几十条原文，用强一点的模型质量更好。',
  },
  { group: '模型', path: 'model.stages.summary.model', type: 'text', default: '', label: '分流模型名', showIf: { path: 'model.stages.summary.source', eq: 'api' }, hint: '留空 = deepseek-ai/DeepSeek-V4.1-Flash。' },
  { group: '模型', path: 'model.stages.summary.base', type: 'text', default: '', label: '分流 API 地址', showIf: { path: 'model.stages.summary.source', eq: 'api' } },
  { group: '模型', path: 'model.stages.summary.apiKey', type: 'password', default: '', label: '分流 API Key', showIf: { path: 'model.stages.summary.source', eq: 'api' } },
  {
    group: '模型', path: 'model.noThink.chat', type: 'boolean', default: true,
    label: '融合时关思考',
    hint: '融合只要一个词/一组标签，开着思考又慢又容易返回空。',
  },
  {
    group: '模型', path: 'model.noThink.summary', type: 'boolean', default: true,
    label: '分流时关思考',
    hint: '不关的话模型会先写一大段思考，max_tokens 一到摘要就被截断。',
  },
  {
    group: '模型', path: 'model.summaryChunk', type: 'number', default: 60, min: 5, max: 200, step: 5,
    label: '分流一次处理几条',
    hint: '条数越多越省固定开销，太多容易撞输出上限。',
  },
  {
    group: '模型', path: 'model.timeoutMs', type: 'number', default: 20000, min: 1000, max: 300000, step: 1000,
    label: '单次请求超时（毫秒）',
    hint: '分流另有一套更长的超时（90 秒），这里管嵌入/精排/融合。',
  },

  // —— 工作模式 ——
  {
    group: '工作模式', path: 'workMode.enabled', type: 'boolean', default: false,
    label: '工作模式（专注干活）',
    hint: '开启后：不注入记忆、不压缩历史（会话表现完全正常），但照常记录与整理，纪录字数按下面这组更大的值截断。'
      + '⚠️ 切换本项需重载插件才生效。',
  },
  {
    group: '工作模式', path: 'workMode.userChars', type: 'number', default: 4000, min: 100, max: 20000, step: 100,
    label: '工作模式：单条用户消息上限（字）',
    hint: '只在工作模式开启时生效（比普通抓取更完整）。改完重载插件生效。',
  },
  {
    group: '工作模式', path: 'workMode.botChars', type: 'number', default: 800, min: 100, max: 5000, step: 50,
    label: '工作模式：一轮回复上限（字）',
    hint: '只在工作模式开启时生效。改完重载插件生效。',
  },
  {
    group: '工作模式', path: 'workMode.toolChars', type: 'number', default: 1200, min: 0, max: 5000, step: 50,
    label: '工作模式：单条工具输出上限（字）',
    hint: '只在工作模式开启时生效（工具输出记得更全）。改完重载插件生效。',
  },
  {
    group: '工作模式', path: 'workMode.hotChars', type: 'number', default: 6000, min: 200, max: 100000, step: 100,
    label: '工作模式：L1 容量（字）',
    hint: '只在工作模式开启时生效。改完重载插件生效。',
  },
  {
    group: '工作模式', path: 'workMode.consolidateChars', type: 'number', default: 5000, min: 200, max: 100000, step: 100,
    label: '工作模式：L2 容量（字）',
    hint: '只在工作模式开启时生效。改完重载插件生效。',
  },

  // —— 历史替代（第 7 步）——
  {
    group: '历史替代', path: 'compaction.enabled', type: 'boolean', default: true,
    label: '用记忆替代对话历史',
    hint: '每轮结束后把 dsh 自己的历史换成一条占位，模型只靠注入的记忆说话。',
  },
  {
    group: '历史替代', path: 'compaction.keepTurns', type: 'number', default: 0, min: 0, max: 50, step: 1,
    label: '保留最近几轮原文',
    hint: '0 = 全部替换（完全靠记忆）；1 = 留最近一轮，其余归档。',
  },
  {
    group: '历史替代', path: 'compaction.archiveChars', type: 'number', default: 1200, min: 100, max: 20000, step: 100,
    label: '每轮归档字数上限',
    hint: '替换前先把要丢的内容写进 L1，写成功才敢丢。',
  },
]

/** 字段定义按 path 索引，校验时用 */
const BY_PATH = new Map(SCHEMA.map((f) => [f.path, f]))

/**
 * 配置页的分组顺序（作者口径）：模型连接放最前——必填的 apiKey 不该让人滚半页才找到。
 * 没列到的分组排在最后（以后新增分组不会丢）。
 */
export const GROUP_ORDER = ['模型', '工作模式', '存储', '抓取', '注入', '六层容量', '整理节奏', '历史替代']

export const GROUPS = [...new Set(SCHEMA.map((f) => f.group))]
  .sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a)
    const ib = GROUP_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })

// ============================================================
// 取值 / 赋值 / 默认值
// ============================================================

export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

export function setPath(obj, path, value) {
  const keys = String(path).split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = value
  return obj
}

/**
 * 由 schema 生成默认配置（禁止手写第二份）。
 *
 * storage.dir 例外：默认值不是空串而是**具体的默认路径**，
 * 这样第一次生成的配置文件里就写着「记忆放哪」，用户不用猜。
 */
export function buildDefaults(env = process.env) {
  const out = { version: CONFIG_VERSION }
  for (const f of SCHEMA) setPath(out, f.path, f.default)
  setPath(out, 'storage.dir', join(dshHome(env), DEFAULT_DATA_SUBDIR))
  return out
}

// ============================================================
// 校验
// ============================================================

function coerce(field, value) {
  switch (field.type) {
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value }
      if (value === 'true') return { ok: true, value: true }
      if (value === 'false') return { ok: true, value: false }
      return { ok: false, error: '应为 true / false' }
    }
    case 'number': {
      if (value === '' || value === null || value === undefined) return { ok: true, skip: true }
      const n = Number(value)
      if (!Number.isFinite(n)) return { ok: false, error: '应为数字' }
      if (field.min !== undefined && n < field.min) return { ok: false, error: `不能小于 ${field.min}` }
      if (field.max !== undefined && n > field.max) return { ok: false, error: `不能大于 ${field.max}` }
      return { ok: true, value: n }
    }
    case 'select': {
      const allowed = (field.options || []).map((o) => o.value)
      if (allowed.includes(value)) return { ok: true, value }
      return { ok: false, error: `只能取 ${allowed.join(' / ')}` }
    }
    case 'password': {
      // null = 保持原值（页面拿到的就是 null）；'' = 清除；其它必须是字符串
      if (value === null) return { ok: true, skip: true }
      if (typeof value !== 'string') return { ok: false, error: '应为字符串' }
      return { ok: true, value: value.trim() }
    }
    case 'dir':
    case 'text':
    default: {
      if (value === null || value === undefined) return { ok: true, skip: true }
      if (typeof value !== 'string') return { ok: false, error: '应为字符串' }
      return { ok: true, value: value.trim() }
    }
  }
}

/** 目录能不能用：建得出来、写得进去 */
export function probeDir(p) {
  const abs = expandHome(p)
  if (!abs) return { ok: true, path: '' }
  if (!isAbsolute(abs)) return { ok: false, error: '需要绝对路径（或以 ~ 开头）' }
  try {
    mkdirSync(abs, { recursive: true })
    const probe = join(abs, `.write-probe-${process.pid}-${Date.now().toString(36)}`)
    writeFileSync(probe, 'ok', 'utf8')
    unlinkSync(probe)
    return { ok: true, path: abs }
  } catch (e) {
    return { ok: false, error: `目录不可写：${e?.message ?? e}` }
  }
}

/**
 * 把任意输入（配置文件 / 页面提交 / 旧版配置）归一化成合法配置。
 *
 * @returns {{config:object, errors:Array<{path,error}>, filled:string[], ignored:string[]}}
 *   filled  因为缺失/非法而用了默认值的字段
 *   ignored 不认识、原样保留但不参与运行的字段
 */
export function normalize(raw, env = process.env) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const config = { version: CONFIG_VERSION }
  const errors = []
  const filled = []

  for (const f of SCHEMA) {
    const got = getPath(input, f.path)
    if (got === undefined) {
      // storage.dir 的默认值要写成具体路径，用户才知道东西在哪
      const dv = f.path === 'storage.dir' ? join(dshHome(env), DEFAULT_DATA_SUBDIR) : f.default
      setPath(config, f.path, dv)
      filled.push(f.path)
      continue
    }
    const r = coerce(f, got)
    if (r.ok && r.skip) {
      // 数字/文本给了空 → 用默认值（不是 0，也不是空串）
      const dv = f.path === 'storage.dir' ? join(dshHome(env), DEFAULT_DATA_SUBDIR) : f.default
      setPath(config, f.path, dv)
      filled.push(f.path)
      continue
    }
    if (!r.ok) {
      errors.push({ path: f.path, error: r.error })
      setPath(config, f.path, f.default)
      filled.push(f.path)
      continue
    }
    setPath(config, f.path, r.value)
  }

  // 交叉项：只给警告，不阻止保存（用户可能就是要这么干，但得知道后果）
  const warnings = []
  const workModeOn = getPath(config, 'workMode.enabled') === true
  if (workModeOn) {
    // 工作模式本来就强制关注入 + 关压缩，这时不该再报「模型什么都看不到」
    warnings.push({ path: 'workMode.enabled', error: '工作模式开启：重载插件后注入与压缩会被强制关闭（两个开关的值保留，退出工作模式后恢复）' })
  } else if (getPath(config, 'inject.enabled') === false && getPath(config, 'compaction.keepTurns') === 0) {
    warnings.push({ path: 'inject.enabled', error: '注入关着、历史又全部替换：模型将看不到任何历史与记忆' })
  }

  // 未知字段：保留（向前兼容），但要知道它们不起作用
  const known = new Set(SCHEMA.map((f) => f.path))
  const ignored = []
  const walk = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj || {})) {
      const p = prefix ? `${prefix}.${k}` : k
      if (k === 'version') continue
      if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, p); continue }
      if (!known.has(p)) ignored.push(p)
    }
  }
  walk(input)

  return { config, errors, warnings, filled, ignored }
}

// ============================================================
// 旧版（v1 平面结构）迁移
// ============================================================

const V1_MAP = {
  dir: 'storage.dir',
  writer: 'writer',
  apiKey: 'model.apiKey',
  apiBase: 'model.apiBase',
  preset: 'model.preset',
  bootMaxChars: 'inject.maxChars',
  inject: 'inject.enabled',
  autoCapture: 'capture.enabled',
  userCaptureChars: 'capture.userChars',
  botCaptureChars: 'capture.botChars',
  toolCaptureChars: 'capture.toolChars',
  semanticInject: 'capture.semantic.enabled',
  semanticTopK: 'capture.semantic.topK',
  semanticMinSim: 'capture.semantic.minSim',
  semanticTtlMin: 'capture.semantic.ttlMin',
  organizeEveryMin: 'organize.everyMin',
  refreshMin: 'organize.refreshMin',
  autoCompact: 'compaction.enabled',
  compactKeepTurns: 'compaction.keepTurns',
  compactArchiveChars: 'compaction.archiveChars',
  summaryChunk: 'model.summaryChunk',
}

const V1_MEMORY_MAP = {
  hotMaxChars: 'layers.hotChars',
  consolidateMaxChars: 'layers.consolidateChars',
  longMaxChars: 'layers.longChars',
  l2KeepMax: 'layers.l2KeepMax',
  forgetThreshold: 'layers.forgetThreshold',
  summaryChunk: 'model.summaryChunk',
}

/** 旧的平面配置 → v2 结构（只搬认得的键） */
export function fromV1(old) {
  const out = { version: CONFIG_VERSION }
  const o = old && typeof old === 'object' ? old : {}
  for (const [k, path] of Object.entries(V1_MAP)) {
    if (o[k] !== undefined) setPath(out, path, o[k])
  }
  for (const [k, path] of Object.entries(V1_MEMORY_MAP)) {
    if (o.memoryCfg?.[k] !== undefined) setPath(out, path, o.memoryCfg[k])
  }
  // 每阶段模型覆盖
  for (const st of ['embed', 'rerank', 'chat', 'summary']) {
    const src = o.models?.[st]
    if (!src || typeof src !== 'object') continue
    for (const k of ['base', 'apiKey', 'model', 'source']) {
      if (src[k] !== undefined && src[k] !== '') setPath(out, `model.stages.${st}.${k}`, src[k])
    }
  }
  if (o.noThink && typeof o.noThink === 'object') {
    for (const k of ['chat', 'summary']) {
      if (typeof o.noThink[k] === 'boolean') setPath(out, `model.noThink.${k}`, o.noThink[k])
    }
  }
  // 旧版的 dir 往往是 <DSH_HOME>/storages/memory1，直接搬过去
  if (o.dir) setPath(out, 'storage.dir', o.dir)
  return out
}

// ============================================================
// 读写
// ============================================================

function atomicWrite(p, text) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, p)
}

/**
 * 读配置（顺带完成「生成 / 补齐 / 修复 / 迁移」四件事）。
 *
 * @param {{env?:object, log?:(kind:string, detail?:string)=>void}} [opts]
 * @returns {{config:object, path:string, created:boolean, repaired:boolean, migrated:boolean,
 *            errors:Array, warnings:Array, ignored:string[]}}
 */
export function loadConfig(opts = {}) {
  const env = opts.env || process.env
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const p = configPath(env)
  const result = { path: p, created: false, repaired: false, migrated: false, filled: [], errors: [], warnings: [], ignored: [] }

  const write = (cfg) => {
    try { atomicWrite(p, JSON.stringify(cfg, null, 2)); return true } catch (e) {
      log('CONFIG_WRITE_FAIL', String(e?.message ?? e))
      return false
    }
  }

  // ① 已有配置文件
  if (existsSync(p)) {
    let raw = null
    try {
      raw = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    } catch (e) {
      const bad = `${p}.broken-${Date.now()}`
      try { renameSync(p, bad) } catch { /* 挪不动就用默认值跑 */ }
      log('CONFIG_BROKEN', `坏文件已改名 ${bad}：${e?.message ?? e}`)
      raw = null
    }
    if (raw && typeof raw === 'object') {
      const n = normalize(raw, env)
      result.config = n.config
      result.errors = n.errors
      result.warnings = n.warnings
      result.ignored = n.ignored
      result.filled = n.filled
      // 补齐/修正过就写回（让磁盘上永远是一份完整、合法的配置）
      if (n.filled.length || n.errors.length || raw.version !== CONFIG_VERSION) {
        result.repaired = true
        write(n.config)
      }
      if (n.filled.length) log('CONFIG_FILLED', n.filled.join(','))
      for (const e of n.errors) log('CONFIG_INVALID', `${e.path}: ${e.error}`)
      return result
    }
    // 坏文件已改名，落到 ③ 重建
  }

  // ② 旧版配置迁移（只在没有新配置时做）
  const legacy = legacyConfigPath(env)
  if (existsSync(legacy)) {
    try {
      const old = JSON.parse(readFileSync(legacy, 'utf8').replace(/^\uFEFF/, ''))
      const n = normalize(fromV1(old), env)
      result.config = n.config
      result.errors = n.errors
      result.warnings = n.warnings
      result.ignored = n.ignored
      result.filled = n.filled
      result.migrated = true
      write(n.config)
      try { renameSync(legacy, `${legacy}.v1-bak`) } catch { /* 留着也不影响 */ }
      log('CONFIG_MIGRATED', `${legacy} → ${p}`)
      return result
    } catch (e) {
      log('CONFIG_MIGRATE_FAIL', String(e?.message ?? e))
    }
  }

  // ③ 全新生成
  const n = normalize(buildDefaults(env), env)
  result.config = n.config
  result.created = true
  mkdirSync(dirname(p), { recursive: true })
  if (!write(n.config)) {
    result.errors.push({ path: 'config', error: '配置文件写不进去，本次运行使用默认值' })
  }
  log('CONFIG_CREATED', p)
  return result
}

/**
 * 保存（页面提交的补丁）。
 *
 * 只认 schema 里的字段；返回真正变了的键，页面据此显示「保存了几项」。
 * @param {object} patch 形如 { config: {...} } 或直接 {...}
 */
export function saveConfig(patch, opts = {}) {
  const env = opts.env || process.env
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const incoming = (patch && typeof patch === 'object' && patch.config && typeof patch.config === 'object')
    ? patch.config
    : (patch || {})

  const cur = loadConfig({ env, log })
  const before = JSON.stringify(cur.config)
  const merged = JSON.parse(JSON.stringify(cur.config))

  const errors = []
  const changed = []
  for (const f of SCHEMA) {
    const v = getPath(incoming, f.path)
    if (v === undefined) continue            // 没提交 = 不改
    const r = coerce(f, v)
    if (!r.ok) { errors.push({ path: f.path, error: r.error }); continue }
    if (r.skip) continue                     // 数字留空 = 不改；密码 null = 不改
    if (f.type === 'dir') {
      const probe = probeDir(r.value)
      if (!probe.ok) { errors.push({ path: f.path, error: probe.error }); continue }
      setPath(merged, f.path, expandHome(r.value) || '')
    } else {
      setPath(merged, f.path, r.value)
    }
  }

  // 目录是唯一「保存前必须能写」的字段；别的校验失败只报错，不挡其它字段保存
  if (errors.length && errors.some((e) => BY_PATH.get(e.path)?.type === 'dir')) {
    return { ok: false, errors, changed: [], config: cur.config, path: cur.path }
  }

  const n = normalize(merged, env)
  const nextText = JSON.stringify(n.config)
  const next = n.config
  for (const f of SCHEMA) {
    if (JSON.stringify(getPath(cur.config, f.path)) !== JSON.stringify(getPath(next, f.path))) changed.push(f.path)
  }
  const warnings = n.warnings
  if (nextText !== before) {
    try {
      atomicWrite(cur.path, JSON.stringify(next, null, 2))
      log('CONFIG_SAVED', changed.join(',') || '(noop)')
    } catch (e) {
      return { ok: false, errors: [{ path: 'config', error: `写入失败：${e?.message ?? e}` }], changed: [], config: cur.config, path: cur.path }
    }
  }
  return {
    ok: true, changed, errors, warnings, ignored: n.ignored,
    config: next, path: cur.path, needRestart: changed.length > 0,
  }
}

/** 给页面：去掉敏感值，但告诉它「有没有值」 */
export function maskSecrets(cfg) {
  const out = JSON.parse(JSON.stringify(cfg))
  const has = {}
  for (const f of SCHEMA) {
    if (f.type !== 'password') continue
    const v = getPath(cfg, f.path)
    has[f.path] = !!v
    setPath(out, f.path, null)     // null = 已设置但不回显；保存时回传 null 表示不改
  }
  return { config: out, hasSecrets: has }
}

/**
 * 逐字段比较「文件里的配置」和「运行中实际生效的配置」。
 * 返回需要重载才生效的 path 列表（密码字段不参与比较：无法回显，也没法可靠对比）。
 */
export function diffPaths(fileCfg, effectiveCfg) {
  if (!fileCfg || !effectiveCfg) return []
  const out = []
  for (const f of SCHEMA) {
    if (f.type === 'password') continue
    const a = getPath(fileCfg, f.path)
    const b = getPath(effectiveCfg, f.path)
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push(f.path)
  }
  return out
}

/** 页面需要的字段定义（去掉服务端内部字段） */
export function publicSchema() {
  return SCHEMA.map((f) => ({
    group: f.group, path: f.path, type: f.type, label: f.label,
    hint: f.hint || '', wide: !!f.wide,
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
    ...(f.step !== undefined ? { step: f.step } : {}),
    ...(f.options ? { options: f.options } : {}),
    ...(f.showIf ? { showIf: f.showIf } : {}),
  }))
}

// ============================================================
// 用户配置 → 引擎参数（唯一映射点）
// ============================================================

const MIN = 60 * 1000
const minutesToMs = (v, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n * MIN : dflt
}

/**
 * 把 v2 配置摊平成 ENGINE_DEFAULTS 认得的名字。
 *
 * ★ 全工程只有这一处做映射：以后改配置结构只动这里和 SCHEMA，
 *   不会再出现「配置写在 A、代码读 B」那种悄悄失效。
 */
export function toEngineCfg(cfg) {
  const g = (p, d) => {
    const v = getPath(cfg, p)
    return v === undefined || v === null ? d : v
  }
  // 工作模式：用专属的更大容量覆盖普通值（只在开启时生效）
  const work = getPath(cfg, 'workMode.enabled') === true
  const hotChars = work ? g('workMode.hotChars', 6000) : g('layers.hotChars', 3000)
  const consolidateChars = work ? g('workMode.consolidateChars', 5000) : g('layers.consolidateChars', 2500)
  const botChars = work ? g('workMode.botChars', 800) : g('capture.botChars', 400)
  const toolChars = work ? g('workMode.toolChars', 1200) : g('capture.toolChars', 500)
  return {
    hotMaxChars: hotChars,
    consolidateMaxChars: consolidateChars,
    longMaxChars: g('layers.longChars', 3000),
    l2KeepMax: g('layers.l2KeepMax', 10),
    forgetThreshold: g('layers.forgetThreshold', 0.25),
    dl1MaxChars: g('layers.dl1MaxChars', 20000),
    organizeEveryMs: minutesToMs(g('organize.everyMin', 5), 5 * MIN),
    viewRefreshMs: minutesToMs(g('organize.refreshMin', 30), 30 * MIN),
    fusionPrefilter: g('organize.fusionPrefilter', 0.82),
    botCaptureChars: botChars,
    toolCaptureChars: toolChars,
  }
}

/** 模型层的入参（同样只有这一处映射） */
export function toLlmCfg(cfg) {
  const preset = getPath(cfg, 'model.preset') || 'siliconflow'
  const stages = {}
  for (const st of ['embed', 'rerank', 'chat', 'summary']) {
    const s = getPath(cfg, `model.stages.${st}`) || {}
    const out = {}
    if (s.source) out.source = s.source
    if (s.model) out.model = s.model
    if (s.base) out.base = s.base
    if (s.apiKey) out.apiKey = s.apiKey
    if (Object.keys(out).length) stages[st] = out
  }
  // ★ preset 必须真的说了算：选「硅基流动」就忽略嵌入/精排的覆盖值（它们只是
  //   给「自己指定」用的，留着是为了切回去时不用重填）。旧版页面只隐藏输入框、
  //   不生效，结果「换了嵌入模型」的覆盖值一直悄悄用着 → 向量和查询不是同一个
  //   模型算的，检索命中率崩掉还查不出来。
  if (preset === 'siliconflow') {
    delete stages.embed
    delete stages.rerank
  }
  return {
    apiKey: getPath(cfg, 'model.apiKey') || '',
    apiBase: getPath(cfg, 'model.apiBase') || '',
    models: stages,
    noThink: {
      chat: getPath(cfg, 'model.noThink.chat') !== false,
      summary: getPath(cfg, 'model.noThink.summary') !== false,
    },
    summaryChunk: getPath(cfg, 'model.summaryChunk') || 60,
    timeoutMs: getPath(cfg, 'model.timeoutMs') || 20000,
  }
}

// ============================================================
// 配置页的服务端接口
// ============================================================

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
      if (buf.length > limit) reject(new Error('请求体过大'))
    })
    req.on('end', () => resolve(buf))
    req.on('error', reject)
  })
}

function isTrustedReq(ctx, req) {
  const addr = req.socket?.remoteAddress || ''
  const bare = addr.replace(/^::ffff:/, '')
  if (isIP(bare) && (bare === '127.0.0.1' || bare === '::1')) return true
  try {
    const conn = ctx.get?.('connection') || ctx.connection
    if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
  } catch { /* 栅栏不可用 → 按不信任处理 */ }
  return false
}

/**
 * 挂上 /dsh-memory/api/*。
 *
 * ★ 每挂一条都回调 onMounted(path)，调用方把它写进插件日志——
 *   上次「设置页永远是 404」就是因为挂载失败没有任何痕迹。
 *
 * @returns {{mounted:string[], dispose:()=>void}|null} webServer 不可用时返回 null
 */
export function installApi(ctx, opts = {}) {
  // webServer 可能来自 ctx.get（调用方已经取到实例），也可能挂在 ctx 上；两种都认
  const webServer = opts.webServer || ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') return null
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const env = opts.env || process.env
  const mounted = []
  const disposers = []

  const route = (kind, path, handler) => {
    const off = webServer.register({
      kind,
      path,
      handler: async (req, res) => {
        if (!isTrustedReq(ctx, req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
        try { await handler(req, res) } catch (e) {
          log('API_ERROR', `${path} ${e?.stack || e?.message || e}`)
          json(res, 500, { ok: false, error: String(e?.message ?? e) })
        }
      },
    })
    if (!mounted.includes(path)) mounted.push(path)
    if (typeof off === 'function') disposers.push(off)
    log('API_MOUNTED', path)
  }

  // 配置：读和写必须是**一个** handler。
  // 踩过的坑：同一路径注册两次时，宿主的「首个匹配即终止」让后注册的永远收不到请求，
  // 表现是 GET 正常、POST 405（或反过来），查半天。
  route('exact', '/dsh-memory/api/config', async (req, res) => {
    if (req.method === 'GET') {
      const loaded = loadConfig({ env, log })
      const { config, hasSecrets } = maskSecrets(loaded.config)
      // 运行中实际生效的那份（由插件在启动时加载）。页面用它做「显示值 = 实际值」核对，
      // 也用它和文件值对比，标出「改了但还没重载」的字段。
      const effectiveRaw = opts.getEffectiveConfig?.() || null
      const effective = effectiveRaw ? maskSecrets(effectiveRaw).config : null
      const pendingRestart = effective ? diffPaths(loaded.config, effectiveRaw) : []
      json(res, 200, {
        ok: true,
        version: CONFIG_VERSION,
        config, effective, hasSecrets, pendingRestart,
        schema: publicSchema(), groups: GROUPS, groupOrder: GROUP_ORDER,
        paths: { config: loaded.path, data: opts.getDataDir?.() || resolveDataDir(loaded.config, env) },
        status: {
          created: loaded.created, repaired: loaded.repaired, migrated: loaded.migrated,
          errors: loaded.errors, warnings: loaded.warnings, ignored: loaded.ignored,
        },
        run: opts.getRunState?.() || null,
      })
      return
    }

    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只接受 GET / POST' }); return }

    const raw = await readBody(req)
    let body
    try { body = JSON.parse(raw || '{}') } catch { json(res, 400, { ok: false, error: 'JSON 解析失败' }); return }
    const r = saveConfig(body, { env, log })
    if (!r.ok) { json(res, 400, { ok: false, error: r.errors?.[0]?.error || '保存失败', errors: r.errors }); return }
    const { config } = maskSecrets(r.config)
    json(res, 200, {
      ok: true,
      changed: r.changed,
      // 有些字段没通过校验被跳过（比如填了 70 的 0~1 参数）：整次保存不算失败，
      // 但必须把「哪几项没存」告诉页面，否则就是「保存成功但没变」。
      errors: r.errors,
      warnings: r.warnings,
      ignored: r.ignored,
      needRestart: r.needRestart, config, path: r.path,
    })
  })

  // 运行状态（条数 / 字数 / 待整理 / 锁 / 上次整理 / 上次错误 / 模型可用性）
  route('exact', '/dsh-memory/api/state', async (req, res) => {
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只接受 GET' }); return }
    json(res, 200, { ok: true, ...(opts.getRunState?.() || {}) })
  })

  // 日志尾
  route('exact', '/dsh-memory/api/log', async (req, res) => {
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只接受 GET' }); return }
    let lines = []
    try {
      const p = logPath(env)
      if (existsSync(p)) {
        // 只读尾巴：日志每轮都长，整份读进来再切没意义
        const size = statSync(p).size
        const start = Math.max(0, size - 32 * 1024)
        const buf = readFileSync(p, 'utf8')
        lines = buf.slice(start).split(/\r?\n/).filter(Boolean).slice(-80)
      }
    } catch { /* 读不到就当空 */ }
    json(res, 200, { ok: true, lines })
  })

  // 立即整理（L1 只看容量：没到阈值就什么都不做）
  route('exact', '/dsh-memory/api/organize', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只接受 POST' }); return }
    const mem = opts.getMem?.()
    if (!mem) { json(res, 409, { ok: false, error: '记忆系统还没就绪' }); return }
    const r = await mem.organize()
    json(res, 200, { ok: true, result: r })
  })

  return {
    mounted,
    dispose: () => { for (const off of disposers) { try { off() } catch { /* 已卸载 */ } } },
  }
}
