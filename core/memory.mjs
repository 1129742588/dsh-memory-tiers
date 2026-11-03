/**
 * dsh-memory-tiers · 记忆系统（六层）
 *
 * 这个文件只干一件事：把「本地记忆」读写到磁盘上。
 *   · 不认识 dsh、不联网、不读配置：目录 / 参数 / 模型函数全部由调用方注入
 *   · 不缓存业务状态：每次判断都看磁盘，改完立刻写回
 *
 * 数据目录（\<dataDir>/）：
 *   L1.json L2.json L3.json DL1.json DL2.json DL3.json   六层
 *   L1.tmp/\<writer>.jsonl     刚收到的原文，只追加（崩溃也不会丢半截）
 *   signals/\<writer>.jsonl    attend / pin / forget 排队，整理时统一消费
 *   vectors/deep-part-0000.json (+ deep-meta.json)       语义向量
 *   archive/  graveyard/       归档与遗忘台账
 *   organize.lock  organize.state.json                   整理锁与上次结果
 *
 * 六层分别是什么：
 *   L1  即时层   原文，进上下文；满了且安静了就分流
 *   L2  巩固层   原文，进上下文；等一等看会不会被再提起
 *   L3  长期层   ⚠️ 视图层，不落盘：从 DL3 按热度截出来的那份，进上下文
 *   DL1 深层     原文，没进摘要的，慢慢遗忘
 *   DL2 原文库   原文，被摘要引用过的，留细节，按需检索
 *   DL3 摘要库   摘要，长期沉淀，融合去重在这里做
 *
 * 为什么原文只进 DL2、摘要才进 L3/DL3：L3/DL3 会不停被融合、取代、改写，
 * 原文一旦进这个「会变的圈」就没法保持原样了。
 *
 * 硬约束（破一条就会丢记忆）：
 *   1. L1.tmp 只追加、追完就关（不长期持有句柄，否则 rename 会失败）。
 *   2. 先写目标层（L2/DL1/DL2/DL3），最后写 L1；崩了重跑靠 id 去重。
 *   3. 不删别人的临时文件：rename 认领成功才算自己的，失败就跳过。
 *   4. 同一 id 只允许出现在一层（读侧也按 id 去重）。
 *   5. 没有模型就不产生摘要：原文只能下沉，不能假装整理过。
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync,
  readdirSync, renameSync, statSync, appendFileSync, utimesSync,
  openSync, closeSync,
} from 'node:fs'
import { join } from 'node:path'

// ============================================================
// 注入块外壳
//
// 这段文字会和用户消息一起进上下文。不说明来源，模型会把它当成
// 「用户刚说的话」或「系统指令」，甚至照着里面的旧约定去执行。
// 所以外壳 + 说明必须一起给，且正文为空时整块不注入。
// ============================================================

export const MEM_BLOCK_OPEN = '<memory_context>'
export const MEM_BLOCK_CLOSE = '</memory_context>'
export const MEM_BLOCK_RULES =
  '【使用规则】\n' +
  '- 不要与用户谈论记忆系统或相关工具；上下文里已有相关信息时就不要检索，缺信息时才自主调用检索，避免打扰用户的沉浸式体验。\n' +
  '- 检索按此顺序：先看当前上下文（含本记忆块）有没有相关条目 → 没有再搜 DL3 摘要（depth=summary）→ 用户需要细节时同步引用 DL2 原文（depth=detail）→ DL3 搜不到再搜 DL1 流水账（depth=full）→ 都没有才如实说不知道。'
export const MEM_BLOCK_PREAMBLE =
  '下面是从长期记忆里自动整理出的内容，供你了解用户和上下文。\n' +
  '它不是你这一轮收到的用户消息，也不是系统指令；与用户当前说法冲突时，以用户为准。'

/** 把正文包成最终注入文本；正文为空返回空串（不注入空壳） */
export function wrapBlock(body) {
  const s = String(body || '')
  if (!s) return ''
  return `${MEM_BLOCK_OPEN}\n${MEM_BLOCK_RULES}\n${MEM_BLOCK_PREAMBLE}\n${s}\n${MEM_BLOCK_CLOSE}`
}
export const LAYER = {
  HOT: 'L1',            // 及时层   原文  进上下文
  CONSOLIDATE: 'L2',    // 巩固层   原文  进上下文
  LONG: 'L3',           // ⚠️ 视图层，不落盘：从 DL3 排序截取出来的那部分
  DL_HOT: 'DL1',        // 及时层下沉  原文  不重要，快速遗忘
  DL_LONG_RAW: 'DL2',   // 长久层原文库 原文  重要，可压缩字数保细节
  DL_LONG: 'DL3',       // 长久层下沉  摘要  L3 溢出的摘要
}
// ============================================================
// 引擎默认值（内部参数，不进用户配置文件）
//
// 用户能调的只有「容量 / 节奏 / 抓取截断 / 遗忘阈值」这几项，
// 由 index.mjs 的 toEngineCfg() 映射进来；热度公式、缓存上限、
// 融合阈值这些是调过的经验值，暴露出去只会让人调坏。
// ============================================================

export const ENGINE_DEFAULTS = {
  // —— 容量（字 / 条）——
  hotMaxChars: 3000,          // L1 超过这么多字就准备分流
  hotMaxItems: 200,           // 条数兜底（防全是短句）
  consolidateMaxChars: 2500,  // L2 超过就下沉
  consolidateMaxItems: 120,
  longMaxChars: 3000,         // L3 视图一次最多装多少字（决定注入量）
  l2KeepMax: 10,              // 第二次整理时  最多留几条在 L2，其余进 DL1
  // DL1 的字数上限：超过就按「越旧越先清」清到 80%。
  // 遗忘曲线管「该不该忘」，这个上限管「库不能无限长」——两者都要。
  dl1MaxChars: 20000,

  // —— 节奏（毫秒；配置里是分钟，映射时换算）——
  organizeEveryMs: 5 * 60 * 1000, // 定时补漏
  viewRefreshMs: 30 * 60 * 1000,  // L3 快照刷新间隔
  staleLockMs: 10 * 60 * 1000,    // 锁多久没心跳算过期
  maxOrganizeMs: 5 * 60 * 1000,   // 单轮整理硬超时

  // —— 抓取截断 ——
  botCaptureChars: 400,       // 一轮 assistant 正文拼起来后截多少
  toolCaptureChars: 500,      // 单条工具输出截多少

  // —— 分类批次（曾经被调用方误传成时间戳，见 1.0.0 变更）——
  classifyChunk: 20,          // 一次分类请求最多几条
  classifyMaxChars: 6000,     // 一次分类请求最多多少字（切小批的依据）

  // —— 分流 / 检索 ——
  fusionPrefilter: 0.82,      // 判重前先用向量筛到这个相似度才问模型
  minRerank: 0.02,            // 精排原始分的「纯噪音」硬底
  forgetThreshold: 0.25,      // DL1 保持率低于它就忘（约 14 天）

  // —— DL3 摘要淘汰：只淘汰「琐事」那一档（importance < 0.45）——
  // 重要/一般的摘要不按时间淘汰，只靠融合合并或作废。
  summaryForgetThreshold: 0.25,   // 保持率低于它就淘汰
  summaryTrivialHalfLife: 0.55,   // 琐事档的半衰期系数（相对热度半衰期，越小忘得越快）
  summaryForgetFloorDays: 1,      // 保护期：不满 1 天不淘汰

  // —— 热度（tune 出来的，别单独改一个）——
  heatHalfLife: 10,           // 半衰期基准（天）
  heatRepeatBoost: 0.3,       // 重复系数：强度越高，半衰期越长
  heatRepeatCap: 20,          // 强度封顶，防止老记忆永不衰减
  heatIdleFactor: 3,          // 隔这么久不提，强度开始回落
  heatPromoteThreshold: 1.0,  // 热度达到这条线才算「够热」

  // —— 只读层缓存（宁可慢，不可崩）——
  cacheMaxFileBytes: 64 * 1024 * 1024,          // 单文件超这个就不缓存
  cacheMaxTotalBytes: 384 * 1024 * 1024,        // 缓存总量上限（LRU 淘汰）
  cacheHeapLimitBytes: 1.5 * 1024 * 1024 * 1024, // 堆用超这个就清缓存
  cacheLayerShare: { DL3: 0.4, DL2: 0.3, DL1: 0.3 },

  // —— 观测 ——
  warnLayerItems: 200000,     // 单层超过这个条数留一条告警（不改行为）
}

// ============================================================
// 时间工具
// ============================================================

export const DAY = 86400e3

/** 按本地日期取 key，用于"按天去重" */
export function dayKey(ts) {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/**
 * 送模型的一行原文：`[MM-DD] 说话人：正文`。
 *
 * 为什么带日期：模型看不到条目的 createdAt，原文里的「明天/昨天/下周三」
 * 就没有锚点，摘要只能丢掉或原样照抄，读者过几天再看就不知道是哪天。
 * 带上这条发生的日期，模型才能把相对时间折算成具体日期。
 *
 * 用 MM-DD 而不是完整时间戳：与注入块 `lineOf` 的日期口径一致。
 */
/** 原话条目的注入/送审行带「时:分」：同一天内多条对话时模型才能分清先后 */
const hhmm = (ts) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function rawLine(it) {
  const ts = Number(it?.createdAt) || 0
  const stamp = ts > 0 ? `[${dayKey(ts).slice(5)} ${hhmm(ts)}] ` : ''
  const sp = String(it?.speaker || '').trim()
  const body = String(it?.text ?? '')
  return sp ? `${stamp}${sp}：${body}` : `${stamp}${body}`
}
// ============================================================
// 条目结构
// ============================================================

let __seq = 0
let __idn = 0
// 尾部那 4 位随机是给「两个进程共用一个库」用的：__idn 是进程内计数器，
// 两个进程都从 1 开始，纯计数器必然撞 id；加随机数后同毫秒同序号撞上的概率约 1/1.7e6。
// 前缀固定 m_，历史库里的 m5_ 前缀照旧能读（id 只是字符串，不用改旧数据）。
const nextId = () =>
  `m_${(++__idn).toString(36)}_${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`

export function makeItem({
  text,
  layer = LAYER.HOT,
  channel = 'dialog',
  speaker = '',
  people = [],
  scene = '',
  importance = 0.5,
  kind = 'raw',
  at = Date.now(),
} = {}) {
  const folks = [...new Set([...(people || []), speaker].map((x) => String(x || '').trim()).filter(Boolean))]
  return {
    id: nextId(),
    seq: ++__seq,
    text: String(text || '').trim(),
    kind,                       // raw | summary
    channel,                    // dialog | action | event | note
    layer,

    // —— 谁跟谁 ——
    speaker,
    people: folks,
    scene,

    // —— 重要性 ——
    importance,                 // 0~1，写入时判定，之后只在融合时修正
    directEntry: false,         // 是否未经巩固期直通而来（影响下沉排序）

    // —— 热度（D12）——
    // ★ 初始为 1：写入本身就算一次"发生"。
    //   如果初始为 0，写入当天的第一次 touchHeat 会被"按天去重"跳过，
    //   结果新记忆的热度永远是 0，一辈子进不了长久层。
    heat: 1,
    lastMentionedAt: at,        // 上次被提及的时间（用于算衰减）
    repeatStrength: 1,          // 重复强度累积（写入算 1，之后按间隔质量加）
    // ★ 两个计数，语义不同（2026-10-31 用户校正）：
    //
    //   fusionCount  融合次数 / 重复次数
    //                同一件事被反复说、最后被合并掉几次。
    //                这是**内容本身的重复度**——「这句话说过多少遍」。
    //                在 DL3 融合时累加（见 fuseIntoDL3）。
    //
    //   recallCount  关注次数
    //                被会话模型**确认相关**后用过几次。
    //                注意不是"被搜到几次"——搜到可能是误命中，
    //                模型拿到后自己判断出无关，那这次就不该算（会形成回音室：
    //                被误搜到的记忆反而越来越热，越搜越靠前）。
    //                只有 mem.attend(ids) 明确确认后才 +1。
    fusionCount: 0,             // 融合次数（重复次数）
    recallCount: 0,             // 关注次数（被确认相关的次数）

    // —— 矛盾 ——
    supersededBy: null,         // 被哪条取代（null = 仍然有效）

    // —— 时间 ——
    createdAt: at,
    archivedAt: null,
    spanFrom: null,             // 摘要专用
    spanTo: null,

    // —— 其它 ——
    pinned: false,
    archiveFile: null,
  }
}
// ============================================================
// 热度（D12）
//
// 核心两条：
//   1. 同一天多次提及只算一次 —— 否则爆发会压过持续
//   2. 每次提及先让旧热度衰减，再 +1
// ============================================================

/**
 * 间隔质量（间隔重复效应）
 *
 * ★ 什么时候重复，跟重复几次一样重要。
 *   同样两次提及，"隔几天"比"隔一天"强化效果好得多——
 *   隔一天时你还记得，重复几乎没意义。
 *
 *   ratio = 距上次的天数 / 半衰期
 *     0.05（隔 1 天）  → 0.40   几乎没强化
 *     0.46（隔 6 天）  → 0.71
 *     0.83（隔 15 天） → 0.92   快忘了但还没忘，最有效
 *     1.65（隔 30 天） → 1.00   封顶
 *
 * 实测（基准 10 / 系数 0.3）：同样只提两次，
 *   隔 1 天  → 30 天后剩 0.35
 *   隔 14 天 → 30 天后剩 0.70   ← 两倍
 */
export function spacingQuality(ratio) {
  return Math.min(1, 0.15 + 0.85 * Math.log2(1 + Math.max(0, ratio)))
}

/**
 * 该条目的热度半衰期（天）
 *
 * ★ 只随"活跃天数"变长，不随 importance 变。
 *
 *   这是艾宾浩斯的重复效应：被强化过多次的记忆，忘得更慢。
 *   反例（用户提出）：
 *     A 在第 1、5、9、30 天被提（活跃 4 天）
 *     B 只在第 0、30 天被提（活跃 2 天）
 *     到第 30 天两者热度可能相等，但 30 天后 A 该衰减更慢。
 *
 *   用 log 而不是线性，是为了避免"提得越多越忘不掉"——
 *   20 次封顶后半衰期稳定在 45 天左右，不会无限增长。
 */
/**
 * 「现在还剩多少强化」——记忆强度本身也会回落。
 *
 * 艾宾浩斯的核心不是「衰减」，是**间隔重复**：
 *   · 隔合理的时间再提一次，记忆强度涨得最多（`spacingQuality`）
 *   · 长期不提，连"强度"本身都会淡掉——不是只剩热度在掉，
 *     而是下一次衰减会更**快**（半衰期变短）
 *
 * 所以这里做两件事：
 *   1. 原始 `repeatStrength` 保留（台账，看得出历史上被强化过多少次）
 *   2. 参与计算的是"回落后的强度"：距上次提及每过一个 `idleHalf` 天折半，
 *      下限回落到 1（基线）
 *
 * `idleHalf` 取正常半衰期的 `heatIdleFactor` 倍（默认 3），
 * 避免"刚提过就开始掉"——刚强化完的那几天强度应该是满的。
 */
export function effectiveStrength(item, now = Date.now(), cfg = ENGINE_DEFAULTS) {
  const c = { ...ENGINE_DEFAULTS, ...(cfg || {}) }
  const raw = Math.max(Number(item?.repeatStrength) || 1, 1)
  if (raw <= 1) return 1
  const last = Number(item?.lastMentionedAt ?? item?.createdAt ?? now)
  const idle = Math.max(0, (now - last) / DAY)
  const idleHalf = (c.heatHalfLife || 10) * (c.heatIdleFactor ?? 3)
  return 1 + (raw - 1) * Math.pow(0.5, idle / idleHalf)
}

export function halfLifeOf(item, cfg = ENGINE_DEFAULTS, now = Date.now()) {
  const c = { ...ENGINE_DEFAULTS, ...(cfg || {}) }
  const n = Math.min(Math.max(effectiveStrength(item, now, cfg), 1), c.heatRepeatCap)
  return c.heatHalfLife * (1 + c.heatRepeatBoost * Math.log2(1 + n))
}

/**
 * 记录一次"被提及"（检索命中 / 融合 / 用户主动提起）
 * 同一天重复调用不累加，符合"一天听 20 遍不等于记牢 20 倍"
 */
export function touchHeat(item, now = Date.now(), cfg = ENGINE_DEFAULTS) {
  // ⚠️ 必须用 ?? 不能用 ||：时间戳 0 是 falsy，用 || 会跳过它导致 dt 算错
  const last = item.lastMentionedAt ?? item.createdAt ?? now

  // ★ 按天去重：同一天不再加分，只把时间推到今天
  if (dayKey(now) === dayKey(last)) {
    item.lastMentionedAt = Math.max(last, now)
    return item.heat
  }

  // 先用"当前活跃天数"算出的半衰期做衰减，再加"间隔质量"，最后活跃天数 +1
  const dt = (now - last) / DAY
  const halfLife = halfLifeOf(item, cfg, last)
  const ratio = dt / halfLife
  const q = spacingQuality(ratio)
  item.heat = (item.heat || 0) * Math.pow(0.5, ratio) + q
  // ★ 强度累积决定之后的半衰期，间隔越合理涨得越多。
  //   不能只把 q 加到 heat 上——那点增量会被更长的间隔衰减吃掉，
  //   实测"隔1天"和"隔14天"会完全相等，等于没做间隔效应。
  // 先让旧的强化按遗忘曲线回落，再加这次的分——否则回落永远被抹掉
  item.repeatStrength = effectiveStrength(item, last, cfg) + q
  item.lastMentionedAt = now
  return item.heat
}

/**
 * 当前有效热度（纯读，不改数据）
 * 用于判定"有没有资格升长久层"
 */
export function heatOf(item, now = Date.now(), cfg = ENGINE_DEFAULTS) {
  const last = item.lastMentionedAt ?? item.createdAt ?? now
  const dt = Math.max(0, (now - last) / DAY)
  const halfLife = halfLifeOf(item, cfg, last)
  return (item.heat || 0) * Math.pow(0.5, dt / halfLife)
}

/**
 * 一个计数指标"现在还剩多少"——按艾宾浩斯遗忘曲线衰减。
 *
 * 艾宾浩斯：R = e^(-t/S)，S 是记忆强度。
 * 这里沿用 heat 的半衰期口径：`0.5^(t / 半衰期)`，与 `e^(-t/S)` 等价
 * （S = 半衰期 / ln2）。半衰期本身由 `repeatStrength` 决定，
 * 也就是"被重复得越多，忘得越慢"。
 *
 * 为什么两个计数必须衰减：
 *   `fusionCount` / `recallCount` 原来是裸计数器，只增不减。
 *   一条一年前被重复过 20 次的记忆，会永远压过昨天刚被关注 3 次的那条——
 *   但"一年前被反复说"说明不了它现在还有用。
 *
 * @param atField 该指标最后一次发生的时间字段（缺失时退回 lastMentionedAt/createdAt）
 */
export function effectiveCount(item, field, atField, now = Date.now(), cfg = ENGINE_DEFAULTS) {
  const n = Number(item?.[field]) || 0
  if (n <= 0) return 0
  const last = Number(item?.[atField] ?? item?.lastMentionedAt ?? item?.createdAt ?? now)
  const dt = Math.max(0, (now - last) / DAY)
  return n * Math.pow(0.5, dt / halfLifeOf(item, cfg, now))
}

/** 衰减后的「融合强度 / 关注强度」，用于 DL3 排序与淘汰 */
export function memoryStrength(item, now = Date.now(), cfg = ENGINE_DEFAULTS) {
  return {
    fusion: effectiveCount(item, 'fusionCount', 'lastFusedAt', now, cfg),
    recall: effectiveCount(item, 'recallCount', 'lastRecalledAt', now, cfg),
  }
}

/** 融合一次：计数 +1，并记下这次发生的时间（衰减从这里起算） */
export function markFused(item, now = Date.now()) {
  item.fusionCount = (Number(item.fusionCount) || 0) + 1
  item.lastFusedAt = now
  return item.fusionCount
}

/** 被关注一次（attend / 明确引用）：计数 +1，并记下时间 */
export function markRecalled(item, now = Date.now()) {
  item.recallCount = (Number(item.recallCount) || 0) + 1
  item.lastRecalledAt = now
  return item.recallCount
}
/** 余弦相似度 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

const DATA_LAYERS = ['L1', 'L2', 'DL1', 'DL2', 'DL3']
const ALL_LAYERS = ['L1', 'L2', 'L3', 'DL1', 'DL2', 'DL3']


const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const chars = (list) => list.reduce((s, it) => s + String(it?.text || '').length, 0)
const uniq = (a) => [...new Set(a.filter(Boolean))]

function srcKey(items) {
  const s = items.map((it) => it.id).sort().join(',')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `k${(h >>> 0).toString(36)}`
}

/**
 * 按轮次取旧的一半：从旧到新整轮拿，直到剩下的字数 ≤ cap/2。
 * 一轮特别大时会把整层取空，这是允许的（用户 2026-11-01 确认）。
 *
 * 只看容量，不看"安静了多久"：L1 一过阈值就该分流（1.2.0 起，作者定）。
 *
 * 导出是为了单测能直接验"不切断问答"这件事。
 */
export function pickTurnBatch(items, cap, { orderKey = (it) => it.createdAt, maxItems = Infinity } = {}) {
  if (!items.length) return []
  const total = chars(items)
  if (total <= cap && items.length <= maxItems) return []
  const groups = new Map()
  for (const it of items) {
    const k = it.turnId || it.id
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(it)
  }
  const turns = [...groups.values()]
    .map((g) => ({ items: g, t: Math.min(...g.map(orderKey)) }))
    .sort((a, b) => a.t - b.t)
  // 钉住的轮次永远取不走，不能算进"剩余"里——否则它们占着额度，
  // 其余轮次会被全部取空（不丢数据，但会把 L1 白搬一遍）。
  const pinnedTurns = turns.filter((t) => t.items.some((it) => it.pinned))
  const pinnedChars = pinnedTurns.reduce((s, t) => s + chars(t.items), 0)
  const pinnedItems = pinnedTurns.reduce((s, t) => s + t.items.length, 0)
  let remaining = total - pinnedChars
  let remainingItems = items.length - pinnedItems
  const charTarget = cap / 2
  const itemTarget = maxItems === Infinity ? Infinity : Math.ceil(maxItems / 2)
  const out = []
  for (const turn of turns) {
    if (remaining <= charTarget && remainingItems <= itemTarget) break
    if (turn.items.some((it) => it.pinned)) continue   // 钉住的轮次不参与溢出
    out.push(...turn.items)
    remaining -= chars(turn.items)
    remainingItems -= turn.items.length
  }
  return out
}

// ============================================================
// 小工具
// ============================================================

function atomicWrite(p, body) {
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  let lastErr = null
  for (let i = 0; i < 6; i++) {
    try {
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, p)
      return true
    } catch (e) {
      lastErr = e
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(e.code)) break
      // Windows：目标正被读，等一下再试。
      // ★ 不用 while 空转：Node 是单线程，空转 30ms 会把整个进程占满（所有请求都卡住）。
      //   Atomics.wait 是同步睡眠，让出 CPU；环境不支持时退回限次空转。
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
      } catch {
        const until = Date.now() + 10
        while (Date.now() < until) { /* 退化：最多 10ms */ }
      }
    }
  }
  try { unlinkSync(tmp) } catch { /* 清不掉也无所谓 */ }
  throw new Error(`写文件失败 ${p}: ${lastErr?.message || lastErr}`)
}

function readJsonl(p) {
  let raw
  try { raw = readFileSync(p, 'utf8') } catch { return { items: [], bad: 0 } }
  const items = []
  let bad = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { items.push(JSON.parse(line)) } catch { bad++ }
  }
  return { items, bad }
}

function appendJsonl(p, items) {
  if (!items.length) return
  mkdirSync(join(p, '..'), { recursive: true })
  appendFileSync(p, items.map((it) => JSON.stringify(it)).join('\n') + '\n', 'utf8')
}
const sanitizeWriter = (w) =>
  String(w || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'default'

/**
 * 造一个记忆实例。
 *
 * 分工：
 *   · 写：调用方只往 L1.tmp/<writer>.jsonl 追加（追加、不调模型、不碰别的文件）
 *   · 整理：谁先拿到钥匙谁动其余五层——open('wx') 抢锁 → rename 认领所有 temp →
 *     并进 L1 → 按整轮溢出（L1 旧半；L2 旧半 + DL1 全部）→ 刷新 L3 快照 → 放钥匙
 *   · 信号：attend / pin / forget 先写 signals/<writer>.jsonl 排队，整理时统一消费
 *   · 读：按层读文件；要细节时顺着摘要的 sources 去 DL2 取原文
 *
 * 注入数据全部来自调用方：
 *   @param {object} o
 *   @param {string} o.dir            数据目录（必填）
 *   @param {string} [o.writer]       写者标识，只影响 temp / signals 文件名
 *   @param {string} [o.logFile]      审计日志路径（放配置目录，不进记忆库）
 *   @param {string} [o.embedSignature] 嵌入模型指纹，换了就忽略旧向量
 *   @param {() => number} [o.now]    可注入时钟（测试用）
 *   @param {object} [o.cfg]          覆盖 ENGINE_DEFAULTS
 *   @param {Function} [o.embed]      texts[] => number[][]
 *   @param {Function} [o.rerank]     (query, docs) => [{index, score}]
 *   @param {Function} [o.summarizeWithSources] (lines, channel, people, hint) => {summaries, keep, maxLines}
 *   @param {Function} [o.classify] / [o.classifyBatch]  重要度分类
 *   @param {Function} [o.judgeRelation] (a, b) => 'duplicate'|'contradiction'|'update'|null
 */
export function createMemory(o = {}) {
  const cfg = { ...ENGINE_DEFAULTS, ...(o.cfg || {}) }
  const dir = o.dir || '.memory'
  const writer = sanitizeWriter(o.writer)
  const tick = o.now || (() => Date.now())
  const embed = typeof o.embed === 'function' ? o.embed : null
  const vectorsDisabled = !embed

  const paths = {
    L1: join(dir, 'L1.json'),
    L2: join(dir, 'L2.json'),
    L3: join(dir, 'L3.json'),
    DL1: join(dir, 'DL1.json'),
    DL2: join(dir, 'DL2.json'),
    DL3: join(dir, 'DL3.json'),
  }
  const tmpDir = join(dir, 'L1.tmp')
  const sigDir = join(dir, 'signals')
  const vecDir = join(dir, 'vectors')
  const vecPath = join(vecDir, 'deep-part-0000.json')
  const vecMetaPath = join(vecDir, 'deep-meta.json')
  const lockPath = join(dir, 'organize.lock')
  const statePath = join(dir, 'organize.state.json')
  const appliedPath = join(sigDir, 'applied.json')
  // 审计日志走调用方给的路径（配置文件旁边），不写进记忆库；
  // 没给就退回老位置，免得某个调用方忘了传就把审计静默丢了。
  const auditPath = o.logFile || join(dir, 'audit.log')
  const gravePath = join(dir, 'graveyard', 'forgotten.jsonl')

  for (const p of [dir, tmpDir, sigDir, vecDir, join(dir, 'archive'), join(dir, 'graveyard')]) {
    try { mkdirSync(p, { recursive: true }) } catch { /* 已存在 */ }
  }

  // 空目录（首次指向这里）→ 生成骨架：六层文件 + 归档/遗忘台账/向量/信号目录。
  // 让「记忆库长什么样」一眼可见，也免得各读取方各自处理"文件不存在"。
  for (const p of Object.values(paths)) {
    try {
      if (!existsSync(p)) writeFileSync(p, JSON.stringify({ version: 2, at: Date.now(), items: [] }, null, 1), 'utf8')
    } catch { /* 只读目录就跳过，真要写的时候还会再试 */ }
  }
  try {
    const grave = join(dir, 'graveyard', 'forgotten.jsonl')
    if (!existsSync(grave)) writeFileSync(grave, '', 'utf8')
  } catch { /* 同上 */ }

  // 崩溃/重装留下的残渣：整理到一半的 *.claimed-*、被接管的锁 *.stale-*。
  // 它们不会再被任何流程读到（认领只认 *.jsonl），只会越堆越多，所以启动清一次。
  try {
    let swept = 0
    for (const d of [tmpDir, sigDir, dir]) {
      for (const f of readdirSync(d)) {
        if (!/\.(claimed|stale)-/.test(f)) continue
        try { unlinkSync(join(d, f)); swept++ } catch { /* 被占用就下次再说 */ }
      }
    }
    if (swept) audit(`SWEEP_STALE ${swept} 个半截文件`)
  } catch { /* 目录读不了就算了，不影响启动 */ }

  // —— 模型调用计数（四个数分开记：调用次数 / 处理条数）——
  const calls = {
    embed: { rounds: 0, items: 0 },
    summarize: { rounds: 0, items: 0 },
    relation: { rounds: 0, items: 0 },
    rerank: { rounds: 0, items: 0 },
  }
  const bump = (k, n = 1) => { calls[k].rounds++; calls[k].items += n }

  function audit(line) {
    if (!auditPath) return
    const safe = String(line).replace(/[\r\n]+/g, ' ')
    try { appendFileSync(auditPath, `${new Date().toISOString()} ${safe}\n`, 'utf8') } catch { /* 审计失败不挡主流程 */ }
  }

  // ============================================================
  // 文件读写
  // ============================================================

  function readLayer(name, { strict = false } = {}) {
    const p = paths[name]
    let raw
    try { raw = readFileSync(p, 'utf8') } catch (e) {
      if (e.code === 'ENOENT') return []
      if (strict) throw e
      audit(`READ_FAIL ${name} ${e.message}`)
      return []
    }
    try {
      const j = JSON.parse(raw)
      return Array.isArray(j?.items) ? j.items : []
    } catch (e) {
      // 整理路径（strict）必须抛：它要保证「不拿一份残缺的库去覆盖」。
      // 只读路径（注入 / 检索 / 统计）不抛：一条坏文件不该让整块记忆消失，
      // 当这层是空的 + 留一条审计，其余的层照常工作。
      if (strict) throw new Error(`层文件损坏 ${name}: ${e.message}`)
      audit(`READ_CORRUPT ${name} ${e.message}`)
      return []
    }
  }

  function writeLayer(name, items) {
    atomicWrite(paths[name], JSON.stringify({ version: 2, at: Date.now(), items }, null, 1))
  }

  // ============================================================
  // 只读层缓存
  //
  // ★ 只给**只读路径**用：search / buildBlock / stats / list。
  //   整理路径（loadDb → digest → saveDb）必须走 readLayer 直读——
  //   digest 会就地改条目（layer / text / supersededBy / sources），
  //   如果改的是缓存里的对象，就成了"内存里有、磁盘上没有"，下次读还拿到脏数据。
  //
  // ★ 失效判据是 mtime + size，和"每次都读"完全等价，只是省掉 JSON.parse：
  //   对方一写盘（tmp + rename），mtime 必变，下一次读就重解析。
  //
  // ★ 防内存不足（三条闸门，触发任一条就退回直读，不影响正确性）：
  //     单文件 > cacheMaxFileBytes    → 不缓存（大库只慢，不涨内存）
  //     估算占用 > cacheMaxTotalBytes → LRU 淘汰到上限以内
  //     堆已用 > cacheHeapLimitBytes  → 清空缓存，本轮不写
  // ============================================================
  const layerCache = new Map()       // name -> { sig, items, bytes }
  let cacheBytes = 0
  const cacheStat = { hits: 0, misses: 0, evicts: 0, skipped: 0 }

  const cacheLimitFile = Number(cfg.cacheMaxFileBytes) || 64 * 1024 * 1024
  const cacheLimitTotal = Number(cfg.cacheMaxTotalBytes) || 384 * 1024 * 1024
  const cacheHeapLimit = Number(cfg.cacheHeapLimitBytes) || 1.2 * 1024 * 1024 * 1024

  function layerSig(name) {
    try { const st = statSync(paths[name]); return { sig: `${st.mtimeMs}:${st.size}`, size: st.size } } catch { return null }
  }

  let l2SortCache = null   // { sig, list }

  function clearLayerCache() { layerCache.clear(); cacheBytes = 0; l2SortCache = null }

  /**
   * L2 按 consolidatedAt 升序（老的在前）。
   *
   * 10 万条排序约 100ms，而注入是每条消息都跑；层文件没变就直接用上次的结果。
   * 签名与层缓存同源（mtime+size），对方写盘后自动重排。
   */
  function sortedL2(raw) {
    const meta = layerSig('L2')
    const sig = meta ? meta.sig : ''
    if (l2SortCache && l2SortCache.sig === sig) return l2SortCache.list
    const list = raw
      .filter((it) => !it.supersededBy)
      .sort((a, b) => ((a.consolidatedAt ?? a.createdAt) - (b.consolidatedAt ?? b.createdAt)) || cmpId(a.id, b.id))
    l2SortCache = { sig, list }
    return list
  }

  function readLayerCached(name) {
    const meta = layerSig(name)
    const hit = meta ? layerCache.get(name) : null
    if (hit && hit.sig === meta.sig) {
      cacheStat.hits++
      layerCache.delete(name); layerCache.set(name, hit)   // LRU：挪到队尾
      return hit.items
    }

    cacheStat.misses++
    // 解析本身仍可能失败（文件损坏）——和原来一样抛给调用方，不吞异常
    const items = readLayer(name)

    try {
      if (!meta || meta.size > cacheLimitFile) { cacheStat.skipped++; return items }
      // 解析后的对象大约是 JSON 文本的 2~3 倍
      const bytes = meta.size * 3
      const share = Number(cfg.cacheLayerShare?.[name]) || 0.1
      const layerLimit = cacheLimitTotal * share
      if (bytes > layerLimit) { cacheStat.skipped++; return items }
      if (process.memoryUsage().heapUsed > cacheHeapLimit) {
        clearLayerCache()
        cacheStat.skipped++
        return items
      }
      if (hit) { cacheBytes -= hit.bytes; layerCache.delete(name) }
      layerCache.set(name, { sig: meta.sig, items, bytes })
      cacheBytes += bytes
      while (cacheBytes > cacheLimitTotal && layerCache.size > 1) {
        const [k, v] = layerCache.entries().next().value
        layerCache.delete(k)
        cacheBytes -= v.bytes
        cacheStat.evicts++
      }
    } catch { /* 缓存失败不影响读到的数据 */ }
    return items
  }

  /**
   * 层内 id → 条目索引（懒建，挂在缓存条目上，建一次一直用）。
   * 返回 null 表示这层没进缓存（文件太大 / 堆太紧），调用方退回线性查找。
   */
  function cachedIndex(name) {
    const hit = layerCache.get(name)
    const meta = layerSig(name)
    if (!hit || !meta || hit.sig !== meta.sig) return null
    if (!hit.byId) {
      hit.byId = new Map()
      for (const it of hit.items) hit.byId.set(it.id, it)
    }
    return hit.byId
  }

  /** 确保某层已进缓存并返回索引；没进缓存返回 null */
  function ensureIndex(name) {
    try { readLayerCached(name) } catch { return null }
    return cachedIndex(name)
  }

  function tempPath(w = writer) { return join(tmpDir, `${w}.jsonl`) }

  function readTempsAll() {
    const out = []
    let files = []
    try { files = readdirSync(tmpDir) } catch { return { items: out, bad: 0 } }
    let bad = 0
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const r = readJsonl(join(tmpDir, f))
      out.push(...r.items)
      bad += r.bad
    }
    return { items: out, bad }
  }

  /** 把当前所有 temp（含上次遗留的 claimed）改名认领。失败=对方正在写，下一轮再试 */
  function claimTemps() {
    const claimed = []
    let files = []
    try { files = readdirSync(tmpDir) } catch { return claimed }
    const now = Date.now()
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const from = join(tmpDir, f)
      const to = join(tmpDir, `${f.replace(/\.jsonl$/, '')}.claimed-${now}-${Math.random().toString(36).slice(2, 6)}.jsonl`)
      try { renameSync(from, to); claimed.push(to) } catch { /* 被打开/正在写，跳过 */ }
    }
    return claimed
  }

  function claimSignals() {
    const claimed = []
    let files = []
    try { files = readdirSync(sigDir) } catch { return claimed }
    const now = Date.now()
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const from = join(sigDir, f)
      const to = join(sigDir, `${f.replace(/\.jsonl$/, '')}.claimed-${now}-${Math.random().toString(36).slice(2, 6)}.jsonl`)
      try { renameSync(from, to); claimed.push(to) } catch { /* 被打开，跳过 */ }
    }
    return claimed
  }

  // ============================================================
  // 向量
  // ============================================================

  let vectors = new Map()
  let vectorsDirty = false
  let vecSig = ''

  function vecFileSig() {
    try { const st = statSync(vecPath); return `${st.mtimeMs}:${st.size}` } catch { return '' }
  }

  /** 别的进程可能刚写了新向量；文件变了就重读（不重读会一直用启动时那份） */
  function maybeReloadVectors() {
    if (vectorsDisabled) return
    const s = vecFileSig()
    if (s === vecSig) return
    loadVectors()
  }

  function loadVectors() {
    if (vectorsDisabled) return
    vecSig = vecFileSig()
    vectorsDirty = false
    vectors = new Map()
    let meta = null
    try { meta = JSON.parse(readFileSync(vecMetaPath, 'utf8')) } catch { /* 老库没 meta */ }
    if (meta && typeof meta.sig === 'string' && o.embedSignature && meta.sig !== o.embedSignature) {
      // 嵌入模型换了：旧向量不可比较。数据不重要，直接不用（文件留着，不删）。
      audit(`VEC_STALE ${meta.sig} → ${o.embedSignature}，忽略旧向量`)
      vectors = new Map()
      return
    }
    let raw
    try { raw = JSON.parse(readFileSync(vecPath, 'utf8')) } catch { return }
    for (const [id, b64] of Object.entries(raw || {})) {
      try {
        const buf = Buffer.from(b64, 'base64')
        vectors.set(id, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
      } catch { /* 单条坏了不连累别人 */ }
    }
  }

  function saveVectors() {
    if (vectorsDisabled || !vectorsDirty) return
    const out = {}
    for (const [id, v] of vectors) out[id] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
    atomicWrite(vecPath, JSON.stringify(out))
    const first = vectors.values().next().value
    atomicWrite(vecMetaPath, JSON.stringify({
      sig: o.embedSignature || '', dim: first ? first.length : 0, count: vectors.size, at: new Date().toISOString(),
    }, null, 1))
    vectorsDirty = false
    vecSig = vecFileSig()
  }

  async function embedInto(items, chunk = 32) {
    if (!embed || !items.length) return 0
    // ★ 已经有向量的不重算。L2 溢出时这一批里带着「DL1 全部」，
    //   它们早就 embed 过了；不过滤等于每次 L2 溢出都把整个 DL1 重算一遍（白花钱）。
    const todo = items.filter((it) => it && it.id && !vectors.has(it.id))
    if (!todo.length) return 0
    items = todo
    let n = 0
    for (let i = 0; i < items.length; i += chunk) {
      const slice = items.slice(i, i + chunk)
      const texts = slice.map((it) => String(it.text || '').slice(0, 512))
      bump('embed', slice.length)
      try {
        const res = await embed(texts)
        for (let j = 0; j < slice.length; j++) {
          if (res?.[j]) { vectors.set(slice[j].id, Float32Array.from(res[j])); n++; vectorsDirty = true }
        }
      } catch (e) {
        // 这一块失败不影响落库；但要留痕，否则"为什么这条没有语义分"查不到
        audit(`MODEL_FAIL embed chunk=${slice.length} ${e?.message ?? e}`)
      }
    }
    return n
  }

  async function embedOne(text) {
    if (!embed) return null
    bump('embed', 1)
    try { const r = await embed([String(text || '').slice(0, 512)]); return r?.[0] ? Float32Array.from(r[0]) : null } catch { return null }
  }

  // ============================================================
  // 写：只追加自己的 temp
  // ============================================================

  let turnCounter = 0
  const newTurnId = () => `${writer}-${Date.now().toString(36)}-${(++turnCounter).toString(36)}-${Math.random().toString(36).slice(2, 5)}`

  function writeTurn(rows = []) {
    const list = (rows || []).filter((r) => r && String(r.text || '').trim())
    if (!list.length) return { ok: false, error: '内容为空' }
    const turnId = list[0].turnId || newTurnId()
    const now = tick()
    const items = list.map((r) => {
      const it = makeItem({
        text: String(r.text).trim(),
        channel: r.channel || 'dialog',
        speaker: r.speaker || '',
        people: r.people || [],
        scene: r.scene || '',
        importance: Number.isFinite(Number(r.importance)) ? Number(r.importance) : 0.5,
        kind: r.kind || 'raw',
        at: r.at ?? now,
      })
      it.layer = 'L1'
      it.turnId = turnId
      it.origin = writer
      // 没显式给 importance：先按 0.5 落库，打 impRough 等溢出时问模型复核。
      // 写入路径上一次模型往返就是一两秒延迟，而刚写进来的条目可能马上被
      // 合并/作废，那时候分类纯属浪费——所以分类挪到整理时整批做（refineImportance）。
      if (!Number.isFinite(Number(r.importance)) || r.impRough) it.impRough = true
      return it
    })
    appendJsonl(tempPath(), items)
    audit(`WRITE_TURN ${turnId} ${items.length} 条`)
    return { ok: true, turnId, ids: items.map((it) => it.id), layer: 'L1' }
  }

  const write = (args = {}) => writeTurn([args])
  const writeMany = (list = []) => writeTurn(list)

  // ============================================================
  // 读：L1 视图（真 L1 + 所有 temp），按 id 去重
  // ============================================================

  function dedupe(items) {
    const seen = new Set()
    const out = []
    for (const it of items) {
      if (!it || !it.id || seen.has(it.id)) continue
      seen.add(it.id)
      out.push(it)
    }
    return out
  }

  /**
   * L1 视图 = 真 L1 + 所有 temp，按 id 去重。
   *
   * ★ 不再自己读 DL1/DL2/DL3 做"已下沉"比对（2026-11-02）。
   *   原来每轮注入都要全量解析三个深层文件——DL1 上千条时是 10~30ms 的同步 IO，
   *   Node 单线程，这段时间整个进程是卡住的。而正常流程下 L1 根本不含深层条目：
   *   `saveDb` 特意"先写目标层、最后写 L1"，`reconcile` 整理时还会再对一次账。
   *   只有崩溃后才可能出现交叉，那时重复显示一条（不是丢），下一次整理就清掉。
   *
   * @param {{placed?: Set<string>}} [opts] 已确认在别的层里的 id（调用方手上有就传，
   *   比如 buildBlock 已经读过 L2，顺手给出，不用再读一次）
   */
  function readL1View({ placed = null } = {}) {
    const temp = readTempsAll()
    const base = (() => { try { return readLayerCached('L1') } catch { return [] } })()
    const all = dedupe([...base, ...temp.items])
    try { for (const it of readLayerCached('L2')) placed.add(it.id) } catch { /* 忽略 */ }
    return { items: placed ? all.filter((it) => !placed.has(it.id)) : all, bad: temp.bad }
  }

  // ============================================================
  // 整理：钥匙 + 合并 + 分流
  // ============================================================

  let lockHeld = false
  let lockWriter = ''
  let lockToken = ''

  function readLock() {
    try { return JSON.parse(readFileSync(lockPath, 'utf8')) } catch { return null }
  }

  function acquireLock() {
    try {
      const fd = openSync(lockPath, 'wx')
      lockToken = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, writer, at: Date.now(), tab: lockToken, phase: 'start' }))
      } finally { closeSync(fd) }
      lockHeld = true
      lockWriter = writer
      return true
    } catch (e) {
      if (e.code !== 'EEXIST') { audit(`LOCK_FAIL ${e.message}`); return false }
      let st = null
      try { st = statSync(lockPath) } catch { return acquireLock() }
      if (Date.now() - st.mtimeMs < cfg.staleLockMs) return false
      // 心跳过期：把旧锁改名（原子），再抢一次
      try { renameSync(lockPath, `${lockPath}.stale-${Date.now()}`) } catch { return false }
      return acquireLock()
    }
  }

  /**
   * 持锁期间确认"这把钥匙还是我的"。
   * 如果整理卡在模型调用里超过 staleLockMs，另一端会接管；接管后这边必须停手，
   * 否则两个写者同时改深层文件，会互相覆盖。
   */
  function checkLock() {
    if (!lockHeld) throw new Error('没有钥匙')
    const cur = readLock()
    if (!cur || cur.tab !== lockToken) throw new Error('钥匙被接管，放弃本轮')
  }

  function heartbeat() {
    if (!lockHeld) return
    const cur = readLock()
    if (cur && cur.tab && cur.tab !== lockToken) { lockHeld = false; return }  // 已被接管
    try { utimesSync(lockPath, new Date(), new Date()) } catch { /* 锁没了就下次再抢 */ }
  }

  function releaseLock() {
    if (!lockHeld) return
    const cur = readLock()
    // 只删自己的锁；被接管后不能把新主人的锁删掉
    if (!cur || !cur.tab || cur.tab === lockToken) {
      try { unlinkSync(lockPath) } catch { /* 已没 */ }
    }
    lockHeld = false
  }

  function loadDb() {
    const db = {}
    for (const l of DATA_LAYERS) db[l] = readLayer(l, { strict: true })
    return db
  }

  /**
   * 每层内部去重 + 跨层去重（深层的 id 为准，L1/L2 里的副本丢掉）。
   * 顺带保证"同一事件只存在一层"。
   */
  function reconcile(db) {
    // 返回"清掉了多少条"。调用方用它决定要不要落盘——不返回的话，
    // 崩溃残留的交叉条目虽然被清出内存了，却可能因为"本轮没有别的变化"而写不回去。
    let removed = 0
    const deep = new Map()
    for (const l of ['DL3', 'DL2', 'DL1']) {
      const before = db[l].length
      db[l] = dedupe(db[l])
      removed += before - db[l].length
      for (const it of db[l]) if (!deep.has(it.id)) deep.set(it.id, l)
    }
    const l1Before = db.L1.length
    db.L1 = dedupe(db.L1).filter((it) => !deep.has(it.id))
    const l2Before = db.L2.length
    db.L2 = dedupe(db.L2).filter((it) => !deep.has(it.id))
    // 已经进了 L2 的，也不能还留在 L1（崩在"L2 写完、L1 没改"时会这样）
    const inL2 = new Set(db.L2.map((it) => it.id))
    db.L1 = db.L1.filter((it) => !inL2.has(it.id))
    removed += (l1Before - db.L1.length) + (l2Before - db.L2.length)

    // 同一个 id 出现在两个深层：保留更靠后的（DL2 > DL1；DL3 只放摘要，理论上不会撞）
    const seen = new Set()
    for (const l of ['DL3', 'DL2', 'DL1']) {
      db[l] = db[l].filter((it) => {
        if (seen.has(it.id)) { audit(`RECONCILE_DUP ${it.id} ${l}`); removed++; return false }
        seen.add(it.id)
        return true
      })
    }

    // DL2 不变式：每一条都必须被某条 DL3 摘要引用。
    // 摘要被删/被合并后留下的孤儿，移到 DL1（快忘），不让它冒充"重要原文"。
    const refs = new Set()
    for (const s of db.DL3) for (const id of s.sources || []) refs.add(id)
    const orphans = db.DL2.filter((it) => !refs.has(it.id))
    if (orphans.length) {
      db.DL2 = db.DL2.filter((it) => refs.has(it.id))
      for (const it of orphans) {
        if (db.DL1.some((x) => x.id === it.id)) continue
        it.layer = 'DL1'
        delete it.consolidatedAt
        db.DL1.push(it)
      }
      audit(`RECONCILE_DL2_ORPHAN ${orphans.length} 条 → DL1（DL2 只放被引用的原文）`)
      removed += orphans.length      // 不算丢，只是换层；但文件确实变了，要写回
    }
    return removed
  }

  function sortDb(db) {
    db.L1.sort((a, b) => (a.createdAt - b.createdAt) || cmpId(a.id, b.id))
    db.L2.sort((a, b) => ((a.consolidatedAt ?? a.createdAt) - (b.consolidatedAt ?? b.createdAt)) || cmpId(a.id, b.id))
    for (const l of ['DL1', 'DL2', 'DL3']) db[l].sort((a, b) => (a.createdAt - b.createdAt) || cmpId(a.id, b.id))
  }

  /**
   * 按层写回。**先写目标层，最后写 L1**：
   * 崩在中间时 L1 里还有原文，靠 id 去重不会重复、不会丢。
   */
  function saveDb(db, { skip = [] } = {}) {
    sortDb(db)
    const skipSet = new Set(skip)
    for (const l of ['L2', 'DL1', 'DL2', 'DL3', 'L1']) {
      // 跳过只对"已经存在"的层生效：文件都还没有时得先建出来，
      // 否则第一次整理遇到"内容没变"就少建一个文件，读侧会 ENOENT。
      if (skipSet.has(l) && existsSync(paths[l])) continue
      writeLayer(l, db[l])
    }
  }

  function mergeTemps(db) {
    const claimed = claimTemps()
    if (!claimed.length) return { merged: 0, claimed }
    const have = new Set(db.L1.map((it) => it.id))
    for (const l of ['L2', 'DL1', 'DL2', 'DL3']) for (const it of db[l]) have.add(it.id)
    let merged = 0
    let bad = 0
    for (const p of claimed) {
      const r = readJsonl(p)
      bad += r.bad
      for (const it of r.items) {
        if (!it || !it.id || have.has(it.id)) continue
        if (!it.origin) it.origin = writer
        if (!it.turnId) it.turnId = it.id
        it.layer = 'L1'
        have.add(it.id)
        db.L1.push(it)
        merged++
      }
    }
    if (bad) audit(`MERGE_TEMP_BAD ${bad} 行（写到一半崩溃留下的半行，已跳过）`)
    return { merged, claimed }
  }

  function moveItem(db, it, target, now) {
    if (it.layer === target) {
      if (!db[target].some((x) => x.id === it.id)) db[target].push(it)
      return
    }
    for (const l of DATA_LAYERS) db[l] = db[l].filter((x) => x.id !== it.id)
    it.layer = target
    if (target === 'L2') it.consolidatedAt = now
    db[target].push(it)
  }

  /**
   * 批量搬层：一次扫层，而不是每条扫 5 个层。
   *
   * 语义与 moveItem 完全一致（同层幂等 / 从所有其它层摘掉 / L2 记 consolidatedAt），
   * 只是把 O(N×层大小) 变成 O(5×层大小 + N)。10 万条整批下沉 35 分钟 → 毫秒级。
   */
  function moveMany(db, items, target, now) {
    if (!DATA_LAYERS.includes(target) || !items.length) return
    const ids = new Set(items.map((it) => it.id).filter(Boolean))
    if (!ids.size) return
    for (const l of DATA_LAYERS) {
      if (l === target) continue
      db[l] = db[l].filter((x) => !ids.has(x.id))
    }
    const inTarget = new Set(db[target].map((x) => x.id))
    for (const it of items) {
      if (it.id && inTarget.has(it.id)) continue   // 同层幂等
      it.layer = target
      if (target === 'L2') it.consolidatedAt = now
      db[target].push(it)
    }
  }

  function groupOf(it) {
    return `${it.origin || '?'}\u0001${it.scene || ''}\u0001${it.channel || 'dialog'}`
  }

  function commonScene(items) {
    const s = [...new Set(items.map((it) => it.scene || '').filter(Boolean))]
    return s.length === 1 ? s[0] : ''
  }

  function mergeSummaries(target, src, now) {
    if (String(src.text || '').length > String(target.text || '').length) target.text = src.text
    const tFrom = target.spanFrom ?? target.createdAt
    const tTo = target.spanTo ?? target.createdAt
    const sFrom = src.spanFrom ?? src.createdAt
    const sTo = src.spanTo ?? src.createdAt
    target.spanFrom = Math.min(tFrom, sFrom)
    target.spanTo = Math.max(tTo, sTo)
    target.people = uniq([...(target.people || []), ...(src.people || [])]).slice(0, 10)
    target.sources = uniq([...(target.sources || []), ...(src.sources || [])])
    target.importance = Math.max(Number(target.importance) || 0, Number(src.importance) || 0)
    target.heat = Math.max(heatOf(target, now, cfg), heatOf(src, now, cfg))
    target.lastMentionedAt = now
    target.repeatStrength = Math.max(target.repeatStrength || 1, src.repeatStrength || 1)
    markFused(target, now)
  }

  async function fuseSummary(db, sum, now) {
    const sv = vectors.get(sum.id)
    if (sv && typeof o.judgeRelation === 'function') {
      const cands = []
      for (const it of db.DL3) {
        if (it.id === sum.id || it.kind !== 'summary' || it.supersededBy) continue
        const v = vectors.get(it.id)
        if (!v) continue
        const sim = cosine(sv, v)
        if (sim >= cfg.fusionPrefilter) cands.push({ it, sim })
      }
      if (cands.length) {
        cands.sort((a, b) => b.sim - a.sim)
        const top = cands[0]
        bump('relation', 1)
        let type = null
        let relErr = null
        try { type = await o.judgeRelation(top.it.text, sum.text) } catch (e) { relErr = e; type = null }
        // 判关系是模型活：失败就"不清洗、两条都留"，但必须留痕（不能静默当无关）
        if (relErr) audit(`MODEL_FAIL relation ${relErr?.message ?? relErr}（未清洗，两条都留）`)
        if (type === true) type = 'duplicate'
        if (type === false) type = null
        if (type === 'duplicate') {
          const before = String(top.it.text || '')
          mergeSummaries(top.it, sum, now)
          vectors.delete(sum.id)
          // ★ 合并只在"新的更长"时才替换正文。正文一旦变了，旧向量就作废：
          //   embedInto 会跳过"已有向量"的条目，所以必须先删掉旧的，否则它拿着
          //   旧正文的向量去参加下一次融合预筛（相似度比较的是两段不同的文字）。
          if (String(top.it.text || '') !== before) vectors.delete(top.it.id)
          await embedInto([top.it])
          l3Dirty = true
          audit(`FUSE_DUP ${sum.id} → ${top.it.id}`)
          return 'merged'
        }
        if (type === 'contradiction') {
          sum.supersedes = top.it.id
          top.it.supersededBy = sum.id
          sum.heat = Math.max(Number(sum.heat) || 1, Number(top.it.heat) || 1)
          sum.repeatStrength = Math.max(Number(sum.repeatStrength) || 1, Number(top.it.repeatStrength) || 1)
          db.DL3.push(sum)
          l3Dirty = true
          audit(`SUPERSEDE ${top.it.id} ← ${sum.id}`)
          return 'superseded'
        }
        if (type === 'update') {
          // 进展：两条都留，但记下"新的接在旧的后面"。
          // ★ 这个分支曾经漏过：模型判 update 时既不记 updates 链接、也不打日志，
          //   看起来像「融合完全没生效」。
          sum.updates = top.it.id
          db.DL3.push(sum)
          l3Dirty = true
          audit(`FUSE_UPDATE ${top.it.id} → ${sum.id}（进展，两条都保留）`)
          return 'updated'
        }
      }
    }
    db.DL3.push(sum)
    l3Dirty = true
    return 'added'
  }

  /**
   * 一批原文 → 摘要 + 路由。成功才搬；模型失败则整批回 L2（不丢）。
   *
   * 两个阶段共用这一套路由，靠 phase 区分（prompt 与档位在 llm.mjs）：
   *   'l1'  ★ → DL3（引用 → DL2）/ `+` → L2 / 其余 → DL1
   *   'l2'  ★★/★/☆ 三档 → DL3（引用 → DL2）/ `+` 限量 → L2 / 其余 → DL1
   *
   * ★ DL2 的唯一入口是"被摘要引用"：`cited` → DL2。
   *   `+`（keep）永远只回 L2，绝不进 DL2——DL2 是 DL3 摘要的原文库，不是第二缓冲层。
   */
  async function digest(db, batch, { phase = 'l1', started = null } = {}) {
    const secondChance = phase === 'l2'
    const groups = new Map()
    for (const it of batch) {
      const k = groupOf(it)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(it)
    }
    const now = tick()
    let made = 0
    let keptTotal = 0   // 第二次整理：本轮最多留这么多 `+` 在 L2，其余进 DL1
    for (const [key, group] of groups) {
      // 每片前查一次超时：模型卡住时能退出并放锁
      if (started) checkTimeout(started)
      const [origin, scene, channel] = key.split('\u0001')

      // 没有摘要能力：不产生假摘要，也不塞进 L2（L2 会进上下文）。
      // 整组下沉 DL1 并打 pendingDigest —— 不丢、不挤上下文、不参与遗忘，
      // 等有模型时 L2 满了会带上 DL1 全部一起压。
      if (typeof o.summarizeWithSources !== 'function') {
        for (const it of group) it.pendingDigest = true
        moveMany(db, group, 'DL1', now)
        audit(`DIGEST_NO_MODEL ${origin}/${scene || '-'}/${channel} ${group.length} 条 → DL1（等有模型再整理）`)
        continue
      }

      const folks = uniq(group.flatMap((it) => (it.people?.length ? it.people : (it.speaker ? [it.speaker] : [])))).slice(0, 10)
      const lines = group.map((it) => rawLine(it))
      const hint = [
        scene ? `这一段来自场景「${scene}」，摘要不要和别的场景混在一起。` : '',
        secondChance
          ? `这是第二次整理：+ 最多 ${cfg.l2KeepMax} 条，其余不要再标 +（它们会进流水账，这是正常的）。`
          : '',
      ].filter(Boolean).join(' ')
      let res = null
      let modelFailed = false
      if (typeof o.summarizeWithSources === 'function') {
        bump('summarize', group.length)
        try {
          res = await o.summarizeWithSources(lines, channel, folks, hint, { phase, keepMax: cfg.l2KeepMax })
        } catch (e) { audit(`MODEL_FAIL summarize ${e?.message ?? e}`); modelFailed = true; res = null }
      }
      // 模型有时会回一段「抱歉/无法完成」：没有任何标记，解析出来是一堆没有 sources 的
      // "摘要"。这不能当"整理成功但零产出"，否则原文会被静默路由进 DL1，
      // 而不是留在 L2 等下一轮重压。
      if (res) {
        const usable = (res.summaries || []).filter((s) => (s.sources || []).length)
        if (!usable.length && !(res.keep || []).length) res = null
      }
      if (!res) {
        // 失败：整批回 L2。下轮还有机会再压；绝不进 DL2（那里只放被引用的原文）。
        for (const it of group) moveItem(db, it, 'L2', now)
        audit(`DIGEST_FALLBACK[${phase}] reason=${modelFailed ? 'model_fail' : 'empty_reply'} ` +
          `${channel} ${group.length} 条 → L2（下轮再压）`)
        continue
      }

      // ★ 不再按 importance 过滤：档位是 prompt/解析器给的（L1 恒 0.9，L2 三档），
      //   引擎再滤一次只会把「一般」的内容滤没——那正是旧版 0.9 过滤线的坑。
      const sums = res.summaries || []
      const tier = (s) => {
        const imp = Number(s.importance) || 0
        return imp >= 0.85 ? 'high' : imp >= 0.45 ? 'mid' : 'low'
      }
      const cited = new Set()

      // 先把这一组的摘要全部造出来，再批量 embed、批量融合。
      // 逐条 embed 是 N 次往返（10 条摘要 = 10 次），批量只要 1 次。
      const planned = []
      for (const s of sums) {
        const srcs = (s.sources || []).map((i) => group[i - 1]).filter(Boolean)
        if (!srcs.length) continue
        const k = srcKey(srcs)
        if (db.DL3.some((x) => x.srcKey === k)) { for (const it of srcs) cited.add(it.id); continue }
        const sum = makeItem({
          text: String(s.text || '').trim(),
          channel,
          kind: 'summary',
          speaker: '',
          people: folks,
          scene: commonScene(srcs),
          importance: Number(s.importance) || 0.7,
          at: now,
        })
        sum.layer = 'DL3'
        sum.spanFrom = Math.min(...srcs.map((it) => it.createdAt))
        sum.spanTo = Math.max(...srcs.map((it) => it.createdAt))
        sum.sources = srcs.map((it) => it.id)
        sum.heat = 2
        sum.origin = origin
        sum.srcKey = k
        planned.push({ sum, srcs })
      }
      // fuseSummary 要靠向量做预筛，所以向量必须先算完（一次批量）
      if (planned.length) await embedInto(planned.map((p) => p.sum))
      for (const { sum, srcs } of planned) {
        await fuseSummary(db, sum, now)
        for (const it of srcs) cited.add(it.id)
        made++
      }

      const keep = new Set((res.keep || []).map((i) => group[i - 1]?.id).filter(Boolean))
      // 先分桶再一次性搬层：逐条 moveItem 是 O(N×层大小)，10 万条要 35 分钟
      const toDL2 = []
      const toL2 = []
      const toDL1 = []
      let nDone = 0
      for (const it of group) {
        if (started && ++nDone % 2000 === 0) checkTimeout(started)
        if (cited.has(it.id)) {
          toDL2.push(it)
        } else if (keep.has(it.id)) {
          if (!secondChance) {
            toL2.push(it)
          } else if (keptTotal < cfg.l2KeepMax) {
            // 第二次的 + 留在 L2（不是 DL2），但限量；给它新的 consolidatedAt，
            // 排到 L2 队尾，下一轮不会又第一个被挑出来。
            if (it.layer === 'L2') it.consolidatedAt = now
            else toL2.push(it)
            keptTotal++
          } else {
            toDL1.push(it)
          }
        } else {
          toDL1.push(it)
        }
      }
      moveMany(db, toDL2, 'DL2', now)
      moveMany(db, toL2, 'L2', now)
      moveMany(db, toDL1, 'DL1', now)
      // 这批已经被处理过（无论进 DL2 / L2 / DL1），不再是"等模型"的状态
      for (const it of group) { if (it.pendingDigest) delete it.pendingDigest }
      await embedInto(group)
      const counts = { high: 0, mid: 0, low: 0 }
      for (const s of sums) counts[tier(s)]++
      const tierText = phase === 'l2'
        ? `（★★${counts.high}/★${counts.mid}/☆${counts.low}，引用 ${cited.size}）`
        : `（引用 ${cited.size}）`
      audit(`DIGEST[${phase}] ${origin}/${scene || '-'}/${channel} ${group.length} 条 → 摘要 ${made}${tierText}`)
      // 模型什么都没标：原文全进 DL1。不是错误，但**必须留痕**——
      // 旧版就是这样「坏得安静」：L2 永远空、secondChance 永不触发、DL1 积压无人知。
      if (!made && !keep.size) {
        audit(`DIGEST_EMPTY[${phase}] ${channel} ${group.length} 条 → DL1（模型没给摘要也没给 +）`)
      }
    }
    return made
  }

  /** 一轮整理超时就放弃（钥匙别被一个卡住的模型带走） */
  function checkTimeout(started) {
    if (tick() - started > cfg.maxOrganizeMs) throw new Error('整理超时')
  }

  /**
   * 按轮次取旧的一半（实现在模块顶部 pickTurnBatch，导出给单测）。
   */
  const pickTurns = (items, cap, opts) => pickTurnBatch(items, cap, opts)

  /**
   * 对"还没分类"的条目批量问模型，补 channel 与 importance。
   *
   * 为什么放在整理时而不是写入时：
   *   ① 写入路径上每多一次模型往返就多一秒延迟；整理是后台的，等得起
   *   ② 刚写进来的条目可能马上被合并/作废/遗忘，那时候分类纯属浪费
   *   ③ 整批 20 条一次请求，成本约 1/20
   *
   * 为什么必须有：channel 决定摘要用哪套 focus（"做过的事"和"说过的话"
   * 重点不同），importance 决定检索打分和 DL1 的遗忘速度。全都恒为
   * dialog/0.5 的话，这两套机制形同虚设。
   *
   * 模型不可用 / 解析失败时**保留 impRough**，下一轮再试；
   * 不拿本地正则假装分过（那只会让"没分类"看起来像"分类过了"）。
   *
   * ★ 分批规则只看 cfg.classifyChunk / cfg.classifyMaxChars，**不接受调用方传参**。
   *   旧版签名是 refineImportance(items, chunk)，调用处写成了 refineImportance(batch, tick())，
   *   于是每批大小变成 1.7e12，等于一次把整批（第二次整理时是 L2 旧半 + 全部 DL1）
   *   塞进一个请求：要么请求过大失败、整批退回 L2 反复重压，要么模型在长列表里判不准
   *   重要度，后面遗忘阶段就会按错的重要度删掉本该留下的原文。
   */
  async function refineImportance(items) {
    const rough = (items || []).filter((it) => it && it.impRough)
    if (!rough.length) return 0
    if (typeof o.classifyBatch !== 'function' && typeof o.classify !== 'function') {
      audit(`MODEL_MISSING classify ${rough.length} 条（保留默认 dialog/0.5，下轮再试）`)
      return 0
    }

    const maxItems = Math.max(1, Number(cfg.classifyChunk) || 20)
    const maxChars = Math.max(200, Number(cfg.classifyMaxChars) || 6000)
    const batches = []
    let cur = []
    let curChars = 0
    for (const it of rough) {
      const len = String(it.text || '').length
      if (cur.length && (cur.length >= maxItems || curChars + len > maxChars)) {
        batches.push(cur)
        cur = []
        curChars = 0
      }
      cur.push(it)
      curChars += len
    }
    if (cur.length) batches.push(cur)

    let done = 0
    let changed = 0
    for (const part of batches) {
      const texts = part.map((it) => String(it.text || '').slice(0, 400))
      let got = null
      try {
        if (typeof o.classifyBatch === 'function') {
          got = await o.classifyBatch(texts)
        } else {
          got = []
          for (const t of texts) got.push(await o.classify(t))
        }
      } catch (e) {
        audit(`MODEL_FAIL classify chunk=${part.length} ${e?.message ?? e}`)
        continue
      }
      if (!Array.isArray(got) || got.length !== part.length) {
        audit(`MODEL_FAIL classify chunk=${part.length} 返回格式不对，保留待分类`)
        continue
      }
      for (let k = 0; k < part.length; k++) {
        const t = got[k]
        if (!t) continue
        const imp = Number(t.importance)
        if (!Number.isFinite(imp)) continue
        if (Math.abs(imp - Number(part[k].importance ?? 0)) > 1e-9) changed++
        part[k].importance = imp
        if (['dialog', 'action', 'event', 'note'].includes(t.channel)) part[k].channel = t.channel
        delete part[k].impRough
        done++
      }
    }
    audit(`CLASSIFY ${done}/${rough.length} 条（改判 ${changed}，批 ${batches.length} 个）`)
    return done
  }

  async function organizeL1(db, started) {
    if (chars(db.L1) <= cfg.hotMaxChars && db.L1.length <= cfg.hotMaxItems) return 0
    // 纯容量：L1 一过阈值就分流，不再等「安静期」（1.2.0 起）。
    const batch = pickTurns(db.L1, cfg.hotMaxChars, {
      orderKey: (it) => it.createdAt,
      maxItems: cfg.hotMaxItems,
    })
    if (!batch.length) {
      // 只有两种可能：没到容量（上面已挡）或全被钉住（搬不动）。
      audit('L1_ALL_PINNED 超过容量，但可搬的轮次都钉住了')
      return 0
    }
    checkTimeout(started)
    // ★ 分类必须在 digest 之前：channel 参与 digest 的分组，分晚了本轮还是按 dialog 合批。
    await refineImportance(batch)
    await digest(db, batch, { phase: 'l1', started })
    return batch.length
  }

  async function organizeL2(db, started) {
    if (chars(db.L2) <= cfg.consolidateMaxChars && db.L2.length <= cfg.consolidateMaxItems) return 0
    const due = pickTurns(db.L2, cfg.consolidateMaxChars, {
      orderKey: (it) => it.consolidatedAt ?? it.createdAt,
      maxItems: cfg.consolidateMaxItems,
    })
    if (!due.length) return 0
    checkTimeout(started)
    // DL1 全部一起送进去（用户定：DL1 与 L2 旧半融合处理）
    const batch = [...due, ...db.DL1]
    await refineImportance(batch)
    // 第二遍：三档摘要 + 限量保留原文（DL1 全部带上一起处理）
    await digest(db, batch, { phase: 'l2', started })
    return batch.length
  }

  // ============================================================
  // 信号：attend / pin / forget
  // ============================================================

  const newOpId = () => `${writer}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  function signal(op) {
    const rec = { ...op, opId: op.opId || newOpId(), at: tick() }
    appendJsonl(join(sigDir, `${writer}.jsonl`), [rec])
    return rec
  }

  const attend = (ids) => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
    if (!list.length) return 0
    signal({ op: 'attend', ids: list })
    return list.length
  }
  const pin = (id, v = true) => { signal({ op: 'pin', ids: [String(id)], v: !!v }); return { ok: true, id, pinned: !!v } }
  const forget = (id) => { signal({ op: 'forget', ids: [String(id)] }); return { ok: true, id, queued: true } }

  function findAny(db, id) {
    for (const l of ['DL3', 'DL2', 'DL1', 'L2', 'L1']) {
      const it = db[l].find((x) => x.id === id)
      if (it) return it
    }
    return null
  }

  function writeForgotten(it, now, retention, reason = '遗忘') {
    const rec = {
      id: it.id,
      layer: it.layer,
      channel: it.channel,
      text: String(it.text || '').slice(0, 240),
      importance: it.importance,
      created_local: new Date(it.createdAt).toLocaleString('zh-CN'),
      forgotten_local: new Date(now).toLocaleString('zh-CN'),
      lifespan_days: Math.round((now - it.createdAt) / DAY),
      retention: retention === null ? null : Number(retention.toFixed(3)),
      reason,
    }
    try { appendFileSync(gravePath, JSON.stringify(rec) + '\n', 'utf8'); return true } catch { return false }
  }

  function applySignals(db) {
    const claimed = claimSignals()
    if (!claimed.length) return { ops: 0, claimed }
    let applied = { ops: [] }
    try { applied = JSON.parse(readFileSync(appliedPath, 'utf8')) } catch { /* 首次 */ }
    const done = new Set(applied.ops || [])
    let n = 0
    const now = tick()
    for (const p of claimed) {
      const r = readJsonl(p)
      for (const op of r.items) {
        if (!op || !op.opId || done.has(op.opId)) continue
        const ids = Array.isArray(op.ids) ? op.ids : []
        if (op.op === 'attend') {
          for (const id of ids) {
            const it = findAny(db, id)
            if (!it) continue
            touchHeat(it, now, cfg)
            markRecalled(it, now)
            if (it.layer === 'DL1') moveItem(db, it, 'L2', now)
            if (it.layer === 'DL3') l3Dirty = true   // 热度变了，L3 排序要跟着变
            n++
          }
        } else if (op.op === 'pin') {
          for (const id of ids) { const it = findAny(db, id); if (it) { it.pinned = !!op.v; n++ } }
        } else if (op.op === 'forget') {
          for (const id of ids) {
            const it = findAny(db, id)
            if (!it) { audit(`FORGET_MISS ${id} 找不到这条，跳过`); continue }
            if (!writeForgotten(it, now, null)) { audit(`FORGET_FAIL ${id} 台账写不进去，不删`); continue }
            if (it.layer === 'DL3') l3Dirty = true
            for (const l of DATA_LAYERS) db[l] = db[l].filter((x) => x.id !== id)
            vectors.delete(id); vectorsDirty = true
            audit(`FORGET_ITEM ${id} layer=${it.layer}`)
            n++
          }
        }
        done.add(op.opId)
      }
    }
    applied.ops = [...done].slice(-2000)
    if (n) audit(`SIGNAL_APPLY ${n} 条（attend / pin / forget）`)
    // 落盘 / 记 applied / 删 claimed 由 organize 统一做（顺序：先存数据，再记账，再删源）
    return { ops: n, claimed, applied }
  }

  // ============================================================
  // 遗忘 + L3 快照
  // ============================================================

  function retentionOf(it, now) {
    const last = it.lastMentionedAt ?? it.createdAt
    const t = Math.max(0, (now - last) / DAY)
    return Math.exp(-t / halfLifeOf(it, cfg, now))
  }

  function forgetDL1(db) {
    const now = tick()
    const keep = []
    let n = 0
    for (const it of db.DL1) {
      if (it.pinned) { keep.push(it); continue }
      // 等模型整理的原文：还没压过摘要，忘了就真丢了
      if (it.pendingDigest) { keep.push(it); continue }
      const r = retentionOf(it, now)
      if (r >= cfg.forgetThreshold) { keep.push(it); continue }
      if (!writeForgotten(it, now, r)) { keep.push(it); continue }   // 台账写不进去就不删
      vectors.delete(it.id); vectorsDirty = true
      n++
    }
    db.DL1 = keep
    if (n) audit(`FORGET ${n} 条（DL1 保持率低于 ${cfg.forgetThreshold}）`)
    return n
  }

  /**
   * DL1 容量上限：遗忘曲线管「该不该忘」，这里管「库不能无限长」。
   *
   * 超过上限就按「越旧越先清」清到 80%；优先清已经整理过的（没有 pendingDigest），
   * 最后才动「等模型整理」的原文——那批还没压过摘要，忘了就真丢了。
   */
  function enforceDL1Cap(db) {
    const cap = Number(cfg.dl1MaxChars) || 0
    if (cap <= 0) return 0
    const total = chars(db.DL1)
    if (total <= cap) return 0
    const target = Math.floor(cap * 0.8)
    const now = tick()
    const cands = [...db.DL1]
      .filter((it) => !it.pinned)
      .sort((a, b) => {
        const pa = a.pendingDigest ? 1 : 0
        const pb = b.pendingDigest ? 1 : 0
        if (pa !== pb) return pa - pb
        return (a.createdAt || 0) - (b.createdAt || 0)
      })
    let used = total
    const drop = new Set()
    for (const it of cands) {
      if (used <= target) break
      const r = retentionOf(it, now)
      if (!writeForgotten(it, now, r, 'DL1 超容量')) continue   // 台账写不进去就不删
      drop.add(it.id)
      used -= String(it.text || '').length
      vectors.delete(it.id); vectorsDirty = true
    }
    if (!drop.size) return 0
    db.DL1 = db.DL1.filter((it) => !drop.has(it.id))
    audit(`DL1_TRIM ${drop.size} 条（超上限 ${cap} 字，清到 ${used} 字）`)
    return drop.size
  }

  /**
   * DL3 淘汰：**只淘汰「琐事」那一档**（importance < 0.45）。
   *
   * 重要/一般的摘要不按时间淘汰（只靠融合合并/作废）——它们是长期记忆的主体。
   * 琐事摘要（☆）如果不淘汰，会无限积累、挤占注入预算、制造检索噪音。
   * 规则：先写台账再删；不足保护期的不动；pinned 不动；被删摘要「独占」的 DL2 原文一起清。
   */
  function forgetDL3(db) {
    const now = tick()
    const keep = []
    const removed = []
    for (const it of db.DL3) {
      if (it.pinned) { keep.push(it); continue }
      if ((Number(it.importance) || 0) >= 0.45) { keep.push(it); continue }   // 只动琐事档
      if ((now - (it.createdAt || 0)) / DAY < cfg.summaryForgetFloorDays) { keep.push(it); continue }
      const last = it.lastMentionedAt ?? it.createdAt
      const t = Math.max(0, (now - last) / DAY)
      const factor = Number(cfg.summaryTrivialHalfLife) || 0.55
      const r = Math.exp(-t / (halfLifeOf(it, cfg, now) * factor))
      if (r >= cfg.summaryForgetThreshold) { keep.push(it); continue }
      if (!writeForgotten(it, now, r, '琐事摘要过期')) { keep.push(it); continue }
      vectors.delete(it.id); vectorsDirty = true
      removed.push(it)
    }
    if (!removed.length) return { summaries: 0, sources: 0 }
    db.DL3 = keep
    l3Dirty = true
    // 删掉摘要后不再被任何剩余摘要引用的 DL2 原文 → 一起清（先台账）
    const refs = new Set()
    for (const s of db.DL3) for (const id of s.sources || []) refs.add(id)
    const owned = new Set(removed.flatMap((s) => s.sources || []))
    const drop = new Set()
    let srcs = 0
    for (const it of db.DL2) {
      if (it.pinned || refs.has(it.id) || !owned.has(it.id)) continue
      const r = retentionOf(it, now)
      if (!writeForgotten(it, now, r, '摘要淘汰连带')) continue
      drop.add(it.id)
      vectors.delete(it.id); vectorsDirty = true
      srcs++
    }
    if (drop.size) db.DL2 = db.DL2.filter((it) => !drop.has(it.id))
    audit(`FORGET_SUMMARY ${removed.length} 条（只清琐事档，保持率 < ${cfg.summaryForgetThreshold}）；连带清理原文 ${srcs} 条`)
    return { summaries: removed.length, sources: srcs }
  }

  function scoreOf(it, now) {
    const base = (Number(it.importance) || 0) * heatOf(it, now, cfg)
    // 融合次数 / 关注次数：两个都按遗忘曲线衰减过，久不提就自动失去加成。
    // 权重是「等效放大倍数」——融合 3 次、关注 2 次（都是刚发生的）约 ×2，
    // 30 天不提（半衰期 7 天）衰减到 1/16，加成基本归零。
    const { fusion, recall } = memoryStrength(it, now, cfg)
    const boost = 1 + 0.25 * Math.log2(1 + fusion) + 0.35 * Math.log2(1 + recall)
    return base * boost
  }

  // L3 快照只在"内容真的变了"或"到刷新间隔"时重写：
  // 它排在注入块最前面，每 5 分钟重排一次会把后面的前缀缓存全打断。
  let l3Dirty = false
  let lastL3At = 0

  /**
   * DL3 的版本指纹（mtime + size）。
   *
   * ★ 为什么需要：`l3Dirty` 是**进程内**变量。A 端整理出新摘要、刷新了 L3.json，
   *   B 端拿钥匙时自己的 l3Dirty 是 false、lastL3At 也没到点 —— 它不会重写快照，
   *   新摘要要等 B 的下一个 viewRefreshMs（30 分钟）才进上下文。
   *   把"这份快照基于哪个版本的 DL3"写进 L3.json，跨进程才判断得出来过期没有。
   */
  function dl3Version() {
    try { const st = statSync(paths.DL3); return `${st.mtimeMs}:${st.size}` } catch { return '0:0' }
  }
  /** DL3 文件多大（只用 stat，不解析）。注入判断"现算值不值得"时用 */
  function dl3Bytes() {
    try { return statSync(paths.DL3).size } catch { return 0 }
  }
  // 快照过期时现算的上限：小库（默认 1.5MB ≈ 三五千条摘要）现算只要几毫秒，
  // 大库读一次要几秒——注入是每轮都跑的，宁可看旧快照，等整理者下一轮刷新。
  const L3_INLINE_MAX = 1.5 * 1024 * 1024

  /** 从 DL3 按 importance×heat 截前 N 条（纯计算，不写盘） */
  function computeL3(db = null, now = tick()) {
    const pool = (db && db.DL3) ? db.DL3 : (() => { try { return readLayerCached('DL3') } catch { return [] } })()
    const scored = pool
      .filter((it) => !it.supersededBy)
      .map((it) => ({ it, s: scoreOf(it, now) }))
      .sort((a, b) => b.s - a.s)
    const out = []
    let used = 0
    for (const { it } of scored) {
      const len = String(it.text || '').length
      if (used + len > cfg.longMaxChars) break
      out.push(it)
      used += len
    }
    return out
  }

  function refreshL3(db) {
    const now = tick()
    const out = computeL3(db, now)
    atomicWrite(paths.L3, JSON.stringify({ version: 3, at: now, dl3v: dl3Version(), items: out }, null, 1))
    lastL3At = now
    l3Dirty = false
    return out.length
  }

  /**
   * 读快照：只有「快照记的 DL3 版本 == 当前 DL3 版本」才算新鲜。
   * 过期（对方刚整理完）返回 null，调用方现算一份——不写盘，写盘是整理者的活。
   */
  function readL3Snapshot() {
    try {
      const snap = JSON.parse(readFileSync(paths.L3, 'utf8'))
      const items = Array.isArray(snap?.items) ? snap.items : []
      if (snap && typeof snap.dl3v === 'string' && snap.dl3v === dl3Version()) return items
      // 快照过期：小库返回 null（让调用方现算，保证"对方刚写下一轮就能看见"）；
      // 大库直接给旧快照——读一次几十万条 DL3 要一两秒，注入扛不住。
      if (dl3Bytes() <= L3_INLINE_MAX) return null
      return items
    } catch { return null }
  }

  /** 快照是否落后于 DL3（整理者据此决定要不要重写，不受上面的"大库不现算"影响） */
  function l3SnapshotStale() {
    try {
      const snap = JSON.parse(readFileSync(paths.L3, 'utf8'))
      return snap?.dl3v !== dl3Version()
    } catch { return true }
  }

  // ============================================================
  // 整理主流程
  // ============================================================

  let organized = 0
  let busy = false

  /**
   * 整理一次（拿钥匙 → 认领 → 分类/摘要/分流 → 沉淀 → 遗忘 → 快照）。
   *
   * 1.2.0 起没有「force」：L1 只看容量（一过阈值就分），所以「立即整理」就是直接调它，
   * 没有满就什么都不做（不硬搬刚聊的几句）。
   */
  async function organize() {
    if (busy) return { ok: false, skipped: 'running' }
    if (!acquireLock()) return { ok: false, skipped: 'busy' }
    busy = true
    const started = tick()
    const hb = setInterval(heartbeat, 30 * 1000)
    let claimed = []
    try {
      const db = loadDb()
      // 整理时对账（注入路径不再做这件事，见 readL1View 的说明）：
      // 清理崩溃留下的跨层交叉、DL2 孤儿。清掉的条目要能写回去，
      // 所以这里记下条数，最后并进 changed。
      const rec1 = reconcile(db)
      // DL3 的内容快照：用来判断"这轮到底动没动摘要"，没动就别重写文件。
      // 重写会让 mtime 变、让 L3 快照被判过期，白白打断一次前缀缓存。
      const dl3Before = JSON.stringify(db.DL3)
      const m = mergeTemps(db)
      claimed = m.claimed
      maybeReloadVectors()
      // 先消费信号：attend 可能把 DL1 升回 L2，别让 L2 摘要先把这条吃掉。
      const sg = applySignals(db)
      // 信号可能刚删了摘要；再对一次账，DL2 孤儿同轮就归位到 DL1。
      const rec2 = reconcile(db)
      checkTimeout(started)
      // 容量告警：单层过大时留痕（不改行为）
      const warnN = Number(cfg.warnLayerItems) || 200000
      const bigLayers = DATA_LAYERS.filter((l) => db[l].length > warnN)
      if (bigLayers.length) {
        audit('LAYER_WARN ' + bigLayers.map((l) => `${l}=${db[l].length}`).join(' ')
          + `（阈值 ${warnN}，建议检查整理是否卡住）`)
      }
      const n1 = await organizeL1(db, started)
      checkTimeout(started)
      // L2 只在有模型时跑：没有模型就别把缓冲层清空，留着等能压的时候
      const n2 = typeof o.summarizeWithSources === 'function' ? await organizeL2(db, started) : 0
      checkTimeout(started)
      const nf = forgetDL1(db)
      // DL1 容量上限：遗忘曲线管「该不该忘」，这里管「库不能无限长」
      const nt = enforceDL1Cap(db)
      // DL3 只淘汰「琐事」档；重要/一般的摘要只靠融合合并/作废
      const ns = forgetDL3(db)
      checkLock()          // 卡太久可能被接管；不是我的钥匙就不许写
      // ★ 没变化就不落盘：turn/end 之后每轮都会调一次 organize，
      //   无条件写五个文件会把"每轮尝试整理"变成"每轮全量重写"。
      const changed = m.merged > 0 || (sg?.ops || 0) > 0 || n1 > 0 || n2 > 0 || nf > 0 || nt > 0 ||
        (ns.summaries || 0) > 0 || (ns.sources || 0) > 0 || rec1 > 0 || rec2 > 0
      if (changed) {
        const dl3Changed = JSON.stringify(db.DL3) !== dl3Before
        saveDb(db, { skip: dl3Changed ? [] : ['DL3'] })
      }
      // 先存数据，再记 applied，再删源文件（崩在中间最多重放一次，不会丢）
      if (sg?.applied) atomicWrite(appliedPath, JSON.stringify(sg.applied, null, 1))
      for (const p of claimed) { try { unlinkSync(p) } catch { /* 已没 */ } }
      for (const p of sg?.claimed || []) { try { unlinkSync(p) } catch { /* 已没 */ } }
      if (changed) saveVectors()
      // L3 快照：内容变了 / 快照过期 / 到了刷新间隔 才重写
      // （每 5 分钟无条件重排会打断前缀缓存，所以平时不动它）
      const l3Every = Number(cfg.viewRefreshMs) || 0
      const needL3 = l3Dirty || !l3Every || (tick() - lastL3At >= l3Every) || l3SnapshotStale()
      const l3 = needL3
        ? refreshL3(db)
        : (() => { try { return readLayer('L3').length } catch { return 0 } })()
      organized++
      const state = {
        at: tick(), writer, elapsedMs: tick() - started,
        merged: m.merged, l1Moved: n1, l2Moved: n2, l3,
        dl1Trimmed: nt, dl3Forgotten: ns.summaries || 0, dl3SourcesForgotten: ns.sources || 0,
        count: { L1: db.L1.length, L2: db.L2.length, DL1: db.DL1.length, DL2: db.DL2.length, DL3: db.DL3.length },
        chars: { L1: chars(db.L1), L2: chars(db.L2), DL1: chars(db.DL1), DL2: chars(db.DL2), DL3: chars(db.DL3) },
        vectors: vectors.size,
      }
      // 状态文件是「上次整理结果」。没变化就不写（省一次 IO，也让文件内容 =
      // 真正发生过的事），但每 10 分钟兜底写一次，免得页面上的时间戳看着像卡死。
      const stateAge = (() => {
        try { return tick() - Number(JSON.parse(readFileSync(statePath, 'utf8')).at || 0) } catch { return Infinity }
      })()
      if (changed || stateAge > 10 * 60 * 1000) {
        atomicWrite(statePath, JSON.stringify(state, null, 1))
      }
      audit(`ORGANIZE ok merged=${m.merged} L1=${n1} L2=${n2} L3=${l3} ${state.elapsedMs}ms`)
      return { ok: true, ...state }
    } catch (e) {
      audit(`ORGANIZE_FAIL ${e.message}`)
      return { ok: false, error: e.message }
    } finally {
      clearInterval(hb)
      busy = false
      releaseLock()
    }
  }

  // ============================================================
  // 注入
  // ============================================================

  /**
   * 按字数裁剪一组行。
   *
   * ★ 一条都放不下时给一条截断的：旧实现要求 limit > 40 才给，
   *   于是把 L1 容量调小（比如 200 字、自己那端配额 140 字）而单行比配额还长时，
   *   「刚发生的」整段会凭空消失——看着像记忆没写进去，其实是没塞下。
   */
  function pack(list, limit) {
    const out = []
    let used = 0
    for (const it of list) {
      const l = lineOf(it)
      if (used + l.length + 1 > limit) {
        if (!out.length && limit > 24) {
          const cut = l.slice(0, Math.max(12, limit - 1))
          out.push(cut + '…')
        }
        break
      }
      out.push(l)
      used += l.length + 1
    }
    return out
  }

  function lineOf(it) {
    const isSum = it.kind === 'summary' || !!it.spanFrom
    // 摘要保持天级跨度（起~止）；原话带「时:分」，同一天多条才分得清先后
    const tag = isSum && it.spanFrom
      ? `${dayKey(it.spanFrom).slice(5)}~${dayKey(it.spanTo || it.createdAt).slice(5)} `
      : `${dayKey(it.createdAt).slice(5)} ${hhmm(it.createdAt)} `
    const who = isSum
      ? '[摘要] '
      : `[${it.origin || '?'}${it.speaker ? '·' + it.speaker : ''}] `
    const mark = it.supersededBy ? '（已作废）' : ''
    return `- ${mark}${tag}${who}${String(it.text || '').replace(/\s+/g, ' ').trim()}`
  }

  function buildBlock(budget = 0, opts = {}) {
    // ★ 不再"读快照 → 空就现算"，而是"版本对得上才用快照"：
    //   对方刚整理完（DL3 变了、快照还没轮到它写）时，这里会现算一份，
    //   保证「对方写的东西，我下一轮注入就能看见」，不用等 30 分钟的刷新周期。
    //   现算不写盘——写快照是拿钥匙那一方的职责，否则又变成两个写者。
    let l3 = readL3Snapshot()
    if (l3 === null) l3 = computeL3(null)
    l3 = l3.filter((it) => !it.supersededBy)
    // L2 只读一次：既用来拼"最近沉淀的"，顺手当"已下沉"的 id 集合给 L1 视图去重
    let l2raw = []
    try { l2raw = readLayerCached('L2') } catch { l2raw = [] }
    const l2 = sortedL2(l2raw)
    const l1r = readL1View({ placed: new Set(l2raw.map((it) => it.id)) })
    const l1 = l1r.items.filter((it) => !it.supersededBy)

    // ★ 按时间【升序】：新对话加在段尾，旧行永不移动。
    //   这是前缀缓存的关键——降序会让每条新消息插队到段首，整块每轮全部失效
    //   （实测未命中恒定 5300-5400 token）。模型不会漏看最新内容：本轮输入本来就在记忆块之后。
    l1.sort((a, b) => (a.createdAt - b.createdAt) || cmpId(a.id, b.id))

    const longLines = pack(l3, Infinity)
    const consLines = pack(l2, cfg.consolidateMaxChars)

    // L1：自己端全量注入，不再装箱截断。
    //   原因：分流机制（纯字数溢出）已保证 L1 水位（分流后 ≤ cap/2），而注入配额是
    //   「行渲染」口径（每行带时间戳/来源前缀，比 text 膨胀约 30%），水位必然阶段性
    //   超过配额 → 装箱截断 → 滑动窗口 → 每轮前缀断裂（实测未命中 1700）。
    //   「另一端」来源没有分流保证，保留配额防爆。
    const cap = cfg.hotMaxChars
    // 注：旧版这里按 hotQuotaOwn 给自己端设注入配额，1.2.0 起自己端全量注入
    //（大小由分流机制保证），该系数已无生效点，配置项一并移除。
    const mine = l1.filter((it) => it.origin === writer).map((it) => lineOf(it))
    const mineUsed = mine.reduce((s, l) => s + l.length + 1, 0)
    const byNewest = (list) => [...list].sort((a, b) => (b.createdAt - a.createdAt) || cmpId(b.id, a.id))
    const other = pack(byNewest(l1.filter((it) => it.origin !== writer)), Math.max(0, cap * 1.5 - mineUsed)).reverse()

    const parts = []
    if (longLines.length) parts.push('## 一直记得的', ...longLines)
    if (consLines.length) parts.push('## 最近沉淀的', ...consLines)
    if (mine.length || other.length) parts.push('## 这是按时间排序的历史对话', ...mine, ...other)
    const shown = mine.length + other.length
    if (shown < l1.length) parts.push(`（即时层还有 ${l1.length - shown} 条未显示）`)
    // 提示语和相关旧事只在**真的有记忆内容**时才追加：
    // 记忆库空的时候不能给模型一句「历史已被替代」——那会让它以为有记忆可查，
    // 而实际什么都没有（压缩前的「记忆块非空」守卫也依赖这一点）。
    if (parts.length) {
      // 额外提示（「本会话历史已被记忆替代，要细节请检索」）。
      if (opts.notice) parts.push(String(opts.notice).trim())
      // 额外段（「相关旧事」：按本轮消息检索出来的旧记忆）。
      // 放在最后：它每轮都变，排在这里才不会把前面的稳定前缀一起带崩。
      if (opts.extra) {
        const extra = String(opts.extra).trim()
        if (extra) parts.push(extra)
      }
    }
    let out = parts.join('\n')
    // 总量上限按整行裁：切在半句上，模型会以为那句话本来就没说完。
    // 只有一行都放不下（预算比首行还短）时才退化成硬切。
    if (budget > 0 && out.length > budget) {
      const cut = out.slice(0, budget)
      const nl = cut.lastIndexOf('\n')
      out = nl > 0 ? cut.slice(0, nl) + '\n…（记忆块到上限，已截断）' : cut + '…'
    }
    return wrapBlock(out)
  }

  // ============================================================
  // 检索
  // ============================================================

  const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '和', '就', '都', '也', '吗', '呢', '啊', '这', '那', '什么', '怎么', '那事', '事情'])

  function keywords(q) {
    const s = String(q || '').toLowerCase()
    const out = new Set()
    for (const w of s.split(/[\s,，。！？!?、；;:：""''（）()\[\]]+/)) {
      if (w.length >= 2 && !STOP.has(w)) out.add(w)
    }
    const zh = s.replace(/[^\u4e00-\u9fa5]/g, '')
    for (let i = 0; i < zh.length - 1; i++) {
      const bg = zh.slice(i, i + 2)
      if (!STOP.has(bg)) out.add(bg)
    }
    return out
  }

  /**
   * 从查询里认时间词 → 时间窗。
   *
   * 只认「短问句里明确带的时间词」：长句里随手出现的「最近」「之前」不算，
   * 否则每条这类查询都会拿到固定 0.9 的时间分，排序被时间主导、语义分白算。
   * 「之前」直接不认——它的窗口是 [0, now]，等于无条件命中。
   */
  function parseTime(q, now) {
    const s = String(q || '')
    if (!s || s.length > 30) return null
    const d0 = new Date(now)
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const today = startOfDay(d0)
    const map = {
      刚刚: [now - 2 * 3600e3, now],
      今天: [today, today + DAY],
      昨天: [today - DAY, today],
      前天: [today - 2 * DAY, today - DAY],
      这周: [today - 6 * DAY, today + DAY],
      上周: [today - 13 * DAY, today - 6 * DAY],
      最近: [today - 7 * DAY, today + DAY],
    }
    for (const [k, v] of Object.entries(map)) {
      if (s.includes(k)) return { from: v[0], to: v[1], word: k }
    }
    return null
  }

  const DETAIL_HINTS = /具体|原话|细节|怎么说的|怎么讲|当时|原原本本|哪一句|逐条|列一下|都做了|分别|多少|几号/
  const DEPTH_LAYERS = { summary: ['DL3'], detail: ['DL3', 'DL2'], full: ['DL3', 'DL2', 'DL1'] }
  const layerBoost = (l) => (l === 'DL3' ? 1 : l === 'DL2' ? 0.8 : 0.6)

  async function search(query, opts = {}) {
    maybeReloadVectors()
    const q = String(query || '').trim()
    let depth = opts.depth || 'auto'
    if (depth === 'auto') depth = DETAIL_HINTS.test(q) ? 'detail' : 'summary'
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 6
    const scene = opts.scene || null
    const now = tick()

    const win = parseTime(q, now)
    const kw = keywords(win ? q.replace(win.word, '') : q)
    const qVec = await embedOne(q)

    const layers = DEPTH_LAYERS[depth] || DEPTH_LAYERS.summary
    const pool = []
    for (const l of layers) {
      try { for (const it of readLayerCached(l)) pool.push(it) } catch { /* 单层坏了不影响别层 */ }
    }

    const scored = []
    for (const it of pool) {
      if (it.supersededBy && !/以前|之前/.test(q)) continue
      if (scene && it.scene !== scene) continue
      const from = it.spanFrom ?? it.createdAt
      const to = it.spanTo ?? it.createdAt
      if (win && !(to >= win.from && from <= win.to)) continue

      const body = [String(it.text || ''), it.speaker || '', (it.people || []).join(' '), it.scene || ''].join(' ')
      let hit = 0
      for (const k of kw) if (body.includes(k)) hit++
      const coverage = kw.size ? hit / kw.size : 0
      const v = vectors.get(it.id)
      const sem = qVec && v ? cosine(qVec, v) : 0
      if (kw.size && hit === 0 && sem < 0.2 && !win) continue

      const timeScore = win ? 0.9 : 0.5
      const imp = Number(it.importance) || 0
      const score = qVec
        ? 0.42 * sem + 0.22 * coverage + 0.20 * timeScore + 0.10 * imp + 0.06 * layerBoost(it.layer)
        : 0.55 * coverage + 0.25 * timeScore + 0.12 * imp + 0.08 * layerBoost(it.layer)
      scored.push({ it, score, sem, coverage })
    }

    scored.sort((a, b) => b.score - a.score)
    let top = scored.slice(0, Math.max(limit * 2, limit))

    // 精排：候选 > 1 才跑；失败就用原分
    let reranked = false
    if (opts.useRerank !== false && typeof o.rerank === 'function' && top.length > 1) {
      try {
        bump('rerank', top.length)
        const rs = await o.rerank(q, top.map((x) => x.it.text))
        // llm.rerank 返回 [{ index, score }]，不是裸数字；两种都兼容
        if (Array.isArray(rs) && rs.length) {
          const rel = new Map()
          rs.forEach((x, i) => {
            if (x && typeof x === 'object') rel.set(Number(x.index), Number(x.score) || 0)
            else rel.set(i, Number(x) || 0)
          })
          const minRel = Number(cfg.minRerank ?? 0.02)
          const ranked = top
            .map((x, i) => ({ ...x, rel: rel.has(i) ? rel.get(i) : 0 }))
            .filter((x) => x.rel >= minRel)
            .map((x) => ({ ...x, score: 0.55 * x.rel + 0.45 * x.score }))
            .sort((a, b) => b.score - a.score)
          // 精排把结果全滤光了，通常是模型/网络降级 → 保留原分，宁可多给几条
          if (ranked.length) { top = ranked; reranked = true }
        }
      } catch (e) {
        // 精排失败：明确降到粗排分，但必须留痕——否则"这次为什么搜得差"没法排查
        audit(`MODEL_FAIL rerank ${e?.message ?? e}`)
      }
    }

    const hits = top.slice(0, limit).map((x) => ({
      id: x.it.id, text: x.it.text, layer: x.it.layer, channel: x.it.channel,
      when: dayKey(x.it.createdAt),
      scene: x.it.scene || '', createdAt: x.it.createdAt, spanFrom: x.it.spanFrom ?? null,
      importance: x.it.importance, score: Number(x.score.toFixed(4)),
      rel: x.rel ?? null, kind: x.it.kind, sources: x.it.sources || [],
    }))

    // detail/full：顺着摘要的 sources 去 DL2/DL1 取原文（比拿查询扫 DL2 准）
    if (depth !== 'summary' && opts.followSources !== false) {
      // ★ 不再把 DL2/DL1 整层塞进 Map：10 万条时要 20 万次 set/has，每检索一次。
      //   改成"按需查索引"——索引挂在缓存条目上，建一次一直用。
      const idxD2 = ensureIndex('DL2')
      const idxD1 = ensureIndex('DL1')
      const findDeep = (id) => (idxD2 && idxD2.get(id)) || (idxD1 && idxD1.get(id)) || null
      const seen = new Set(hits.map((h) => h.id))
      const extra = []
      for (const h of hits) {
        if (h.kind !== 'summary' || !h.sources?.length) continue
        for (const id of h.sources) {
          if (seen.has(id)) continue
          const it = findDeep(id)
          if (!it) continue
          seen.add(id)
          extra.push({
            id: it.id, text: it.text, layer: it.layer, channel: it.channel,
            when: dayKey(it.createdAt), scene: it.scene || '',
            createdAt: it.createdAt, spanFrom: it.spanFrom ?? null, importance: it.importance,
            score: Number((h.score * 0.9).toFixed(4)), rel: h.rel ?? null, kind: it.kind, via: h.id,
          })
        }
      }
      hits.push(...extra.slice(0, 6))
    }

    const relMax = hits.reduce((m, h) => Math.max(m, h.rel ?? h.score ?? 0), 0)
    const advice = !hits.length
      ? '没有找到相关记忆。可以换 depth="full" 再搜一次，或确认这件事确实没记过。'
      : relMax >= 0.5
        ? '相关度较高，可以直接用。'
        : relMax >= 0.1
          ? '相关度中等，用之前自己核一下是不是真的在说这件事。'
          : '相关度偏低（可能只是字面擦边）。如果跟当前话题无关，换 depth="full" 再搜一次。'
    return { hits, confidence: Number(relMax.toFixed(3)), advice, depth, reranked, stages: layers }
  }

  // ============================================================
  // 观测 / 维护
  // ============================================================

  function stats() {
    const count = {}
    const charsBy = {}
    // L1 用"视图"统计（真 L1 + 所有 temp），否则整理前永远是 0
    try {
      const v = readL1View()
      count.L1 = v.items.length
      charsBy.L1 = chars(v.items)
    } catch { count.L1 = 0; charsBy.L1 = 0 }
    for (const l of ['L2', 'DL1', 'DL2', 'DL3']) {
      let items = []
      try { items = readLayerCached(l) } catch { /* 损坏的层按 0 展示，但 audit 里有记录 */ }
      count[l] = items.length
      charsBy[l] = chars(items)
    }
    let l3 = []
    try { l3 = readLayerCached('L3') } catch { /* 忽略 */ }
    count.L3 = l3.length
    charsBy.L3 = chars(l3)
    const temp = readTempsAll()
    let last = null
    try { last = JSON.parse(readFileSync(statePath, 'utf8')) } catch { /* 未跑过 */ }
    // 锁里记着「谁在整理」，页面要显示它；读不到就当没人。
    let lockOwner = null
    try { lockOwner = JSON.parse(readFileSync(lockPath, 'utf8'))?.writer ?? null } catch { /* 没锁 */ }
    // 信号队列：按「条」数（不是文件数）——否则 1 个文件里 20 条也只显示 1
    let signalOps = 0
    try {
      for (const f of readdirSync(sigDir).filter((x) => x.endsWith('.jsonl'))) {
        try { signalOps += readFileSync(join(sigDir, f), 'utf8').split('\n').filter(Boolean).length } catch { /* 读不了就不算 */ }
      }
    } catch { /* 没目录 */ }
    const byteOf = (l) => { try { return statSync(paths[l]).size } catch { return 0 } }
    const bytes = {}
    for (const l of ALL_LAYERS) bytes[l] = byteOf(l)
    return {
      count, chars: charsBy, bytes,
      // total 只算「真数据层」（L1/L2/DL1/DL2/DL3）；L3 是视图，页面上单列，
      // 不然「合计」会把同一批摘要算两遍。
      total: count.L1 + count.L2 + count.DL1 + count.DL2 + count.DL3,
      vectors: vectors.size,
      temp: temp.items.length,
      signals: signalOps,
      pending: temp.items.length + signalOps,
      calls,
      lock: { held: existsSync(lockPath), owner: lockOwner },
      last,
      dir, writer,
    }
  }

  function list(layer = null) {
    // ★ 一律返回数组副本：读的是缓存里的数组，直接给出去的话，
    //   调用方一个 sort/push 就把缓存改脏了（对象本身仍共享，只读字段可以用）。
    if (layer === 'L3') { try { return readLayerCached('L3').slice() } catch { return [] } }
    if (layer === 'L1') return readL1View().items.slice()
    if (layer) { try { return readLayerCached(layer).slice() } catch { return [] } }
    const out = [...readL1View().items]
    for (const l of ['L2', 'DL1', 'DL2', 'DL3']) { try { out.push(...readLayerCached(l)) } catch { /* 忽略 */ } }
    return out
  }

  function graveyard({ limit = 50 } = {}) {
    let raw = ''
    try { raw = readFileSync(gravePath, 'utf8') } catch { return [] }
    return raw.split(/\r?\n/).filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }

  let timer = null
  function start(opts = {}) {
    stop()
    const every = Number(opts.organizeEveryMs || cfg.organizeEveryMs) || 5 * 60 * 1000
    // 只有这一个定时器：整理里会按 viewRefreshMs 判断要不要重写 L3。
    // 不再单开一个 L3 定时器——那会在没拿钥匙时写 L3，等于第二个写者。
    timer = setInterval(() => { organize().catch(() => {}) }, every)
    if (timer.unref) timer.unref()
    // 启动补一轮（异步，不阻塞加载）
    Promise.resolve().then(() => organize()).catch(() => {})
  }
  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  loadVectors()

  return {
    // 写（返回 { ok, turnId, ids, layer }）
    write, writeMany, writeTurn,
    // 读
    buildBlock, search, list, stats, graveyard,
    // 维护
    organize, start, stop,
    // 信号
    attend, pin, forget,
    // 调试/测试用的最小集合
    cfg, dir, writer, frames: () => ({ cache: { size: layerCache.size, bytes: cacheBytes, ...cacheStat }, calls }),
  }
}
