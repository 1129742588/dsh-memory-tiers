/**
 * 四层记忆 v5 —— 二次重构骨架
 *
 * 与 memory4 的区别（详见 REFACTOR_PLAN.md）：
 *   1. 三层活跃流水线：及时层 → 巩固层 → 长久层
 *   2. 层用单一 `layer` 字段表达，不再用 weight × tier 交叉
 *   3. 新增 heat（热度）+ 按天去重的提及计数，替代"一次性判定 importance"
 *   4. 冷层分两级：DL1（长久层的深层延伸，默认不删）、DL3（及时层的深层，快速遗忘）
 *   5. 融合系统：重复合并 / 矛盾标记作废（骨架未实现，见 TODO）
 *
 * 当前完成度：
 *   ✅ 层定义、配置、条目结构
 *   ✅ heat 计算（已由 tune.mjs 验证参数）
 *   ✅ 分流判定（路由规则）
 *   ⬜ 写入与判重
 *   ⬜ 融合（重复 / 矛盾 / 折叠）
 *   ⬜ 检索
 *   ⬜ 注入
 *
 * 跑 `node memory5.mjs` 执行自测，验证 heat 逻辑与 tune.mjs 一致。
 */

// ============================================================
// 层定义（5 个，不多不少）
//
//   L1  及时层      原文，装满就分流
//   L2  巩固层      原文，等 7 天看会不会被再提起
//   L3  长久层      摘要，进上下文
//   DL1 及时层下沉  原文，不重要，快速遗忘
//   DL2 长久层原文  原文，重要，只压缩字数不改写（供查细节）
//   DL3 长久层下沉  摘要，L3 溢出（会变化，所以只能是摘要）
//
// ★ 为什么 L3/DL3 只能是摘要：它们会不断被融合、被取代、被改写。
//   原文一旦进入这个"会变的圈"，就没法保持原样了。
//   所以原文一律留在 DL2（不变），摘要才进 L3/DL3（会变）。
// ★ 同一事件只能存在于一层，否则每次总结都会重新发现它，
//   融合次数和热度会无限涨——系统自己把自己喂胖。
// ============================================================

export const LAYER = {
  HOT: 'L1',            // 及时层   原文  进上下文
  CONSOLIDATE: 'L2',    // 巩固层   原文  进上下文
  LONG: 'L3',           // ⚠️ 视图层，不落盘：从 DL3 排序截取出来的那部分
  DL_HOT: 'DL1',        // 及时层下沉  原文  不重要，快速遗忘
  DL_LONG_RAW: 'DL2',   // 长久层原文库 原文  重要，可压缩字数保细节
  DL_LONG: 'DL3',       // 长久层下沉  摘要  L3 溢出的摘要
}

/** 是不是深层（不进提示词） */
export const isDeep = (layer) => String(layer).startsWith('DL')

/** 是不是活跃层（进提示词） */
export const isActive = (layer) => !isDeep(layer)

/** 活跃层的层序（用于注入排序） */
const ACTIVE_ORDER = [LAYER.HOT, LAYER.CONSOLIDATE, LAYER.LONG]

// ============================================================
// 配置
//
// heat 相关参数由 tune.mjs 扫描 32 组得出，见 REFACTOR_PLAN D12。
// ============================================================

export const DEFAULTS = {
  // —— 容量 ——
  hotMaxChars: 2000,          // 及时层上限，超了取最老一半分流
  hotMaxItems: 200,
  consolidateMaxChars: 2500,  // 巩固层硬兜底（主触发是时间）
  consolidateMaxItems: 120,   // 条数兜底，防全是短句

  // ★ 摘要放在哪执行。
  //   'inline'   写完就压（默认，行为最简单，但大模型压 13 条要 9 秒，
  //              这天正好巩固层到期的话，用户发一条消息要等半分钟）
  //   'deferred' 只入队，等调用方闲置时 flushSummaries()。
  //              生产环境用这个：写入永远 1 秒内返回，摘要在后台跑。
  summarizeMode: 'inline',
  // ★ 弃用：L2 不再按时间到期（用户 10-31 决定）。
  //   L2 是一次性整层取走的缓冲区，只认 consolidateMaxChars/Items 两个容量上限。
  //   这个参数留着只是为了兼容旧配置，改成任何值都不影响行为。
  consolidateDays: 0,         // 已弃用（0 = 不按时间触发）
  longMaxChars: 2000,         // 长久层上限，超了往 DL3 沉

  // ★ L3 视图（DL3 → L3 的排序）重算间隔，默认 30 分钟。
  //   这是全局唯一需要节流的东西，原因见 l3View 的注释：
  //   L3 在上下文里排最前，它一变，后面 L2 / L1 的前缀缓存全断；
  //   而 L1 / L2 本来每轮都在变且排在末尾，节流它们没有意义。
  viewRefreshMs: 30 * 60 * 1000,
  dl2MaxChars: 12000,         // DL2（重要原文库）上限，超了就压缩字数
  dl2CompressTarget: 400,     // 单条超过这么多字才值得压缩
  allowModelCompress: false,  // ★ 默认不许用模型压缩：实测一个字都减不掉，纯烧钱

  // ★ 分类放在哪。
  //   'onWrite'     写入时就问模型（老行为）
  //   'onOverflow'  写入只用本地规则给初判，等 L1 满、出一半时再批量问一次
  //
  //   为什么默认 onOverflow：流程图里「大模型分类摘要」这个框在
  //   「L1 满，拿出一半」**之后**——分类本来就是分流的前置动作，不是写入的动作。
  //
  //   放在写入上有两个坏处：
  //   ① 每条消息都要等一次分类（batch 20 条 = 4.3 秒），而结果要等下次溢出才用得上；
  //   ② 分类和摘要是两个独立请求，而它们在流程图里是同一个框。
  //   放到溢出处：那时是整批 40 条一起问，一次往返；写入路径上只剩向量（90ms）。
  classifyMode: 'onOverflow',

  // ★ 分层路由依据（2026-10-31 用户方案）
  //   'citation'   一次调用：摘要 + 出处编号 → 被引用进 DL2，没被引用进 DL1
  //   'importance' 旧路子：先 classification 打重要度，再按分数分三路
  //
  //   为什么 citation 更好：
  //   ① 少一次调用（分类和摘要合成一次）
  //   ② 模型不用编数字——它只要回答"这条摘要从哪几条来"，这是阅读理解，它擅长
  //   ③ 路由结果自洽：进 DL2 的原文，一定有摘要引用它，不会出现
  //      "进了 DL2 却没有任何摘要提到它"的孤儿
  routeMode: 'citation',

  // 摘要"硬凑"检测阈值：一条摘要引用的几条来源，两两余弦均值低于这个值，
  // 就记一条 SUM_SUSPECT 审计（只观察，不自动拆）。
  summaryCoherenceWarn: 0.30,

  // ★ 检索只设一个"纯噪音"硬底，不设"够不够用"的闸门。
  //
  //   实测 rerank 原始分的分布是两个量级：
  //     不相关 0.018 / 0.010 / 0.009   → 硬底 0.02 能滤掉
  //     弱相关 0.183                   → 保留，交给会话模型判断
  //     相关   0.999 / 0.996           → 直接用
  //
  //   为什么不再卡 0.08：用户担心"收紧会漏搜"。搜多了模型自己能筛掉，
  //   搜漏了模型就永远不知道自己漏了什么——两种错不对称，宁可多给。
  minRerank: 0.02,

  // 相关性"够用"的分界（只用于给模型提建议，不过滤）：
  //   ≥ 0.5      可以直接用
  //   ≥ 这个值   中等，用前自己核一下
  //   <  这个值  偏低，建议换下一档再搜
  minRerankStrong: 0.08,

  // 余弦下限：留 0 表示不启用。上面那段说明了为什么它当不了闸门，
  // 真要收紧相关性请调 minRerank。
  minSem: 0,

  // —— 检索精排 ——
  rerankPool: 30,             // 最多送多少条去精排（多了贵且慢）
  rerankWeight: 0.55,         // 精排分占多少（其余留给时间/热度）

  // —— 热度指标（tune.mjs 扫出来的）——
  // ★ importance 不参与衰减；半衰期只随"活跃天数"变长（艾宾浩斯重复效应）
  heatHalfLife: 10,           // 半衰期基准（天）。★ 不要单独调它来加速 DL1 遗忘——
                              //   它同时决定 L3 排序的热度，改了会让热度公式自测全翻。
                              //   DL1 忘得快用 forgetThreshold 实现（见下）。
  heatRepeatBoost: 0.3,       // 重复系数：强度越高，半衰期越长
  heatRepeatCap: 20,          // 强度封顶，防止老记忆永不衰减
  heatPromoteThreshold: 1.0,  // 热度 ≥ 这个 → 有资格升长久层

  // —— 分流 ——
  routeCoreImportance: 0.85,  // 这个档直接进长久层（进门资格，不看热度）
  routeMidImportance: 0.4,    // 这个档进巩固层

  // —— 融合 ——
  // 0.80 → 0.82：略收紧，减少"有点像就判一次模型"的浪费。
  // （试过 0.87，太狠了——连真正的重复都漏掉，跨批的重复检测直接失效。）
  fusionPrefilter: 0.82,      // 跨批判重：向量预筛阈值
  batchDupSim: 0.95,          // 批内判重：几乎一模一样就直接合并，不调模型
  fusionMergeSim: 0.85,       // 摘要之间"算同一件事"的阈值（比判重更高）
  // ★ 全量融合已停用（2026-10-31 用户定：「融合只靠入库时搜索重复，然后模型判断是否融合」）。
  //   原来每 20 次写入跑一次全量两两比较：200 条 = 2 万对，2000 条 = 200 万对，
  //   是平方级，长得最快。现在只保留 fuseIntoDL3（摘要入 DL3 时搜相似）。
  //   0 = 不自动跑。手动仍可用 mem.fuse() 触发。
  fusionEveryNWrites: 0,
  fusionScanLimit: 200,       // 每次融合只扫最近这么多条摘要（O(n²) 要控量）
  supersededDampen: 0.5,      // 作废条 importance 打折

  // —— 遗忘 ——
  forgetBaseDays: 7,
  // ★ DL1 忘得快靠这个（2026-10-31 从 0.03 提到 0.25）。
  //   heatHalfLife=10 时 retention=exp(-t/10)：0.03 → 约 35 天才忘；0.25 → 约 14 天。
  //   用阈值而不是半衰期，是因为半衰期还决定 L3 排序，动了会连累热度公式。
  forgetThreshold: 0.25,
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

// ============================================================
// 条目结构
// ============================================================

let __seq = 0
let __idn = 0
// 尾部那 4 位随机是给「多进程共享一个库」用的：__idn 是进程内计数器，
// 两个进程（dsh + astrbot）都从 1 开始，纯计数器必然撞 id。
// 加了随机数后同毫秒同序号撞上的概率约 1/1.7e6，可忽略。
const nextId = () =>
  `m5_${(++__idn).toString(36)}_${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`

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
export function halfLifeOf(item, cfg = DEFAULTS) {
  const n = Math.min(Math.max(item.repeatStrength || 1, 1), cfg.heatRepeatCap)
  return cfg.heatHalfLife * (1 + cfg.heatRepeatBoost * Math.log2(1 + n))
}

/**
 * 记录一次"被提及"（检索命中 / 融合 / 用户主动提起）
 * 同一天重复调用不累加，符合"一天听 20 遍不等于记牢 20 倍"
 */
export function touchHeat(item, now = Date.now(), cfg = DEFAULTS) {
  // ⚠️ 必须用 ?? 不能用 ||：时间戳 0 是 falsy，用 || 会跳过它导致 dt 算错
  const last = item.lastMentionedAt ?? item.createdAt ?? now

  // ★ 按天去重：同一天不再加分，只把时间推到今天
  if (dayKey(now) === dayKey(last)) {
    item.lastMentionedAt = Math.max(last, now)
    return item.heat
  }

  // 先用"当前活跃天数"算出的半衰期做衰减，再加"间隔质量"，最后活跃天数 +1
  const dt = (now - last) / DAY
  const halfLife = halfLifeOf(item, cfg)
  const ratio = dt / halfLife
  const q = spacingQuality(ratio)
  item.heat = (item.heat || 0) * Math.pow(0.5, ratio) + q
  // ★ 强度累积决定之后的半衰期，间隔越合理涨得越多。
  //   不能只把 q 加到 heat 上——那点增量会被更长的间隔衰减吃掉，
  //   实测"隔1天"和"隔14天"会完全相等，等于没做间隔效应。
  item.repeatStrength = (item.repeatStrength || 1) + q
  item.lastMentionedAt = now
  return item.heat
}

/**
 * 当前有效热度（纯读，不改数据）
 * 用于判定"有没有资格升长久层"
 */
export function heatOf(item, now = Date.now(), cfg = DEFAULTS) {
  const last = item.lastMentionedAt ?? item.createdAt ?? now
  const dt = Math.max(0, (now - last) / DAY)
  const halfLife = halfLifeOf(item, cfg)
  return (item.heat || 0) * Math.pow(0.5, dt / halfLife)
}

/** 够不够格升长久层 */
export function canPromote(item, now = Date.now(), cfg = DEFAULTS) {
  if (item.pinned) return true
  return heatOf(item, now, cfg) >= cfg.heatPromoteThreshold
}

/**
 * 长久层溢出时挤谁（DL3）
 *
 * ★ 关键：淘汰是"容量驱动"，不是"热度驱动"。
 *   只要没满，哪怕热度降到 0 也留着（用户明确要求）。
 *   只有超了字数上限，才按热度升序挤出最低的那几条。
 *
 * ★ 不挤"刚够格进来的"：heat >= 晋升线的条目不参与淘汰。
 *   否则一条 heat 1.5 刚晋升进来，恰好是全场最低，
 *   会立刻被挤出去，来回抖。极端情况下宁可短暂超一点容量。
 *
 * @param {Array} items 长久层的全部条目
 * @param {number} maxChars 字数上限
 * @returns {Array} 该挤出去的条目
 */
export function pickOverflowVictims(items, maxChars, now = Date.now(), cfg = DEFAULTS) {
  const sizeOf = (it) => String(it.text || '').length
  let used = items.reduce((s, it) => s + sizeOf(it), 0)
  if (used <= maxChars) return []                       // 没满，谁也不走

  const byHeat = items
    .filter((it) => !it.pinned)
    .sort((a, b) => {
      const ha = heatOf(a, now, cfg)
      const hb = heatOf(b, now, cfg)
      if (Math.abs(ha - hb) > 1e-9) return ha - hb
      return (a.lastMentionedAt ?? a.createdAt) - (b.lastMentionedAt ?? b.createdAt)
    })

  // 优先挤"热度已经掉下来"的；但如果全都很热（典型场景：批量写入 20 条直通条目），
  // 就退而挤热度最低的——否则一条都挤不动，容量永远收敛不了（死锁）。
  const cool = byHeat.filter((it) => heatOf(it, now, cfg) < cfg.heatPromoteThreshold)
  const pool = cool.length ? cool : byHeat

  const out = []
  for (const it of pool) {
    if (used <= maxChars) break
    out.push(it)
    used -= sizeOf(it)
  }
  return out
}

// ============================================================
// 淘汰顺序（长久层满了沉谁）
//
// ★ 只按指标（热度）排，不看 importance。
//   这是"importance 与指标分离"的直接后果：
//     importance 管进门资格（0.85 直进），进门之后就不管了
//     留不留、沉不沉，全看热度
//
//   早期版本用 adjustedImportance（importance 加减来源折扣）排序，
//   等于把两套东西混成一个分数，已被推翻。
//
//   顺带的好处：热度天然随时间衰减，所以"老的先沉"是自动发生的，
//   不需要单独写时间规则。
// ============================================================

/** 挑选该下沉的条目（返回数组，最该沉的在前） */
export function pickDemoteVictims(items, now = Date.now(), cfg = DEFAULTS) {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? 1 : -1      // 钉住的最后
    const ha = heatOf(a, now, cfg)
    const hb = heatOf(b, now, cfg)
    if (Math.abs(ha - hb) > 1e-9) return ha - hb              // 热度低的先沉
    // 热度完全相同才比时间，保证排序稳定（memory4 的 P0 就是排序不确定）
    return (a.lastMentionedAt ?? a.createdAt) - (b.lastMentionedAt ?? b.createdAt)
  })
}

// ============================================================
// 分流（及时层溢出的去向）
//
// 这是"路由代替压缩"的核心：重要和次重要的留原文，只有不重要的才压。
// ============================================================

/**
 * 决定一条记忆的去向
 * @returns {{to: string, reason: string}}
 */
export function decideRoute(item, now = Date.now(), cfg = DEFAULTS) {
  // 1. 钉住的不动
  if (item.pinned) return { to: LAYER.LONG, reason: 'pinned' }

  const imp = Number(item.importance) || 0

  // 2. 最高档直接进长久层（打折：未经时间检验）
  if (imp >= cfg.routeCoreImportance) {
    return { to: LAYER.LONG, reason: 'importance-core' }
  }

  // 3. 中档 或 有热度 → 巩固层，给时间观察
  if (imp >= cfg.routeMidImportance || heatOf(item, now, cfg) >= cfg.heatPromoteThreshold) {
    return { to: LAYER.CONSOLIDATE, reason: 'mid-or-repeated' }
  }

  // 4. 其余 → 深层，这条才压缩
  return { to: LAYER.DL_HOT, reason: 'useless' }
}

/**
 * 巩固层到期后的去向
 *
 * 两种结局：
 *   够热 → 升长久层
 *   凉了 → DL3（快速遗忘区）
 *
 * 注意不是 DL1：DL1 是"长久层装不下的溢出"，
 * 而巩固层里凉掉的东西从来没进过长久层，不够格去那儿。
 */
export function decideConsolidateRoute(item, now = Date.now(), cfg = DEFAULTS) {
  if (item.pinned) return { to: LAYER.LONG, reason: 'pinned' }
  if (canPromote(item, now, cfg)) return { to: LAYER.LONG, reason: 'hot-enough' }
  return { to: LAYER.DL_HOT, reason: 'cooled-down' }
}

// ============================================================
// 存储层
//
// dir/
//   store.json                 { version, seq, items[] }
//   vectors.json               { id: base64 }
//   archive/{channel}/{id}.md  深层正文（带 frontmatter）
//   graveyard/forgotten.jsonl  真遗忘台账
//   audit.log                  每次写入/迁移/遗忘一行
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

// ★ 向量分片（2026-10-31）
//
// 原来所有向量写一个 vectors.json：{ id: base64 }。单条 5.4KB，
// 十万条就 540MB——JSON 字符串有长度上限（V8 ~512MB 开始报警、
// 再往上直接 RangeError: Invalid string length），而且 JSON.parse
// 的峰值内存是文件的 2~3 倍。库还没跑通，启动先炸。
//
// 改成分片：每片最多 5000 条（约 27MB），片数随库增长。
// 读取顺序由文件名序号保证，写入时全量重写 + 清掉多余旧片。
//
// ★ 兼容旧库：没有分片文件时，读旧的 vectors.json 并自动迁移
//   （写分片 + 旧文件改名 .bak，保留回退，下次不再读）。
//   这条是给已在跑的 .big / 线上库用的，不要删。
const VEC_SHARD_SIZE = 5000
const VEC_SHARD_RE = /^vectors-part-(\d{4})\.json$/          // 旧版无前缀
const vecShardName = (i) => `vectors-part-${String(i).padStart(4, '0')}.json`

// ★ 多写者（2026-11-01）：每个写者只写自己那份文件，读的时候把所有人的合并起来看。
//   这样两个进程同时跑也不需要锁——谁也不覆盖谁。
//   writer 名字只留 [a-z0-9_-]，因为它会进文件名。
const VEC_ANY_RE = /^vectors-(.+)-part-(\d{4})\.json$/
const vecOwnRe = (w) => new RegExp(`^vectors-${w}-part-(\\d{4})\\.json$`)
const vecOwnName = (w, i) => `vectors-${w}-part-${String(i).padStart(4, '0')}.json`
const sanitizeWriter = (w) =>
  String(w || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'default'
const STORE_RE = /^store-([A-Za-z0-9_-]+)\.json$/
const storeOwnName = (w) => `store-${w}.json`

export function createStore(dir, opts = {}) {
  // ★ 向量指纹：记录这批向量是哪个 embedding 模型生成的。
  //
  //   为什么必须有：Qwen3-Embedding-0.6B、bge-m3 **都是 1024 维**。
  //   换模型时 cosine() 里 `a.length !== b.length` 这个检查不会触发，
  //   旧向量会被当成合法向量参与计算，静默算出垃圾相似度——
  //   不报错、不崩，只是"检索结果越来越怪"，最难查的那种坏。
  //
  //   指纹不符 → 隔离旧向量 + 从零重建，宁可暂时没有语义检索也不给错的结果。
  const signature = typeof opts.signature === 'string' ? opts.signature : null
  const writer = sanitizeWriter(opts.writer)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'archive'), { recursive: true })
  mkdirSync(join(dir, 'graveyard'), { recursive: true })

  const storePath = join(dir, storeOwnName(writer))   // 自己的分片
  const legacyStorePath = join(dir, 'store.json')     // 旧版单文件：只迁移一次
  const vecPath = join(dir, 'vectors.json')           // 旧版单文件向量
  const metaPath = join(dir, `vectors-${writer}.meta.json`)
  const legacyMetaPath = join(dir, 'vectors.meta.json')

  let state = { version: 5, seq: 0, items: [] }
  let vectors = new Map()

  const listDir = () => { try { return readdirSync(dir) } catch { return [] } }

  function readShard(p) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'))
      return raw && Array.isArray(raw.items) ? raw : null
    } catch { return null }   // 单个分片坏了跳过，不让别的写者连累自己
  }

  /** 别人的分片：只读，标上 __foreign，写回时会被排除 */
  function loadForeign() {
    const out = []
    for (const f of listDir()) {
      const m = f.match(STORE_RE)
      if (!m || m[1] === writer) continue
      const raw = readShard(join(dir, f))
      if (!raw) continue
      for (const it of raw.items) { it.__foreign = true; out.push(it) }
    }
    return out
  }

  /**
   * 把别人的最新内容合并进来（他们可能刚写了新东西）。
   *
   * ★ 为什么需要：对方的条目是**启动时和他每次落盘时**才读进来的，
   *   不刷新的话 dsh 会一直看不见 astrbot 刚记的东西。
   * ★ 为什么带 TTL：全量 re-read 别人的分片有磁盘开销，
   *   检索/注入每次都刷太浪费；15 秒一次足够"感觉是实时的"。
   */
  // 别人的分片"指纹"：文件名 + 修改时间 + 大小。
  // 只要没变就不重读——比定时刷新准（对方一写就能看见），也比每次都读便宜。
  let foreignSig = ''
  let gen = 0            // 条目集合换过一代就 +1，上层缓存（分层索引）据此失效
  function foreignSignature() {
    let sig = ''
    try {
      for (const f of readdirSync(dir)) {
        const m = f.match(STORE_RE)
        if (!m || m[1] === writer) continue
        try {
          const st = statSync(join(dir, f))
          sig += `${f}:${st.mtimeMs}:${st.size};`
        } catch { sig += `${f}:?;` }
      }
    } catch { /* 列不出目录就当没变 */ }
    return sig
  }
  function refreshForeign() {
    const own = state.items.filter((it) => !it.__foreign)
    state.items = own.concat(loadForeign())
    foreignSig = foreignSignature()
    gen++
  }
  /** 别人的文件动过才重读。检索 / 注入 / 统计前调一下就行，代价是几次 stat */
  function maybeRefreshForeign() {
    const sig = foreignSignature()
    if (sig === foreignSig) return false
    refreshForeign()
    return true
  }
  foreignSig = foreignSignature()

  // 自己的数据：优先自己的分片；没有就认领旧版 store.json（只在还没有任何
  // store-*.json 时认领一次，否则第二个写者会把同一份数据领走变成双份）。
  let own = readShard(storePath)
  if (!own && existsSync(legacyStorePath) && !listDir().some((f) => STORE_RE.test(f))) {
    own = readShard(legacyStorePath)
  }
  if (own) state = own
  state.items = (state.items || []).concat(loadForeign())

  function readVecMeta() {
    try { return JSON.parse(readFileSync(metaPath, 'utf8')) } catch { return null }
  }

  /** 记录这批向量的来源模型；dim 顺带存一份，方便人工核对 */
  function writeVecMeta(count) {
    const first = vectors.values().next().value
    try {
      writeFileSync(metaPath, JSON.stringify({
        sig: signature,
        dim: first ? first.length : 0,
        count,
        at: new Date().toISOString(),
      }, null, 1), 'utf8')
    } catch { /* 写不了元数据不影响主流程 */ }
  }

  /** 指纹不符时把旧向量整体挪走（不删，留给用户回退/核对） */
  function quarantineVectors(reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const bak = join(dir, `vectors.stale-${writer}-${stamp}`)
    let moved = 0
    try {
      mkdirSync(bak, { recursive: true })
      for (const f of listDir()) {
        // 只隔离自己的：别人的向量我们没有资格动
        if (!vecOwnRe(writer).test(f) && f !== `vectors-${writer}.meta.json`) continue
        try { renameSync(join(dir, f), join(bak, f)); moved++ } catch { /* 单个失败不阻塞 */ }
      }
    } catch { /* 建不了备份目录就原地不动，下面也不加载 */ }
    console.warn?.('[memory5] 向量指纹不符（%s），旧向量已隔离到 %s（%d 个文件）', reason, bak, moved)
    return bak
  }

  /** 读自己的分片；没有任何分片返回 null（交给旧文件兼容逻辑） */
  function readVecShards() {
    let files = listDir()
    const re = vecOwnRe(writer)
    let shards = files.filter((f) => re.test(f)).sort()
    if (!shards.length) {
      // 首次迁移：目录里只有旧的无前缀分片，且还没有别的写者 → 认领为自己的
      const legacy = files.filter((f) => VEC_SHARD_RE.test(f))
      const others = files.filter((f) => VEC_ANY_RE.test(f) && !re.test(f))
      if (legacy.length && !others.length) {
        for (const f of legacy) {
          try { renameSync(join(dir, f), join(dir, vecOwnName(writer, Number(f.match(VEC_SHARD_RE)[1])))) } catch { /* 认领失败就跳过 */ }
        }
        if (!existsSync(metaPath) && existsSync(legacyMetaPath)) {
          try { renameSync(legacyMetaPath, metaPath) } catch { /* 同上 */ }
        }
        files = listDir()
        shards = files.filter((f) => re.test(f)).sort()
      }
    }
    if (!shards.length) return null
    const out = new Map()
    for (const f of shards) {
      let raw
      try { raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
      for (const [k, v] of Object.entries(raw || {})) {
        if (out.has(k)) continue            // 片间重复（异常）只认第一份
        const buf = Buffer.from(v, 'base64')
        out.set(k, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
      }
    }
    return out
  }

  /** 全量重写分片；条目变少时把多余旧片删掉 */
  function writeVecShards() {
    // 没有模型时不碰任何向量文件：现有向量可能是真模型生成的，
    // 用户接回模型后还能直接用，不能被一次空表覆盖掉。
    if (vectorsDisabled) return 0
    const entries = [...vectors.entries()]
    const shardCount = Math.ceil(entries.length / VEC_SHARD_SIZE)
    for (let i = 0; i < shardCount; i++) {
      const out = {}
      for (const [k, v] of entries.slice(i * VEC_SHARD_SIZE, (i + 1) * VEC_SHARD_SIZE)) {
        out[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
      }
      writeFileSync(join(dir, vecOwnName(writer, i)), JSON.stringify(out), 'utf8')
    }
    try {
      const re = vecOwnRe(writer)
      for (const f of listDir()) {
        const m = f.match(re)
        if (m && Number(m[1]) >= shardCount) unlinkSync(join(dir, f))
      }
    } catch { /* 清不掉不影响正确性，下次再清 */ }
    writeVecMeta(entries.length)
    return shardCount
  }

  // 没有模型（'none'）→ 语义层整体关闭：不读、不写向量文件，检索只走关键词。
  // 不读是因为查询侧没有 embed，qVec 恒为 null，读了也用不上；
  // 不写是为了保住现有的向量，等用户接上模型还能续用。
  const vectorsDisabled = signature === 'none'

  const sharded = vectorsDisabled ? null : readVecShards()
  if (sharded) {
    const meta = readVecMeta()
    // 只在新旧都明确时才判定；老库没有 meta（sig 缺失）按兼容处理，直接沿用
    const stale = signature && meta && typeof meta.sig === 'string' && meta.sig !== signature
    if (stale) {
      quarantineVectors(`${meta.sig} → ${signature}`)
      vectors = new Map()
    } else {
      vectors = sharded
      if (!meta) writeVecMeta(sharded.size)   // 老库补写指纹
    }
  } else if (!vectorsDisabled && existsSync(vecPath)) {   // 旧版单文件，仅首次
    try {
      const raw = JSON.parse(readFileSync(vecPath, 'utf8'))
      for (const [k, v] of Object.entries(raw || {})) {
        const buf = Buffer.from(v, 'base64')
        vectors.set(k, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
      }
      // 自动迁移到分片；旧文件改名 .bak（保留回退，不会再被读）
      writeVecShards()
      try { renameSync(vecPath, `${vecPath}.bak`) } catch { /* 改不了名也不影响 */ }
    } catch { /* 同上 */ }
  }

  /** 原子落盘：先写临时文件再改名。两个进程同时 save 不会互相撕坏文件 */
  function atomicWrite(p, body) {
    const tmp = `${p}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, p)
    } catch {
      try { unlinkSync(tmp) } catch { /* 临时文件清不掉不影响 */ }
      writeFileSync(p, body, 'utf8')   // 改名失败就退回直接写，别把数据丢了
    }
  }

  function save() {
    // 落盘前先看一眼别人有没有新东西，合并进内存视图
    refreshForeign()
    // 只写自己的条目：别人的数据在他们自己的分片里，我们没有资格替他们存
    const mine = state.items.filter((it) => !it.__foreign)
    atomicWrite(storePath, JSON.stringify({ ...state, items: mine }, null, 1))
    writeVecShards()
  }

  function saveVectors() {
    writeVecShards()
  }

  /** 导出合并后的单文件（调试/快照用；库大时慎用，仅供分析工具读） */
  function dumpVectors(targetPath) {
    const out = {}
    for (const [k, v] of vectors) {
      out[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
    }
    writeFileSync(targetPath, JSON.stringify(out), 'utf8')
  }

  function audit(line) {
    // 换行必须替掉，否则一条日志会写成多行，类型统计就废了
    const safe = String(line).replace(/[\r\n]+/g, ' ')
    try {
      const f = join(dir, 'audit.log')
      writeFileSync(f, `${new Date().toISOString()} ${safe}\n`, { flag: 'a' })
    } catch { /* 审计失败不该挡住主流程 */ }
  }

  return {
    get state() { return state },
    get items() { return state.items },
    set items(v) { state.items = v },
    get vectors() { return vectors },
    save, saveVectors, audit, refreshForeign, maybeRefreshForeign,
    /** 条目集合的代数：变了说明别人的数据合并进来了，上层缓存要重算 */
    get gen() { return gen },
    dumpVectors,
    dir,
    writer,
    /** 自己的条目（不含别人的） */
    get ownItems() { return state.items.filter((it) => !it.__foreign) },
    /** 是不是自己的条目——不是就不能改、不能删 */
    isOwn: (it) => !it.__foreign,
  }
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

/** 归档文件路径（统一正斜杠，跨平台不出岔子） */
function archiveRel(item) {
  return `archive/${item.channel || 'note'}/${item.id}.md`
}

/** 写归档，返回相对路径 */
export function writeArchive(dir, item, now) {
  const rel = archiveRel(item)
  const full = join(dir, ...rel.split('/'))
  mkdirSync(dirname(full), { recursive: true })

  const span = item.spanFrom && item.spanTo
    ? [`span: ${dayKey(item.spanFrom)} ~ ${dayKey(item.spanTo)}`]
    : []

  const body = [
    '---',
    `id: ${item.id}`,
    `layer: ${item.layer}`,
    `channel: ${item.channel}`,
    `kind: ${item.kind}`,
    item.speaker ? `speaker: ${item.speaker}` : '',
    item.people?.length ? `people: ${item.people.join('、')}` : '',
    item.scene ? `scene: ${item.scene}` : '',
    `importance: ${Number(item.importance).toFixed(2)}`,
    `heat: ${Number(item.heat || 1).toFixed(2)}`,
    `repeat_strength: ${Number(item.repeatStrength || 1).toFixed(2)}`,
    `created_local: ${new Date(item.createdAt).toLocaleString('zh-CN')}`,
    `archived_local: ${new Date(now).toLocaleString('zh-CN')}`,
    ...span,
    '---',
    '',
    item.text ?? '',
    '',
  ].filter((x) => x !== '').join('\n')

  writeFileSync(full, body, 'utf8')
  return rel
}

export function readArchive(dir, rel) {
  try {
    return readFileSync(join(dir, ...String(rel).split('/')), 'utf8')
  } catch {
    return ''
  }
}

// ============================================================
// 主体
// ============================================================

/**
 * @param {object} o
 * @param {string} o.dir 数据目录
 * @param {() => number} o.now 可注入的时钟（测试用）
 * @param {object} o.cfg 覆盖 DEFAULTS
 * @param {Function} o.embed (texts[]) => number[][]
 * @param {Function} o.classify (text) => {importance, channel}
 * @param {Function} o.judgeRelation (a, b) => 'duplicate'|'contradiction'|'update'|'unrelated'
 */
export function createMemory5(o = {}) {
  const cfg = { ...DEFAULTS, ...(o.cfg || {}) }
  const dir = o.dir || '.memory5'
  const tick = o.now || (() => Date.now())
  const store = createStore(dir, { signature: o.embedSignature, writer: o.writer })

  // ============================================================
  // 模型调用统计
  //
  // 用户关心"质量 / 时间 / 花销"的平衡，那就得看得见到底调了多少。
  // 三个数各管一件事，别混：
  //   items   处理了多少条   → token / 钱
  //   rounds  发起了几次请求 → 服务端压力
  //   waves   串行等了几波   → 延迟（并发请求算一波）
  //
  // 并发 10 个 → rounds +10 但 waves 只 +1。
  // 所以"没有批量接口"时 items 和 rounds 都不降，只有 waves 降——
  // 省的是时间，不是钱。这个区别决定了要不要去适配批量接口。
  // ============================================================
  const emptyCalls = () => ({
    embed: { rounds: 0, items: 0, waves: 0 },
    classify: { rounds: 0, items: 0, waves: 0 },
    relation: { rounds: 0, items: 0, waves: 0 },
    summarize: { rounds: 0, items: 0, waves: 0 },
    compress: { rounds: 0, items: 0, waves: 0 },
    rerank: { rounds: 0, items: 0, waves: 0 },
  })
  const calls = emptyCalls()

  // ============================================================
  // 模型调用闸门
  //
  // 「大模型不是每次都调用，每次调用都有前提」——把这句话变成可数的东西。
  //
  //   called   真调了
  //   skipped  前提不满足 → 走本地规则，不花钱
  //
  // 每次**没调**都记一条原因（'单条复用原文' / '无相似候选' / '预算用完' …），
  // 跑完 stats().gates 一眼能看出钱省在哪、哪些闸门一直没关上。
  //
  // ★ 为什么这个比"少调"更重要：没有这个计数，你只能看着账单猜
  //   「是不是哪又在偷偷调模型」。有了它，调用次数和跳过原因是分开的，
  //   对不上就是有漏网的调用点。
  // ============================================================
  const emptyGates = () => ({
    classify: { called: 0, skipped: {} },
    relation: { called: 0, skipped: {} },
    summarize: { called: 0, skipped: {} },
    compress: { called: 0, skipped: {} },
    rerank: { called: 0, skipped: {} },
  })
  const gates = emptyGates()

  const noteSkip = (k, reason) => {
    const g = gates[k]
    if (!g) return
    g.skipped[reason] = (g.skipped[reason] || 0) + 1
  }

  const bumpCall = (k, n = 1, waves = 1) => {
    calls[k].rounds++
    calls[k].items += n
    calls[k].waves += waves
    if (gates[k]) gates[k].called++
  }

  // ============================================================
  // 内部工具
  // ============================================================
  // 待摘要队列（summarizeMode === 'deferred' 时用）
  const summaryQueue = []

  // ★ 默认只返回**自己的**条目：分流、遗忘、压缩、融合这些会改数据的操作，
  //   只能动自己写的（别人的数据在别人的分片里，我们改了也存不回去）。
  //   要看全库（检索、注入上下文、统计、列目录）就传 { all: true }。
  const byLayer = (layer, opts) =>
    store.items.filter((it) => it.layer === layer && ((opts && opts.all) || !it.__foreign))
  const chars = (list) => list.reduce((s, it) => s + String(it.text || '').length, 0)
  const find = (id) => store.items.find((it) => it.id === id)
  const removeItem = (id) => {
    const it = store.items.find((x) => x.id === id)
    if (it && it.__foreign) return false   // 别人的条目：删了也会被他的分片带回来
    store.items = store.items.filter((it) => it.id !== id)
    invalidateLayerIndex()   // 条目少了，桶要重建
  }

  async function embedOne(text) {
    if (typeof o.embed !== 'function') return null
    bumpCall('embed', 1)
    try {
      const r = await o.embed([String(text).slice(0, 512)])
      return r?.[0] ? Float32Array.from(r[0]) : null
    } catch { return null }
  }

  /**
   * 批量向量
   *
   * embed 是所有模型调用里最频繁的一个（每条写入 + 每次搜索），
   * 单条一次往返，一天几十次就是几十秒的纯等待。
   * 一次传一批，耗时几乎不变。
   *
   * 分块是为了不撞 API 的单次条数上限。
   */
  async function embedMany(texts, chunk = 32) {
    if (typeof o.embed !== 'function') return texts.map(() => null)

    const out = []
    for (let i = 0; i < texts.length; i += chunk) {
      const slice = texts.slice(i, i + chunk).map((t) => String(t).slice(0, 512))
      bumpCall('embed', slice.length)
      try {
        const r = await o.embed(slice)
        for (let j = 0; j < slice.length; j++) {
          out.push(r?.[j] ? Float32Array.from(r[j]) : null)
        }
      } catch {
        // 这一块失败不影响别的块：缺向量只会让判重退化成"不判"，不会卡住写入
        for (let j = 0; j < slice.length; j++) out.push(null)
      }
    }
    return out
  }

  /** 分类输入加说话人前缀（只影响分类，不影响落库的正文） */
  function tagWithSpeaker(text, speaker) {
    return speaker ? `[${speaker}] ${text}` : String(text)
  }

  // —— 无模型时的本地兜底规则 ——
  //
  // ★ importance 不能固定 0.5：那样所有东西都落在"中等"档，
  //   全进巩固层，三路分流等于没有。
  //   这里按"是不是原则/有结果/闲聊"粗分三档，跟 classify 的三档对齐。
  const RULE_PRINCIPLE = /以后都?|从今|一律|必须|不准|不要|别(再)?|记住|规矩|原则|永远/
  const RULE_RESULT = /跑通|改完|删掉|部署|提交|补完|生成|清理|扩容|涨到|降到|\d+\s*(例|条|个|次|天|%)/
  const RULE_EVENT = /刷到|看到|听说|路上|群里|抖音|小红书|评论区/
  const RULE_ACT = /跑通|改完|删掉|部署|提交|补完|生成|清理|扩容|重采样|训练|调参/

  function localTag(text, speaker = '') {
    const t = String(text || '')
    let importance = 0.3
    if (RULE_PRINCIPLE.test(t)) importance = 0.9
    else if (RULE_RESULT.test(t)) importance = 0.6

    // 别人说的话不是"我做的事"——有 speaker 且不是自己，一律算对话
    const isSelf = !speaker || speaker === '我' || speaker === '自己'
    let channel = 'dialog'
    if (isSelf && RULE_ACT.test(t)) channel = 'action'
    else if (RULE_EVENT.test(t) && !isSelf) channel = 'event'
    else if (RULE_EVENT.test(t) && !RULE_ACT.test(t)) channel = 'event'

    return { importance, channel }
  }

  async function classifyOne(text, speaker = '') {
    const fallback = localTag(text, speaker)
    if (typeof o.classify !== 'function') return fallback
    bumpCall('classify', 1)
    try {
      // ★ 把说话人拼进去。不告诉模型「这话是谁说的」，
      //   它就会把「星鲸说地铁很吵」判成 event（外面发生的事），
      //   而实际是 dialog（某人说的话）。有前缀它能判准得多。
      const r = await o.classify(tagWithSpeaker(text, speaker))
      return r ? { importance: r.importance ?? fallback.importance, channel: r.channel || fallback.channel } : fallback
    } catch {
      return fallback
    }
  }

  /**
   * 批量分类
   *
   * 优先用 o.classifyBatch（一次问 N 条，成本约 1/N，延迟从 N×0.5s 降到 0.5s）。
   * 没有就并发调 o.classify——并发也比串行快一个数量级。
   * 都没有就用本地规则。
   */
  async function classifyMany(texts, chunk = 20, speakers = null) {
    // 有 speakers 就拼前缀，帮模型分清「谁说的」和「外面发生的」
    const inputs = speakers ? texts.map((t, i) => tagWithSpeaker(t, speakers[i])) : texts
    const out = new Array(inputs.length)

    if (typeof o.classifyBatch === 'function') {
      // ★ 分块**并发**发出去，不是串行。
      //
      //   实测 classifyBatch 20 条约 4.4 秒，但它对条数是近线性的（约 200ms/条），
      //   说明瓶颈是模型逐条生成，不是网络往返。
      //   40 条分两块串行 = 8.9 秒；两块之间毫无依赖，并发只要 4.4 秒——
      //   这是白捡的一半时间，之前一直浪费在 for await 上。
      //
      //   并发上限 3 块（60 条）：再高会撞 429，得不偿失。
      const starts = []
      for (let i = 0; i < inputs.length; i += chunk) starts.push(i)
      calls.classify.waves++                       // 整批同一波发出，只算一次等待

      let cursor = 0
      const worker = async () => {
        while (cursor < starts.length) {
          const i = starts[cursor++]
          const slice = inputs.slice(i, i + chunk)
          bumpCall('classify', slice.length, 0)    // rounds+1，waves 已单独记
          try {
            const r = await o.classifyBatch(slice)
            for (let j = 0; j < slice.length; j++) {
              const t = r?.[j]
              // 批量接口返回 null 单条 → 落到本地规则，跟单条路径口径一致。
              // ★ 本地规则要用**原始文本和 speaker**，不能用加了 [人名] 前缀的 slice[j]，
              //   否则 localTag 里的 isSelf 判断会失效。
              const fb = localTag(texts[i + j], speakers?.[i + j] || '')
              out[i + j] = t
                ? { importance: t.importance ?? fb.importance, channel: t.channel || fb.channel }
                : fb
            }
          } catch {
            for (let j = 0; j < slice.length; j++) out[i + j] = localTag(texts[i + j], speakers?.[i + j] || '')
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, starts.length) }, worker))
      return out
    }

    if (typeof o.classify === 'function') {
      for (let i = 0; i < inputs.length; i += chunk) {
        const slice = inputs.slice(i, i + chunk)
        calls.classify.waves++        // 这一整波的请求是同时发出去的，只算一次等待

        const got = await Promise.all(slice.map(async (t, j) => {
          const fb = localTag(texts[i + j], speakers?.[i + j] || '')
          calls.classify.rounds++
          calls.classify.items++
          try {
            const r = await o.classify(t)
            return r ? { importance: r.importance ?? fb.importance, channel: r.channel || fb.channel } : fb
          } catch { return fb }
        }))
        for (let j = 0; j < slice.length; j++) out[i + j] = got[j]
      }
      return out
    }

    return texts.map((t, i) => localTag(t, speakers?.[i] || ''))
  }

  // ============================================================
  // 判重与融合（融合的第 ① 个插入点）
  //
  // 范围：同 channel，全 tier（含深层）
  // 阈值：0.80（比"相关"高，是"同一件事"）
  // 只判：重复（合并）/ 矛盾（新替旧，旧的标作废）
  // ============================================================
  /**
   * 建一份"同 channel → [{it, vec}]"的索引
   *
   * 批量写入时如果每条都遍历整个 store.items，20 条就是 20 次全表扫描。
   * 建一次索引，后面只在同 channel 的池子里比，还省掉 Map 查找。
   */
  // ============================================================
  // 分层索引（2026-10-31 用户提出）
  //
  // ★ 问题：searchOnce 原来是 `for (const it of store.items)` 全库遍历，
  //   然后用 `layers.includes(it.layer)` 过滤。也就是说「只查 DL3 摘要层」
  //   和「查全部」代价一样——用户的分级设计完全没兑现。
  //   实测 1600 条时余弦扫全库 2.3ms（被网络掩盖），
  //   16 万条 340ms、160 万条 18 秒，那时分级就该省掉 2/3 的扫描量。
  //
  // ★ 做法：按 layer 分桶缓存，只扫目标层。
  //   失效条件只有三种——新增、删除、换层。属性变更（热度、fusionCount）
  //   不影响桶归属，所以不需要失效。
  //
  // ★ 向量不缓存在桶里：扫的时候现取 store.vectors.get(id)。
  //   这样所有 vectors.set/delete 都不用触发失效（少一处就少一处漏）。
  //   Map.get 是 O(1)，比重建索引便宜几个数量级。
  // ============================================================
  let _layerIndex = null
  let _layerIndexGen = -1

  // 用 function 声明而不是箭头函数：让它们能提升，removeItem / moveTo
  // 这些在 createMemory5 体里更早定义的函数就能安全调用，不会有 TDZ 风险。
  function invalidateLayerIndex() { _layerIndex = null }

  function getLayerIndex() {
    // 别人的数据合并进来后，索引必须重建，否则会漏掉他们新写的条目
    if (_layerIndex && _layerIndexGen === store.gen) return _layerIndex
    const m = new Map()
    for (const it of store.items) {
      let arr = m.get(it.layer)
      if (!arr) m.set(it.layer, arr = [])
      arr.push(it)
    }
    _layerIndex = m
    _layerIndexGen = store.gen
    return m
  }

  /** 按指定层取条目；不指定就全库 */
  function itemsInLayers(layers) {
    if (!layers || !layers.length) return store.items
    const idx = getLayerIndex()
    let out = []
    for (const l of layers) {
      const arr = idx.get(l)
      // 用 concat 而不是 spread：spread 会把整个数组摊进实参，
      // 十几万条时会撞 V8 的实参上限（RangeError: too many arguments）。
      if (arr) out = out.concat(arr)
    }
    return out
  }

  function buildVectorIndex() {
    const byCh = new Map()
    for (const it of store.items) {
      const v = store.vectors.get(it.id)
      if (!v) continue
      if (!byCh.has(it.channel)) byCh.set(it.channel, [])
      byCh.get(it.channel).push({ it, v })
    }
    return byCh
  }

  async function findRelation(text, channel, vec, index = null) {
    if (!vec || !store.vectors.size) return null

    const candidates = []
    const pool = index ? (index.get(channel) || []) : null

    if (pool) {
      for (const { it, v } of pool) {
        const sim = cosine(vec, v)
        if (sim >= cfg.fusionPrefilter) candidates.push({ it, sim })
      }
    } else {
      for (const it of store.items) {
        if (it.channel !== channel) continue
        const v = store.vectors.get(it.id)
        if (!v) continue
        const sim = cosine(vec, v)
        if (sim >= cfg.fusionPrefilter) candidates.push({ it, sim })
      }
    }
    if (!candidates.length) { noteSkip('relation', '无相似候选'); return null }

    candidates.sort((a, b) => b.sim - a.sim)
    const top = candidates[0]
    const type = await judgeRelationType(top.it.text, text)
    if (!type) return null
    return { type, target: top.it, sim: top.sim }
  }

  /**
   * 判两条的关系，返回归一化后的类型
   *
   * 为什么单独抽出来：批量写入时，同批新增的条目不在预先算好的关系里
   * （并发判时它们还没落库），得在串行落库阶段补判一次。两处共用这段逻辑。
   *
   * ★ 归一化的必要性：早先接的是「是不是同一件事」的 yes/no 接口，返回 boolean，
   *   而调用方判的是 `type === 'contradiction'`——boolean 永远不等于那个字符串，
   *   结果矛盾检测从来没生效过（作废条始终是 0）。现在 boolean 和字符串都兼容。
   */
  async function judgeRelationType(aText, bText) {
    let type = 'duplicate'
    if (typeof o.judgeRelation === 'function') {
      bumpCall('relation', 1)
      try {
        type = await o.judgeRelation(aText, bText)
      } catch { type = null }
    }

    if (type === true) return 'duplicate'
    if (type === false) return null
    if (type === null || type === undefined) return 'duplicate'   // 判不出来当重复，保守
    if (!['duplicate', 'contradiction', 'update', 'unrelated'].includes(type)) return 'duplicate'
    if (type === 'unrelated') return null
    return type
  }

  function mergeInto(target, { text, speaker, people, scene }, now) {
    const soft = new Set(target.people || [])
    if (speaker) soft.add(speaker)
    for (const p of people || []) soft.add(p)
    target.people = [...soft].filter(Boolean).slice(0, 10)
    if (!target.scene && scene) target.scene = scene

    // 新表述更长就用新的（通常信息更多）
    if (String(text).length > String(target.text).length) target.text = text

    target.fusionCount = (target.fusionCount || 0) + 1
    touchHeat(target, now, cfg)      // 融合 = 又提了一次
    target.importance = Math.max(Number(target.importance) || 0, Number(target.importance) || 0)

    store.audit(`MERGE ${target.id} ← 新条目 fusion=${target.fusionCount} layer=${target.layer}`)
    return { ok: true, id: target.id, layer: target.layer, merged: true }
  }

  // ============================================================
  // 写入
  //
  // 分成两层：
  //   commitOne  分类和向量已经算好，只做\"判重 → 合并或新建 → 落层\"
  //   write      单条入口，自己算分类和向量
  //   writeMany  批量入口，先批量算分类和向量，再逐条 commitOne
  //
  // 这样单条和批量共用同一套落库逻辑，不会两边分叉。
  // ============================================================

  /** 已算好分类和向量之后，真正落库 */
  /**
   * 落库一条
   *
   * ★ 2026-10-31 起：**不判重**。
   *   原来这里会 findRelation（和全库比余弦 → 相似就问模型判关系）。
   *   60 天实测 844 次调用 / 16.6 万 token，占总量 58%，随库线性增长。
   *
   *   用户的理由（比省成本更重要）：
   *   「只要还没进 DL3，就不用判重，因为总结摘要的时候模型看到两个
   *     相似的话题应该自己就会总结，觉得算是重要。」
   *
   *   重复本身是**重要性信号**：同样的话说了 2 次 vs 10 次，
   *   模型压摘要时分得出「反复叮嘱」和「刷屏」。提前去重会把这信号抹掉。
   *   跨批的重复和矛盾命令，留到摘要入 DL3 时再融合。
   */
  async function commitOne({ body, imp, ch, speaker, people, scene, kind, now, vec, impRough = false }) {
    // —— 新建（不判重，直接进 L1）——
    // ★ 一律先进及时层，不做\"直通\"。
    //   写入时判的 importance 只是初判，还没经过时间检验。
    //   去向统一由\"及时层满了分流\"决定：
    //     特重要 → 原文 DL2 + 摘要 L3
    //     中等   → L2 巩固
    //     不重要 → DL1
    //   如果写入就直通 L3，那\"分流时判特重要\"这条路永远走不到，DL2 形同虚设。
    const item = makeItem({
      text: body,
      layer: LAYER.HOT,
      channel: ch,
      speaker,
      people,
      scene,
      importance: imp,
      kind,
      at: now,
    })
    item.directEntry = false
    // ★ 这个 importance 是本地规则给的初判，还没被模型核过。
    //   分流时会按这个标记把整批再问一次模型。
    if (impRough) item.impRough = true

    // ★ 矛盾/进展的判定，已挪到「摘要入 DL3 时的融合」（见 fuseIntoDL3）。
    //   写入路径不再判重，所以这里不再处理关系。
    store.items.push(item)
    invalidateLayerIndex()
    if (vec) store.vectors.set(item.id, vec)

    store.audit(`WRITE ${item.id} → ${item.layer} ${ch} imp=${Number(imp).toFixed(2)}`)
    return { ok: true, id: item.id, layer: item.layer, channel: ch, importance: imp }
  }

  /** 写完之后收尾：容量收敛 + 落盘 */
  async function afterWrites(count, now) {
    if (count > 0) await enforceLimits(now)

    // ★ 全量融合已停用（2026-10-31 用户定）：融合只靠摘要入 DL3 时的 fuseIntoDL3。
    //   保留入口（fusionEveryNWrites > 0 时才跑），但默认 0 = 不自动跑。
    //   手动仍可用 mem.fuse() 触发。
    sinceFusion += count
    if (cfg.fusionEveryNWrites > 0 && sinceFusion >= cfg.fusionEveryNWrites) {
      sinceFusion = 0
      await consolidateFusion(now)
    }
    store.save()
  }

  async function write({
    text,
    speaker = '',
    people = [],
    scene = '',
    channel = '',
    importance = null,
    at = null,
    kind = 'raw',
  } = {}) {
    const body = String(text || '').trim()
    if (!body) return { ok: false, error: '内容为空' }
    const now = at ?? tick()

    let imp = importance
    let ch = channel
    let impRough = false
    if (imp === null || !ch) {
      // onOverflow：写入不阻塞在分类上，先本地初判，等溢出时整批复核
      if (cfg.classifyMode === 'onOverflow') {
        const fb = localTag(body, speaker)
        if (imp === null) { imp = fb.importance; impRough = true }
        if (!ch) ch = fb.channel
        noteSkip('classify', '写入不分类·留到溢出')
      } else {
        const tagged = await classifyOne(body, speaker)
        if (imp === null) imp = tagged.importance
        if (!ch) ch = tagged.channel
      }
    }

    const vec = await embedOne(body)
    const r = await commitOne({ body, imp, ch, speaker, people, scene, kind, now, vec, impRough })
    await afterWrites(1, now)
    return r
  }

  /**
   * 批量写入
   *
   * 为什么要有这个：单条 write 每条都要一次分类往返（~0.5s）+ 一次向量往返（~90ms）。
   * 补录历史、批量导入时 20 条就是 12 秒纯等待。
   *
   * 批量化之后：分类 2 次往返（每 10 条一次）、向量 1 次往返（每 32 条一次），
   * 20 条从 12 秒降到 1.2 秒左右。**落库逻辑完全没变**，只是把网络往返合并了。
   *
   * @param {Array} list 每一项同 write 的参数
   * @param {object} opt
   * @param {number} opt.chunk 每批处理多少条（默认 20）
   * @param {boolean} opt.classifyAll 是否整批一次性分类（默认 true）
   */
  async function writeMany(list = [], { chunk = 20 } = {}) {
    const rows = (list || []).map((x) => ({
      text: String(x?.text || '').trim(),
      speaker: x?.speaker || '',
      people: x?.people || [],
      scene: x?.scene || '',
      channel: x?.channel || '',
      importance: x?.importance ?? null,
      at: x?.at ?? null,
      kind: x?.kind || 'raw',
    })).filter((x) => x.text)

    if (!rows.length) return []
    if (rows.length === 1) return [await write(rows[0])]

    const results = []
    let written = 0

    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk)

      // ① 分类
      //
      // ★ 两种模式，见 cfg.classifyMode。
      //   onOverflow（默认）：写入只用本地规则给初判，标记 impRough，
      //   等这一条被"L1 溢出"选中分流时，再和它那一批一起问模型。
      //
      //   产出上的区别：分类总条数不变，但**请求次数和阻塞点变了**。
      //   原来是每条写入都要等（20 条 = 4.3 秒），现在是溢出时整批一次。
      const needTag = slice.filter((r) => r.importance === null || !r.channel)
      if (needTag.length && cfg.classifyMode === 'onWrite') {
        const tags = await classifyMany(needTag.map((r) => r.text), 20, needTag.map((r) => r.speaker))
        for (let k = 0; k < needTag.length; k++) {
          if (needTag[k].importance === null) needTag[k].importance = tags[k].importance
          if (!needTag[k].channel) needTag[k].channel = tags[k].channel
        }
      } else if (needTag.length) {
        for (const r of needTag) {
          const fb = localTag(r.text, r.speaker)
          if (r.importance === null) {
            r.importance = fb.importance
            r.impRough = true          // ← 等溢出时用模型复核
          }
          if (!r.channel) r.channel = fb.channel
        }
        noteSkip('classify', '写入不分类·留到溢出')
      }

      // ② 批量向量
      const vecs = await embedMany(slice.map((r) => r.text))

      // ③ 直接落库。**不判重、不合并**（2026-10-31 用户方案）
      //
      //   原来这里跑三件事：buildVectorIndex → 每条 findRelation → 批内余弦去重。
      //   60 天实测 844 次判重调用 / 16.6 万 token，占总量 58%，随库线性增长。
      //
      //   现在全砍掉，理由不只是省钱：
      //
      //   ① L1 / DL1 / L2 / DL2 都是**原文**，进上下文时对话模型自己看得出重复，
      //      去不去重不影响它理解。
      //   ② **重复度是重要性信号**。同样的话说了 2 次 vs 10 次，
      //      模型压摘要时分得出「反复叮嘱」和「刷屏」。
      //      提前去重会把这信号抹掉——去重后变成「1 次不要表情包 + 1 次刷屏」，
      //      模型再也分不出哪个是反复强调。
      //   ③ 跨批的重复和矛盾，留到摘要入 DL3 时由融合处理（那时才需要判）。
      for (let k = 0; k < slice.length; k++) {
        const r = slice[k]
        const now = r.at ?? tick()

        results.push(await commitOne({
          body: r.text,
          imp: r.importance ?? 0.3,
          ch: r.channel || 'dialog',
          speaker: r.speaker,
          people: r.people,
          scene: r.scene,
          kind: r.kind,
          now,
          vec: vecs[k],
          impRough: r.impRough === true,
        }))
        written++
      }
    }

    await afterWrites(written, tick())
    return results
  }

  // ============================================================
  // 迁移
  // ============================================================
  function moveTo(item, layer, reason, now) {
    // ★ 别人的条目不搬层：它在别人的分片里，我们改了也存不回去，
    //   下次读盘就被他自己的版本覆盖掉；更糟的是本次会话里它会被
    //   当成"我方数据"参与注入和容量计算，重启前后行为不一致。
    //   别人的层、热度、作废标记一律只读。
    if (!item || item.__foreign) return
    const from = item.layer
    if (from === layer) return

    item.layer = layer
    invalidateLayerIndex()   // 换层了，桶归属变了
    // ★ 进入巩固层时打时间戳：7 天观察期从这里算，不是从写入时间算。
    //   漏了这一步，"刚进巩固层"会被当成"已经待了很久"，当天就被判到期。
    if (layer === LAYER.CONSOLIDATE) item.consolidatedAt = now
    if (isDeep(layer)) {
      item.archivedAt = now
      item.archiveFile = writeArchive(dir, item, now)
      // 深层正文只在归档文件里放，store 里留一份索引用的短文本
      store.audit(`DEMOTE ${item.id} ${from}→${layer} (${reason})`)
    } else {
      if (item.archiveFile) {
        try { unlinkSync(join(dir, ...item.archiveFile.split('/'))) } catch { /* 已没 */ }
        item.archiveFile = null
      }
      item.archivedAt = null
      store.audit(`PROMOTE ${item.id} ${from}→${layer} (${reason})`)
    }
  }

  // ============================================================
  // 摘要（L2 + 热 DL1 → L3）
  //
  // 摘要只产出"摘要条"，参与摘要的原文一律删除——
  // 否则同一事件同时在 L3（摘要）和 DL1（原文）存在，
  // 下次总结又会把原文扫进去，判定成"又提了一次"，
  // 融合次数和热度会无限涨（系统自己把自己喂胖）。
  // ============================================================
  async function summarizeBatch(items, channel, now) {
    if (!items.length) return null

    // ★ 最后一道关：已作废的条目绝不进摘要。
    //   前面每条路径都过滤了，但入队到真正压之间隔着时间，
    //   中间如果发生了矛盾判定，这里得拦得住。
    const skipDead = items.filter((it) => it.supersededBy)
    if (skipDead.length) {
      store.audit(`SUMMARY_FILTER 跳过 ${skipDead.length} 条已作废`)
      items = items.filter((it) => !it.supersededBy)
      if (!items.length) return null
    }

    // ★ 单条直接复用原文，不调模型。
    //
    //   一条记忆"压缩"成一条摘要，字数几乎没减（有时还变长），细节反而丢了，
    //   而每次要花 5-8 秒调大模型。压测里这是主要开销：
    //   L1 分流出的 core 组大多是 1-2 条，每条都要等一次模型。
    //
    //   原文进 DL2 之后，这里再复制一份进 DL3 当"摘要"用——内容一样，
    //   但 L3 是视图，需要一条能在上下文里出现的东西。
    if (items.length === 1) {
      const it = items[0]
      const folks1 = (it.people?.length ? it.people : (it.speaker ? [it.speaker] : [])).slice(0, 10)
      noteSkip('summarize', '单条复用原文')
      store.audit(`SUMMARY_PASSTHRU ${it.id} 单条直接复用原文`)
      return {
        text: String(it.text).trim(),
        spanFrom: it.createdAt,
        spanTo: it.createdAt,
        people: folks1,
        sources: [it.id],
      }
    }

    const folks = [...new Set(
      items.flatMap((it) => (it.people?.length ? it.people : (it.speaker ? [it.speaker] : [])))
    )].filter(Boolean).slice(0, 10)

    let text = null
    if (typeof o.summarize === 'function') {
      bumpCall('summarize', items.length)
      try {
        const lines = items.map((it) => `${it.speaker ? `${it.speaker}：` : ''}${it.text}`)
        text = await o.summarize(lines, channel, folks)
      } catch { text = null }
    }
    if (!text) {
      // 无模型兜底：带说话人截断拼接（至少不丢"谁说的"）
      text = items
        .map((it) => `${it.speaker ? `${it.speaker}：` : ''}${String(it.text).replace(/\s+/g, ' ').slice(0, 40)}`)
        .join('；')
    }

    return {
      text: String(text).trim(),
      spanFrom: Math.min(...items.map((it) => it.createdAt)),
      spanTo: Math.max(...items.map((it) => it.createdAt)),
      people: folks,
      sources: items.map((it) => it.id),
    }
  }

  function pushSummary(sum, channel, now) {
    const item = makeItem({
      text: sum.text,
      // ★ 摘要一律进 DL3（摘要池）。L3 不是存储层，是"从 DL3 里排序截取出来的视图"。
      //   这样老摘要热度一掉，分数就掉，自动退出上下文，不需要搬数据。
      layer: LAYER.DL_LONG,
      channel,
      kind: 'summary',
      // ★ 重要性档位由模型给（2026-10-31）：★ 特别重要 0.9 / · 一般重要 0.7。
      //   不再写死 0.7——写死会让 L3 排序退化成纯按热度，「重要性×指标」没意义了。
      //   档位影响要小（用户：「热度主导，档位小影响」），0.9/0.7 间距 1.29 倍，
      //   而 heat 范围 1~20，天然主导。
      importance: Number(sum.importance) || 0.7,
      at: now,
    })
    item.spanFrom = sum.spanFrom
    item.spanTo = sum.spanTo
    item.people = sum.people
    item.sources = sum.sources
    // ★ 新摘要初始热度 = 2（新鲜度，2026-10-31 定）。
    //   不给的话新摘要 heat=1，会被老摘要（heat 5、8）压住，刚写入就进不了 L3 视图。
    //   之后靠融合 +1、attend +1 累积，随时间指数衰减。
    item.heat = 2
    store.items.push(item)
    invalidateLayerIndex()
    store.audit(`SUMMARY ${item.id} ${channel} imp=${item.importance} 覆盖 ${sum.sources.length} 条 (${dayKey(sum.spanFrom)}~${dayKey(sum.spanTo)})`)
    return item
  }

  /**
   * 标记"新条目取代旧条目"，并连带作废引用过旧条目的摘要
   *
   * ★ 连带那一步很关键：特重要的条目会「原文留 DL2 + 摘要进 DL3」，
   *   库里有两份。只作废原文，摘要那份还在，模型会同时看到
   *   「主人要求不要发表情包」和「主人要求要发表情包」——精神分裂。
   *   摘要记了 sources，靠它反查哪条摘要吃过这条原文。
   */
  function markSupersede(newItem, oldItem, now) {
    newItem.supersedes = oldItem.id
    oldItem.supersededBy = newItem.id

    // ★ 热度和计数**以新的为主**（用户 10-31）。
    //
    //   矛盾不是"又提了一次"，所以不给任何一方 +1（区别于重复合并那种 fusionCount++）。
    //   但新条目是当前有效版本，热度不能低于被它取代的那条——
    //   否则 l3View 按 importance×heat 排序时，新命令排到截断线外面，
    //   上下文里出现的还是旧命令，这次作废就白做了。
    //
    //   用 max 而不是累加：总数不增加（旧的被作废后不再计入活跃），只是换人顶上。
    newItem.heat = Math.max(Number(newItem.heat) || 1, Number(oldItem.heat) || 1)
    newItem.recallCount = Math.max(Number(newItem.recallCount) || 0, Number(oldItem.recallCount) || 0)
    newItem.fusionCount = Math.max(Number(newItem.fusionCount) || 0, Number(oldItem.fusionCount) || 0)
    newItem.repeatStrength = Math.max(Number(newItem.repeatStrength) || 1, Number(oldItem.repeatStrength) || 1)

    const affected = []
    for (const it of store.items) {
      if (it.kind !== 'summary' || it.supersededBy) continue
      // 别人的摘要不在我们的分片里，打不上作废标记（打了也存不回去）
      if (it.__foreign) continue
      if ((it.sources || []).includes(oldItem.id)) {
        it.supersededBy = newItem.id
        affected.push(it.id)
      }
    }
    store.audit(
      `SUPERSEDE ${oldItem.id} ← ${newItem.id}（矛盾，旧的降权保留；热度/计数转给新的）` +
      (affected.length ? ` 连带作废摘要 ${affected.join(',')}` : '')
    )
    return affected
  }

  /**
   * 新摘要入 DL3 时，和库里已有的摘要判一次关系
   *
   * ★ 这是判重的新位置（2026-10-31 用户方案）。原来是「每条写入时判」，
   *   60 天 844 次调用 / 16.6 万 token，占总量 58%，随库线性增长。
   *   挪到这里之后，三个好处一起到：
   *
   *     对象是摘要不是消息   —— 374 条摘要 vs 1453 条消息
   *     扫描量 O(摘要数)     —— 3 年后约 4000 条，而消息是 30 万条，差 75 倍
   *     摘要已被模型提炼过   —— 判"说的是不是同一件事"比判原文准
   *
   * ★ 为什么不该在写入时去重：重复度本身是重要性信号。
   *   同样的话说了 2 次 vs 10 次，模型压摘要时分得出「反复叮嘱」和「刷屏」。
   *   提前去重会把这信号抹掉（去重后变成「1 次不要表情包 + 1 次刷屏」，
   *   模型再也分不出哪个是反复强调的）。
   */
  async function fuseIntoDL3(newItem, now) {
    if (!newItem || newItem.kind !== 'summary') return null
    if (typeof o.judgeRelation !== 'function') { noteSkip('relation', '未接判关系模型'); return null }

    const nv = store.vectors.get(newItem.id)
    if (!nv) return null

    // 只和 DL3 里的摘要比（摘要 vs 摘要），不碰原文
    //
    // ★ 只跟**自己的**摘要比。别人的摘要在别人的分片里，一旦被判成"重复"
    //   就会被合并进来、而我们这一条会被删掉——删掉的写进了自己的分片
    //   （永久生效），合并的结果却落在别人的对象上（存不回去，重启即失效）。
    //   一合一删之后，这条内容两边都不剩，等于凭空丢一条记忆。
    //   所以跨写者不做判重 / 取代 / 融合，只做检索和注入。
    const cands = []
    for (const it of store.items) {
      if (it.id === newItem.id) continue
      if (it.__foreign) continue
      if (it.layer !== LAYER.DL_LONG || it.kind !== 'summary') continue
      if (it.supersededBy) continue
      const v = store.vectors.get(it.id)
      if (!v) continue
      const sim = cosine(nv, v)
      if (sim >= cfg.fusionPrefilter) cands.push({ it, sim })
    }
    if (!cands.length) {
      noteSkip('relation', 'DL3 无相似摘要')
      return null
    }

    cands.sort((a, b) => b.sim - a.sim)
    const top = cands[0]

    bumpCall('relation', 1)
    let type
    try {
      type = await o.judgeRelation(top.it.text, newItem.text)
    } catch { type = null }

    if (type === true) type = 'duplicate'
    if (type === false) type = null
    if (type === null || type === undefined) type = 'duplicate'
    if (!['duplicate', 'contradiction', 'update', 'unrelated'].includes(type)) type = 'duplicate'
    if (type === 'unrelated') return null

    if (type === 'duplicate') {
      // 重复：合并进旧的，新的删掉
      mergeSummaries(top.it, newItem, now)
      removeItem(newItem.id)
      store.vectors.delete(newItem.id)
      invalidateLayerIndex()
      store.audit(`FUSE_DUP ${newItem.id} → ${top.it.id}（DL3 重复合并）`)
      return { type, target: top.it, sim: top.sim }
    }

    if (type === 'contradiction') {
      markSupersede(newItem, top.it, now)
      return { type, target: top.it, sim: top.sim }
    }

    // update：事情在推进，不是矛盾——两条都留。
    // 「Dice 0.86」和「Dice 涨到 0.88」都该在库里，删了进展史就没了。
    newItem.updates = top.it.id
    store.audit(`FUSE_UPDATE ${top.it.id} → ${newItem.id}（进展，两条都保留）`)
    return { type, target: top.it, sim: top.sim }
  }

  /** 按 channel 分组做摘要，原文删除 */
  async function summarizeAndReplace(items, now, reason) {
    // ★ 作废条不进摘要：它已经被新命令取代了，压进摘要只会让摘要自相矛盾
    //   （"不要发表情"和"要发表情"同时出现）。作废条本身仍然留在库里可被搜到。
    const alive = items.filter((it) => !it.supersededBy)
    const dead = items.filter((it) => it.supersededBy)

    // 作废条不摘要，但也不能赖在活跃层——沉到 DL1，还能被搜到（问"以前的规矩"时有用）
    for (const it of dead) moveTo(it, LAYER.DL_HOT, '已作废', now)

    const groups = new Map()
    for (const it of alive) {
      if (!groups.has(it.channel)) groups.set(it.channel, [])
      groups.get(it.channel).push(it)
    }

    // ★ 单条不摘要。
    //   一条原文压成一条摘要，字数几乎没减、细节反而丢了，还白花一次模型调用。
    //   实测 27 条摘要里有 10 条是"来源 1 条"，纯浪费。
    //   这种情况直接按重要性归位：重要的留原文进 DL2，不重要的进 DL1 自然遗忘。
    const toSummarize = []
    for (const [ch, group] of groups) {
      if (group.length === 1) {
        const it = group[0]
        const keepRaw = Number(it.importance) >= cfg.routeCoreImportance
        noteSkip('summarize', '单条无需摘要')
        moveTo(it, keepRaw ? LAYER.DL_LONG_RAW : LAYER.DL_HOT, '单条无需摘要', now)
        store.audit(`SKIP_SUMMARY ${it.id} 单条 → ${keepRaw ? 'DL2' : 'DL1'}`)
        continue
      }
      toSummarize.push([ch, group])
    }

    // ★ 先并发算摘要文本，再串行落库。
    //   summarizeBatch 只读不写，可以安全并发；落库要改 store.items，必须串行。
    //   实测串行压 3 个 channel 要 20 秒，并发后降到 7 秒左右。
    const sums = await Promise.all(
      toSummarize.map(([ch, group]) => summarizeBatch(group, ch, now).then((sum) => ({ ch, group, sum })))
    )

    for (const { ch, group, sum } of sums) {
      if (!sum) continue
      // ★ 先删原文（含向量和归档），再放摘要——同一事件只留一处
      for (const it of group) {
        removeItem(it.id)
        store.vectors.delete(it.id)
        if (it.archiveFile) {
          try { unlinkSync(join(dir, ...it.archiveFile.split('/'))) } catch { /* 已没 */ }
        }
      }
      const item = pushSummary(sum, ch, now)
      const vec = await embedOne(item.text)
      if (vec) store.vectors.set(item.id, vec)
      store.audit(`ROLLUP ${group.length} 条 [${ch}] → 摘要 ${item.id} (${reason})`)
    }
  }

  /**
   * 把待摘要队列跑掉
   *
   * 为什么要有这一步：摘要调大模型，压十几条要将近十秒。
   * 如果这段时间卡在写入路径上，用户发一条消息就要等半分钟——
   * 而摘要本来不急，晚几秒压完全没影响。
   *
   * 队列里存的是 id 不是对象：入队到出队之间，条目可能已经被
   * 别的流程搬走或删掉，所以出队时要重新确认它们还在、还在该在的层。
   *
   * @returns {Promise<number>} 实际处理掉的条数
   */
  async function flushSummaries(now = tick()) {
    if (!summaryQueue.length) return 0

    const jobs = summaryQueue.splice(0)
    let done = 0

    for (const job of jobs) {
      // —— route 模式：L1 溢出时暂存在 L2 的那一批，现在真正路由 ——
      //    一次调用出摘要 + 出处，被引用的进 DL2，没被引用的进 DL1。
      //    route2 = 巩固层到期/满仓，同一套逻辑，只是模型标 + 的这次直接沉 DL2。
      if (job.mode === 'route' || job.mode === 'route2') {
        const items = (job.ids || []).map((id) => find(id)).filter(Boolean)
        if (!items.length) continue
        const sums = await routeByCitation(items, now, { secondChance: job.mode === 'route2' })
        if (sums.length) {
          const vecs = await embedMany(sums.map((it) => it.text))
          for (let i = 0; i < sums.length; i++) {
            if (vecs[i]) store.vectors.set(sums[i].id, vecs[i])
          }

          // ★ 摘要入 DL3 时做融合（判重的新位置，见 fuseIntoDL3）。
          //   必须等向量算好才能比，所以放在 embedMany 之后。
          for (const s of sums) await fuseIntoDL3(s, now)
        }
        done += items.length
        continue
      }

      // —— core 模式：原文已经在 DL2 里了，这里只补一条摘要进 L3 ——
      //    注意不能删原文：DL2 的职责就是留着原文供查细节。
      if (job.mode === 'core') {
        // ★ 出队时再过滤一次。入队到出队之间可能发生了矛盾判定，
        //   那时这条已经被取代了——压进去就是给摘要投毒。
        const items = (job.ids || [])
          .map((id) => find(id))
          .filter((it) => it && !it.supersededBy)
        if (!items.length) continue
        const sum = await summarizeBatch(items, job.channel, now)
        if (sum) {
          const item = pushSummary(sum, job.channel, now)
          const vec = await embedOne(item.text)
          if (vec) store.vectors.set(item.id, vec)
          store.audit(`ROLLUP_CORE ${items.length} 条 [${job.channel}] → 摘要 ${item.id}`)
        }
        done += items.length
        continue
      }

      // —— replace 模式：原文要被摘要替代，所以压完就删 ——
      const items = (job.items || job.ids || [])
        .map((id) => find(id))
        .filter((it) => it && !isDeep(it.layer))     // 已经沉下去的不再摘要

      if (items.length < 2) {
        // 单条不值得压，直接归位
        for (const it of items) {
          const keepRaw = Number(it.importance) >= cfg.routeCoreImportance
          moveTo(it, keepRaw ? LAYER.DL_LONG_RAW : LAYER.DL_HOT, '单条无需摘要', now)
        }
        continue
      }

      await summarizeAndReplace(items, now, job.reason)
      done += items.length
    }

    store.save()
    return done
  }

  /** 有没有还没压的 */
  function pendingSummaries() {
    return summaryQueue.reduce((n, j) => n + (j.items || j.ids || []).length, 0)
  }

  // ============================================================
  // DL2 压缩（不是摘要，只压缩字数）
  //
  // DL2 存的是"重要内容的原文"，供用户问细节时回答。
  // 它不能被摘要——摘要会丢失细节。
  // 所以超容量时只做"精简表达"：保留全部事实，去掉冗余措辞。
  // 每次压缩记一次 compressCount，方便回看被压过几次。
  // ============================================================
  async function compressText(text) {
    const src = String(text)

    // ① 先走本地规则（免费）
    const local = src
      .replace(/[，,]\s*(然后|接着|之后|后来|其实|反正|大概|差不多)/g, '，')
      .replace(/(就是说|也就是说|换句话说)/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    // 本地能压出效果就不用调模型
    if (local.length <= src.length * 0.97) return local

    // ② 本地压不动，才考虑模型——而且必须显式允许
    //
    // ★ 默认关闭，因为实测模型压缩**一个字都减不掉**：
    //   「保留全部事实、只压缩字数」这个要求下，它只会把原文照抄一遍。
    //   代价是每次 54 个 output token + 1.8 秒，收益为零。
    //
    //   更糟的是它会让 DL2 容量永远降不下来——字数没变，
    //   下次写入又触发一次压缩，把同一批条目反复压，无限重复。
    //   压测里 295K 输出 token 大部分就是这么烧掉的。
    if (!cfg.allowModelCompress) { noteSkip('compress', '模型压缩默认关闭'); return local }
    if (typeof o.compress !== 'function') { noteSkip('compress', '未接模型'); return local }

    bumpCall('compress', 1)
    try {
      const r = await o.compress(src)
      if (r && String(r).trim() && String(r).trim().length < src.length) return String(r).trim()
    } catch { /* 落到本地 */ }
    return local
  }

  /**
   * 压缩 DL2（重要原文库）
   *
   * ★ 「DL2 在本地，不用频繁压，给个压缩入口就行」——对，所以它有两个入口：
   *
   *   自动：只在**超出容量**时跑。压完字数降下来，下一次就不触发了；
   *         压不动的那条打 compressFailed 标记，之后永远跳过它。
   *         所以"频繁"这件事本身已经被容量判断 + 标记挡住了，
   *         真正每次都跑的是容量检查（几次数组遍历，微秒级），不是压缩。
   *
   *   手动：mem.compressDL2({ force: true })，运维时随时能压一遍，
   *         不用等它自己超容量。也可以只压某几条（only）。
   *
   * @param {object}  opt
   * @param {boolean} opt.force 忽略容量判断（手动入口用）
   * @param {number}  opt.now
   * @param {string[]} opt.only 只压这些 id
   */
  async function compressDL2({ force = false, now = tick(), only = null } = {}) {
    const dl2 = byLayer(LAYER.DL_LONG_RAW)
    const before = chars(dl2)
    if (!force && before <= cfg.dl2MaxChars) {
      noteSkip('compress', '未超容量')
      return { compressed: 0, chars: before, cap: cfg.dl2MaxChars }
    }

    const pool = only ? dl2.filter((it) => only.includes(it.id)) : dl2
    const victims = pool
      .filter((it) => !it.pinned && !it.compressFailed && String(it.text || '').length > cfg.dl2CompressTarget)
      .sort((a, b) => String(b.text).length - String(a.text).length)

    if (!victims.length) noteSkip('compress', '没有可压的条目')

    let n = 0
    for (const it of victims) {
      // 手动 force 时不管容量，逐条压完；自动时压到容量内就停
      if (!force && chars(byLayer(LAYER.DL_LONG_RAW)) <= cfg.dl2MaxChars) break
      const len = String(it.text || '').length
      const shorter = await compressText(it.text)

      if (shorter && shorter.length < len) {
        const saved = len - shorter.length
        it.text = shorter
        it.compressCount = (it.compressCount || 0) + 1
        store.audit(`COMPRESS ${it.id} -${saved}字 第${it.compressCount}次`)
        n++
      } else {
        // ★ 压不动的打标记，下次不再尝试。
        //   不打标记的话，字数没降 → chars 还是超 → 下次写入又压一遍，
        //   同一批条目被反复压，每轮都白付一次模型调用。
        it.compressFailed = true
      }
    }
    return { compressed: n, chars: chars(byLayer(LAYER.DL_LONG_RAW)), cap: cfg.dl2MaxChars, tried: victims.length }
  }

  // ============================================================
  // 定期融合（不是每次写入都做）
  //
  // 写入时的 findRelation 只能发现"新条目 vs 库里已有"的重复。
  // 但两条**旧**条目之间的重复，只有定期全量扫才能发现——
  // 比如第 1 天和第 5 天各压出一条摘要，说的其实是同一件事。
  //
  // ★ 触发按"写入条数"而不是时间：写得少的时候没必要频繁扫。
  // ★ 只扫最近 fusionScanLimit 条：O(n²) 比较，几条千条会拖慢。
  // ============================================================
  let sinceFusion = 0

  function mergeSummaries(target, src, now) {
    if (String(src.text || '').length > String(target.text || '').length) target.text = src.text

    const tFrom = target.spanFrom ?? target.createdAt
    const tTo = target.spanTo ?? target.createdAt
    const sFrom = src.spanFrom ?? src.createdAt
    const sTo = src.spanTo ?? src.createdAt
    target.spanFrom = Math.min(tFrom, sFrom)
    target.spanTo = Math.max(tTo, sTo)

    target.people = [...new Set([...(target.people || []), ...(src.people || [])])].filter(Boolean).slice(0, 10)
    target.sources = [...(target.sources || []), ...(src.sources || [])]

    target.importance = Math.max(Number(target.importance) || 0, Number(src.importance) || 0)
    target.heat = Math.max(heatOf(target, now, cfg), heatOf(src, now, cfg))
    target.lastMentionedAt = now
    target.repeatStrength = Math.max(target.repeatStrength || 1, src.repeatStrength || 1)
    target.fusionCount = (target.fusionCount || 0) + 1
  }

  async function consolidateFusion(now = tick()) {
    const pool = byLayer(LAYER.DL_LONG)
      .filter((it) => !it.supersededBy)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, cfg.fusionScanLimit)

    if (pool.length < 2) return 0

    const removed = new Set()
    let merged = 0

    for (let i = 0; i < pool.length; i++) {
      const a = pool[i]
      if (removed.has(a.id)) continue
      const va = store.vectors.get(a.id)
      if (!va) continue

      for (let j = i + 1; j < pool.length; j++) {
        const b = pool[j]
        if (removed.has(b.id) || a.channel !== b.channel) continue
        const vb = store.vectors.get(b.id)
        if (!vb) continue

        if (cosine(va, vb) < cfg.fusionMergeSim) continue

        mergeSummaries(a, b, now)
        removed.add(b.id)
        merged++
      }
    }

    for (const id of removed) {
      removeItem(id)
      store.vectors.delete(id)
    }

    if (merged) {
      // 合并后文本变了，向量要重算，否则下次比的是旧向量。
      //
      // ★ 必须批量。原来这里是逐条 await embedOne，一次融合合并 30 条
      //   就是 30 次串行往返（每次 0.5 秒 = 15 秒）。压测里表现为
      //   "某一天写入突然花 25 秒"，其实干的是融合，不是写入。
      const needVec = pool.filter((it) => !removed.has(it.id) && (it.fusionCount || 0) > 0)
      if (needVec.length) {
        const vecs = await embedMany(needVec.map((it) => it.text))
        for (let i = 0; i < needVec.length; i++) {
          if (vecs[i]) store.vectors.set(needVec[i].id, vecs[i])
        }
      }
      store.audit(`FUSION 合并 ${merged} 条摘要（扫描 ${pool.length} 条）`)
    }
    return merged
  }

  // ============================================================
  // 容量控制（完整流水线）
  // ============================================================
  async function enforceLimits(now = tick()) {
    // ⓪ 作废条一律不留在活跃层
    //
    //   被取代的命令既不该进上下文，也不该参与后续的摘要——
    //   它一旦留在 L1/L2，等巩固层到期时就会跟新命令一起被压，
    //   模型看到「不要发表情包」和「要发表情包」同时出现，
    //   很可能把否定词压丢（实测就是这样：压出来「主人要求群里发表情包」）。
    //   沉到 DL1 保留，问「以前的规矩」时还能搜到。
    for (const it of store.items) {
      if (it.supersededBy && (it.layer === LAYER.HOT || it.layer === LAYER.CONSOLIDATE)) {
        moveTo(it, LAYER.DL_HOT, '已作废', now)
      }
    }

    // ① 及时层超容量 → 反复取最老一半分流，直到收敛
    //
    // ★ 必须循环。原来只分一次流，单个写入够用（一次只多一条），
    //   但 writeMany 一批进 20 条时，分掉一半还超，下一批写入才会再收敛——
    //   中间这段时间 L1 一直是超容量状态，注入会膨胀。
    //   每轮至少分掉一条，一定收敛；20 轮是防配置错误（上限设成 0）的死循环兜底。
    const newSummaries = []   // 循环里产生的摘要，最后一次性算向量

    for (let round = 0; round < 20; round++) {
      const hot = byLayer(LAYER.HOT).sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq))
      if (chars(hot) <= cfg.hotMaxChars && hot.length <= cfg.hotMaxItems) break

      const half = hot.slice(0, Math.max(1, Math.floor(hot.length / 2)))

      // ★ 分流前先让模型复核 importance。
      //
      //   这就是流程图里那个「大模型分类摘要」——分类和摘要本来就绑在一起，
      //   发生在"L1 满，拿出一半"之后，而不是写入时。
      //   写入时只用本地规则给个初判（免费、快），这里才是花钱的那一步。
      //
      //   为什么放在可能被多次执行的循环里也不多余：复核过的条目会删掉
      //   impRough 标记，第二轮再进来时 rough.length = 0，直接跳过，不重复调。
      // ★ citation 路由：一次调用出摘要 + 出处，然后按引用决定去留。
      //
      //   这是"先总结、再分"——不是先判重要度再决定谁去总结。
      //   模型只需要回答"我这条摘要依据了哪几条"，不用给 0.85 这种数字。
      if (cfg.routeMode === 'citation' && typeof o.summarizeWithSources === 'function') {
        if (cfg.summarizeMode === 'deferred') {
          // 先把这一半挪出 L1 腾地方，落在 L2 当暂存区；后台 flush 时再真正路由
          for (const it of half) {
            moveTo(it, LAYER.CONSOLIDATE, '溢出待路由', now)
            it.pendingRoute = true
          }
          summaryQueue.push({ mode: 'route', ids: half.map((it) => it.id), reason: 'L1溢出' })
          store.audit(`HOT_OVERFLOW[第${round + 1}轮] ${chars(hot)}/${cfg.hotMaxChars}字 ${hot.length}条 → ${half.length} 条暂存 L2 待路由`)
        } else {
          const sums = await routeByCitation(half, now)
          for (const x of sums) newSummaries.push(x)
          store.audit(`HOT_OVERFLOW[第${round + 1}轮] ${chars(hot)}/${cfg.hotMaxChars}字 ${hot.length}条 → ${half.length} 条按引用路由`)
        }
        continue
      }

      await refineImportance(half, now)
      // ★ 已作废的不能走 core。
      //   时间线是这样的：第 11 天写「不要发表情包」→ 第 15 天写「要发表情包」
      //   → 写入时就扫到 L1 里那条旧命令并作废了 → 但 L1 还没分流，
      //   分流时它 importance 0.85 进了 core，又被压进摘要——
      //   摘要里于是同时有「不要发」和「要发」。
      //   作废条一律走 DL1（保留可搜，但不进摘要、不进上下文）。
      const core = half.filter(
        (it) => Number(it.importance) >= cfg.routeCoreImportance && !it.supersededBy
      )
      const mid = half.filter(
        (it) => Number(it.importance) >= cfg.routeMidImportance &&
          Number(it.importance) < cfg.routeCoreImportance &&
          !it.supersededBy
      )
      const low = half.filter((it) => Number(it.importance) < cfg.routeMidImportance)

      store.audit(`HOT_OVERFLOW[第${round + 1}轮] ${chars(hot)}/${cfg.hotMaxChars}字 ${hot.length}条 → 分流 ${half.length}（重要${core.length} 中${mid.length} 低${low.length}）`)

      // 特重要：原文进 DL2（保细节），摘要进 L3（进上下文）
      // —— 这是唯一会"一条内容变两处"的地方，但两处形态不同（原文 vs 摘要），
      //    不算重复，因为摘要不是同一句话，且原文在 DL2 不进上下文。
      if (core.length) {
        const byCh = new Map()
        for (const it of core) {
          if (!byCh.has(it.channel)) byCh.set(it.channel, [])
          byCh.get(it.channel).push(it)
        }
        for (const [ch, group0] of byCh) {
          const group = group0.filter((it) => !it.supersededBy)
          if (!group.length) continue

          // 原文立刻进 DL2：这一步不调模型，很快
          for (const it of group) moveTo(it, LAYER.DL_LONG_RAW, '特重要·原文留底', now)

          // 摘要才是慢的那步。deferred 时入队，等后台补。
          if (cfg.summarizeMode === 'deferred') {
            summaryQueue.push({
              mode: 'core',
              ids: group.map((it) => it.id),
              channel: ch,
              reason: '特重要·补摘要',
            })
          } else {
            const sum = await summarizeBatch(group, ch, now)
            if (sum) newSummaries.push(pushSummary(sum, ch, now))
          }
        }
      }

      // 中等：原文进巩固层，等 7 天
      for (const it of mid) moveTo(it, LAYER.CONSOLIDATE, '中等·待观察', now)

      // 低：原文进 DL1，快速遗忘
      for (const it of low) moveTo(it, LAYER.DL_HOT, '不重要', now)
    }

    // 分流产生的摘要，向量一次性算完（多轮分流会有多条）
    if (newSummaries.length) {
      const vecs = await embedMany(newSummaries.map((it) => it.text))
      for (let i = 0; i < newSummaries.length; i++) {
        if (vecs[i]) store.vectors.set(newSummaries[i].id, vecs[i])
      }
    }

    // ② 巩固层满了 / 到期 → 摘要（巩固层 + DL1 里还有热度的）
    //
    // ★ 为什么把"还有热度的 DL1"也带上：
    //   DL1 里已经凉透的让它自然忘掉；但还热的说明还有人需要，
    //   直接忘掉浪费，压进摘要留住更划算。
    // ★ 压完原文一律删：同一事件不能同时存在于摘要（L3）和原文（DL1）。
    // ★ 排除"溢出待路由"的暂存条：它们已经排进 summaryQueue 了，
    //   不能被这里当成普通巩固条再压一遍（会压两次、路由两次）。
    const cons = byLayer(LAYER.CONSOLIDATE).filter((it) => !it.pendingRoute)
    const consFull = chars(cons) > cfg.consolidateMaxChars || cons.length > cfg.consolidateMaxItems
    // ★ 只按容量触发，**不设到期时间**（用户 10-31 明确）。
    //
    //   L2 是缓冲区：满了就取走一批做摘要，不按"进来几天了"分批走。
    //   原来那套 7 天到期会带来副作用——只要有一条到期，整层都被拎走，
    //   等于变相按时间冲刷。现在只认容量。
    //
    // ★ 取法（2026-10-31 用户定）：**不是整层**，而是取「时间戳最旧的一批」，
    //   字数累加到 consolidateMaxChars / 2 为止（最后一条可超出），
    //   再加上 **DL1 的全部**。
    //
    //   为什么不是整层：整层取走会让 L2 瞬间清空，缓存断档；
    //   取一半留下一半，下次再取，缓存连续。
    //
    //   为什么 DL1 取全部而不是只取热的：DL1 里的数据可能隔很久又被提及，
    //   用"还有热度"筛会漏掉那些刚被提及但热度还没攒起来的。
    if (consFull) {
      // 按 consolidatedAt（进 L2 的时间）排序，取最旧的一批。
      //
      // ★ 为什么用 consolidatedAt 而不是 createdAt：DL1 升回 L2 的条目
      //   内容时间可能很老，用 createdAt 排会把它排到最前，打乱时间流（缓存）。
      //   用「进 L2 的时间」排，它就自然融入当前时间窗。
      //   原文 createdAt 本身不变（原则 2），只是排序键不同。
      const sorted = [...cons].sort(
        (a, b) => (a.consolidatedAt || a.createdAt) - (b.consolidatedAt || b.createdAt)
      )
      const target = cfg.consolidateMaxChars / 2
      let used = 0
      const due = []
      for (const it of sorted) {
        due.push(it)
        used += String(it.text || '').length
        if (used >= target) break      // 到一半为止，最后一条可超出
      }

      const allDL1 = byLayer(LAYER.DL_HOT)   // DL1 全部，不按热度筛
      const batch = [...due, ...allDL1]
      if (batch.length) {
        const reason = '巩固层满容量'
        store.audit(`CONSOLIDATE_FULL ${cons.length} 条 / ${chars(cons)} 字 → 取旧 ${due.length} 条（${used} 字，目标 ${target} 字）+ DL1 全部 ${allDL1.length} 条`)

        // ★ 跟 L1 溢出走**同一套**逻辑（用户 10-31：'L2 到期或满仓时也是做摘要，
        //   逻辑跟 L1 取一半时差不多，只是数据多点'）。
        //
        //   区别只有一处：这里的条目已经在 L2 观察过一轮了。
        //   所以"模型再次标了 +"的，这次直接沉 DL2 —— 观察期用完就该落地，
        //   否则会 L2 → 到期 → 又标 + → 又进 L2，无限循环。
        if (cfg.routeMode === 'citation' && typeof o.summarizeWithSources === 'function') {
          if (cfg.summarizeMode === 'deferred') {
            summaryQueue.push({ mode: 'route2', ids: batch.map((it) => it.id), reason, at: now })
            store.audit(`SUMMARY_QUEUED ${batch.length} 条（deferred·巩固层）`)
          } else {
            const sums = await routeByCitation(batch, now, { secondChance: true })
            for (const x of sums) newSummaries.push(x)
          }
        } else if (cfg.summarizeMode === 'deferred') {
          // 只入队，不阻塞写入。flushSummaries() 时才真正调模型。
          summaryQueue.push({ items: batch.map((it) => it.id), reason, at: now })
          store.audit(`SUMMARY_QUEUED ${batch.length} 条（deferred）`)
        } else {
          await summarizeAndReplace(batch, now, reason)
        }
      }
    }

    // ③ L3 不需要"溢出"：它是视图，排序靠后的自动不进上下文。
    //    DL3 **不遗忘**（2026-10-31 用户定）——它是长期记忆，只进不出。

    // ④ DL2 超容量 → 只压缩字数，不摘要（保留细节）
    //   ★ 超容量才跑；没超直接 skip（记一条 '未超容量'，不遍历、不花钱）
    await compressDL2({ now })

    // ⑤ 遗忘：**只作用于 DL1**（2026-10-31 用户定）。
    //   DL1 是流水账，忘得快（半衰期 3 天）。
    //   DL2 保底原文、DL3 长期摘要，都不遗忘。
    for (const layer of [LAYER.DL_HOT]) {
      for (const it of byLayer(layer)) {
        if (it.pinned) continue
        const keep = retentionOf(it, now, cfg)
        if (keep < cfg.forgetThreshold) forget(it, `保持率 ${keep.toFixed(3)} 低于阈值`, now, keep)
      }
    }

    store.save()
  }

  /**
   * 溢出前复核 importance（只在 classifyMode='onOverflow' 时真有活干）
   *
   * 本地规则只能认出「命令词 / 数字结果 / 今天有点困」这几类，
   * 剩下的它一律给 0.3，分不出「清了一轮空标注删掉 37 个坏样本」该多重要。
   * 所以真正的判级还是靠模型，只是把时机从"每条写入"挪到"整批分流"。
   *
   * 好处：
   *   ① 写入路径上不再有分类请求 → 写入只等一次向量（~90ms）
   *   ② 整批一次请求，而不是每条一次
   *   ③ 没进过分流的条目（刚写进来的）根本不会被分类 —— 它们可能被合并、
   *      被作废、甚至直接遗忘，那种情况下分类纯属浪费
   */
  async function refineImportance(items, now) {
    const rough = items.filter((it) => it.impRough)
    if (!rough.length) { noteSkip('classify', '无需复核'); return 0 }
    if (typeof o.classifyBatch !== 'function' && typeof o.classify !== 'function') {
      noteSkip('classify', '未接模型')
      return 0
    }

    const tags = await classifyMany(
      rough.map((it) => String(it.text || '')),
      20,
      rough.map((it) => it.speaker || '')
    )

    let changed = 0
    for (let i = 0; i < rough.length; i++) {
      const t = tags[i]
      if (!t) continue
      if (Number(t.importance) !== Number(rough[i].importance)) changed++
      rough[i].importance = Number(t.importance)
      if (t.channel) rough[i].channel = t.channel
      delete rough[i].impRough
    }
    store.audit(`REFINE 溢出复核 ${rough.length} 条（改判 ${changed}）`)
    return rough.length
  }

  /**
   * 按「摘要引用」路由（cfg.routeMode === 'citation'）
   *
   * 一次调用做两件事：把这一批压成摘要，同时标出每条摘要依据了哪几条原文。
   * 然后照着引用决定去留：
   *
   *   被摘要引到的  → DL2（原文留底，供以后查细节）
   *   没被引到的    → DL1（流水账，快忘）
   *   摘要本身      → DL3（进上下文的那一份）
   *
   * ★ 为什么这个比"打重要度"靠谱：
   *   让模型给 0.85 分是在逼它做一道没有标准答案的题；
   *   让它说"这句摘要来自第 3、7 条"是在做阅读理解——有标准答案，编不了。
   *   实测 12 条原文 → 6 条摘要，出处全对，没有编造编号。
   *
   * ★ 兜底：模型挂了、或者返回的编号一个都不合法 → 整批进 DL2。
   *   宁可多留原文（DL2 只占磁盘，不进上下文），也不能把内容弄丢。
   *
   * @return {Array} 新产生的摘要条目（调用方负责算向量）
   */
  async function routeByCitation(items = [], now = tick(), { secondChance = false } = {}) {
    const all = (items || []).filter(Boolean)
    if (!all.length) return []

    // 作废条不进摘要，直接沉 DL1（还能被搜到，但不再参与上下文）
    const alive = []
    for (const it of all) {
      delete it.pendingRoute
      if (it.supersededBy) moveTo(it, LAYER.DL_HOT, '已作废', now)
      else alive.push(it)
    }
    if (!alive.length) return []

    // 按通道分组：摘要的重点不一样（对话看谁说了什么，行为看结果和数字）
    const byCh = new Map()
    for (const it of alive) {
      const ch = it.channel || 'dialog'
      if (!byCh.has(ch)) byCh.set(ch, [])
      byCh.get(ch).push(it)
    }

    const out = []
    for (const [ch, group] of byCh) {
      const folks = [...new Set(group.flatMap((it) => (
        it.people?.length ? it.people : (it.speaker ? [it.speaker] : [])
      )))].filter(Boolean).slice(0, 10)

      const lines = group.map((it) => `${it.speaker ? `${it.speaker}：` : ''}${it.text}`)
      let res = null
      bumpCall('summarize', group.length)
      try {
        res = await o.summarizeWithSources(lines, ch, folks)
      } catch { res = null }

      // 模型没产出 → 整批原文保底进 DL2，不丢内容
      if (!res || (!res.summaries?.length && !res.keep?.length)) {
        noteSkip('summarize', '出处解析失败·整批进DL2')
        for (const it of group) moveTo(it, LAYER.DL_LONG_RAW, '摘要失败·原文保底', now)
        store.audit(`ROUTE_FAIL ${ch} ${group.length} 条 → 整批 DL2`)
        continue
      }

      const cited = new Set()
      const keepSet = new Set((res.keep || []).map((i) => group[i - 1]?.id).filter(Boolean))
      let citations = 0
      let suspect = 0

      // ★ 条数兜底：模型偶尔不听话（实测 34 条出了 17 条摘要，等于没压缩）。
      //   提示词里已经说了"超过上限的会被丢弃"，这里真的丢，两边口径一致。
      //   丢掉的摘要对应的原文不会被删——它们只是没被引用，会照常落到 DL1，
      //   所以信息没丢，只是没进摘要层。
      let summaries = res.summaries || []
      if (res.maxLines && summaries.length > res.maxLines) {
        store.audit(`SUM_OVER ${ch} ${summaries.length} 条 > 上限 ${res.maxLines}，丢弃 ${summaries.length - res.maxLines} 条`)
        summaries = summaries.slice(0, res.maxLines)
      }

      // ★ L1 路径只收「特重要」的摘要进 DL3（用户 10-31）。
      //
      //   L1 溢出是第一批沉淀，DL3 是稀有的长期记忆，要挑最值得的（★，importance ≥ 0.9）。
      //   · 那些虽然也写了摘要，但**不进 DL3**——它们的 sources 也跟着走 L2/DL1，
      //   不能进 DL2（没摘要指向它，DL2 就是孤儿，永远搜不到）。
      //
      //   L2 路径（secondChance）**不设限**，★ 和 · 都正常进 DL3。
      //   理由：L2 是缓冲区，满了做整理，本来就是"正常摘要"，不该比 L1 更严。
      let gated = false
      if (!secondChance) {
        const keyOnly = summaries.filter((s) => (Number(s.importance) || 0) >= 0.9)
        if (keyOnly.length < summaries.length) {
          store.audit(`ROUTE_GATE ${ch} L1路径只收特重要：${summaries.length} 条 → ${keyOnly.length} 条进 DL3`)
          summaries = keyOnly
          gated = true
        }
      }

      for (const s of summaries) {
        const srcItems = s.sources.map((i) => group[i - 1]).filter(Boolean)
        if (!srcItems.length) continue      // 没出处的摘要收不了——不知道它覆盖了谁

        // ★ 硬凑检测（只记账，不改行为）
        //
        //   给摘要设条数上限之后，模型可能为了凑数把不相干的事缝成一行：
        //   实测「周末爬山 + 地铁故障 + 鸡蛋涨价」被压成过一句。
        //   这里用来源之间的余弦均值兜一下底——同一件事的几句话向量本来就近，
        //   硬凑的会明显偏低。偏低就打一条审计，跑完能数出来有多少条可疑。
        //
        //   为什么不直接拆开或丢弃：余弦低不等于错（"红烧肉涨价"和"鸡蛋涨价"
        //   余弦可能不高，但确实是同一件事）。自动处理会误伤，先看清楚再说。
        if (srcItems.length >= 2) {
          const vecs = srcItems.map((it) => store.vectors.get(it.id)).filter(Boolean)
          if (vecs.length >= 2) {
            let sum = 0
            let pairs = 0
            for (let a = 0; a < vecs.length; a++) {
              for (let b = a + 1; b < vecs.length; b++) { sum += cosine(vecs[a], vecs[b]); pairs++ }
            }
            const avg = pairs ? sum / pairs : 1
            if (avg < cfg.summaryCoherenceWarn) {
              suspect++
              store.audit(`SUM_SUSPECT ${ch} 来源余弦 ${avg.toFixed(2)} 「${String(s.text).slice(0, 30)}」`)
            }
          }
        }

        for (const it of srcItems) cited.add(it.id)
        citations += srcItems.length
        out.push(pushSummary({
          text: s.text,
          spanFrom: Math.min(...srcItems.map((it) => it.createdAt)),
          spanTo: Math.max(...srcItems.map((it) => it.createdAt)),
          people: folks,
          sources: srcItems.map((it) => it.id),
          // ★ 档位由模型给：★ 特别重要 0.9 / · 一般重要 0.7
          importance: s.importance,
        }, ch, now))
      }

      // 一条都没引上（编号全越界）→ 按解析失败处理，别把整批误判成"全不重要"
      // ★ 但「L1 路径过滤后没特重要」不算失败——那是正常分流，
      //   走下面的三路去向（L2/DL1），不能整批塞进 DL2。
      if (!cited.size && !keepSet.size && !gated) {
        for (const it of group) moveTo(it, LAYER.DL_LONG_RAW, '引用为空·原文保底', now)
        store.audit(`ROUTE_FAIL ${ch} 0 条被引用 → 整批 DL2`)
        continue
      }

      // ★ 三路去向（用户 10-31 第二版）：
      //   被摘要引用  → DL2  有摘要指向它，以后下探查细节就靠它
      //   模型标了 +  → L2   进不了摘要但值得留，是"L1 及时性的延伸"，观察 7 天
      //   其余        → DL1  流水账，快忘
      //
      //   为什么要 L2 这一档：只有"引用/没引用"两路太二分了。
      //   有很多内容是"现在没用、以后可能要"，直接沉 DL1 会丢，
      //   直接进 DL2 又会让 DL2 无限膨胀。中间需要一个观察期。
      let toDL2 = 0
      let toL2 = 0
      let toDL1 = 0
      for (const it of group) {
        if (cited.has(it.id)) {
          moveTo(it, LAYER.DL_LONG_RAW, '摘要引用·原文留底', now)
          toDL2++
        } else if (keepSet.has(it.id)) {
          if (secondChance) {
            // 观察期已经用完，这次不再延长——落到 DL2，别在 L2 里打转
            moveTo(it, LAYER.DL_LONG_RAW, '观察后保留·沉淀', now)
            toDL2++
          } else {
            moveTo(it, LAYER.CONSOLIDATE, '模型标记·观察', now)
            it.consolidatedAt = now
            toL2++
          }
        } else {
          moveTo(it, LAYER.DL_HOT, '摘要未引用', now)
          toDL1++
        }
      }
      store.audit(`ROUTE ${ch} ${group.length} 条 → DL2 ${toDL2} / L2 ${toL2} / DL1 ${toDL1}（摘要 ${summaries.length} 条，引用 ${citations} 处${suspect ? `，可疑 ${suspect} 条` : ''}）`)
    }
    return out
  }

  /** 保持率（只用于深层） */
  function retentionOf(item, now = tick(), c = cfg) {
    const last = item.lastMentionedAt ?? item.createdAt
    const t = Math.max(0, (now - last) / DAY)
    const s = halfLifeOf(item, c)
    return Math.exp(-t / s)
  }

  /** 真遗忘：先进台账，再从库和归档里删 */
  function forget(item, reason, now, keep = null) {
    const rel = archiveRel(item)
    const rec = {
      id: item.id,
      layer: item.layer,
      channel: item.channel,
      text: String(item.text || '').slice(0, 240),
      importance: item.importance,
      created_local: new Date(item.createdAt).toLocaleString('zh-CN'),
      forgotten_local: new Date(now).toLocaleString('zh-CN'),
      lifespan_days: Math.round((now - item.createdAt) / DAY),
      retention: keep === null ? null : Number(keep.toFixed(3)),
      reason,
    }
    try {
      writeFileSync(join(dir, 'graveyard', 'forgotten.jsonl'), JSON.stringify(rec) + '\n', { flag: 'a' })
    } catch {
      store.audit(`FORGET_FAIL ${item.id} 台账写不进去，不删`)
      return false
    }
    removeItem(item.id)
    store.vectors.delete(item.id)
    try { unlinkSync(join(dir, ...rel.split('/'))) } catch { /* 没归档就算了 */ }
    store.audit(`FORGET ${item.id} ${item.layer} R=${keep === null ? '?' : keep.toFixed(4)}`)
    return true
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
    // 中文按二元组补
    const zh = s.replace(/[^\u4e00-\u9fa5]/g, '')
    for (let i = 0; i < zh.length - 1; i++) {
      const bg = zh.slice(i, i + 2)
      if (!STOP.has(bg)) out.add(bg)
    }
    return out
  }

  /** 解析时间词，返回 {from, to} 或 null */
  function parseTime(q, now) {
    const d0 = new Date(now)
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const today = startOfDay(d0)
    const m = {
      刚刚: [now - 2 * 3600e3, now],
      今天: [today, today + DAY],
      昨天: [today - DAY, today],
      前天: [today - 2 * DAY, today - DAY],
      这周: [today - 6 * DAY, today + DAY],
      上周: [today - 13 * DAY, today - 6 * DAY],
      最近: [today - 7 * DAY, today + DAY],
      之前: [0, now],
    }
    for (const [k, v] of Object.entries(m)) {
      if (String(q).includes(k)) return { from: v[0], to: v[1], word: k }
    }
    return null
  }

  /**
   * 检索
   *
   * ★ 默认只扫三个 D 层（DL1/DL2/DL3）。
   *   L1/L2/L3 每轮都已经注入上下文了，模型直接能看见，不必再搜一遍。
   *   搜索是为"翻旧账"用的：东西已经沉下去、不在上下文里了。
   *
   * ★ DL2 是最耗时的一层（存了大量原文）。如果确实慢，
   *   可以传 dl2: 'skip' 跳过它——代价是"重要事件的细节"搜不到。
   */
  // ★ 什么问法需要细节。
  //   「你昨天做了些什么」只要大意 → 查摘要层就够；
  //   「我上次原话怎么说的」要细节 → 要下到原文层。
  const DETAIL_HINTS = /具体|原话|细节|怎么说的|怎么讲|当时|原原本本|哪一句|逐条|列一下|都做了|分别|多少|几号/

  // 三档搜索层。**只能按顺序下探**：summary → detail → full，不许跳。
  const DEPTH_LAYERS = {
    summary: [LAYER.DL_LONG],
    detail: [LAYER.DL_LONG, LAYER.DL_LONG_RAW],
    full: [LAYER.DL_LONG, LAYER.DL_LONG_RAW, LAYER.DL_HOT],
  }

  /**
   * 分级检索（2026-10-31 用户方案，第二版）
   *
   * 核心变化：**闸门放松，把"够不够切题"的判断权交给会话模型**。
   *
   *   旧版：minRerank 卡死 0.08 → 搜得准，但可能漏掉真正相关的（假阴性）。
   *   新版：硬底只有 0.02（滤掉 0.01 那一档纯噪音），其余带 rel 分数一起给出去，
   *        由会话模型看完结果自己判断"这跟当前话题有没有关系"，
   *        没关系就换下一档再搜一次。
   *
   * ★ 为什么必须这么做：
   *   收紧闸门 → 漏搜（用户明确担心这个）
   *   放宽闸门 → DL3 几乎每次都有结果 → 模型看到就用 → DL1 永远轮不到
   *   唯一的出路是"让能看懂上下文的一方来判"——也就是会话模型。
   *
   * ★ 成本：每多搜一次约 300 token（6 条 × 50 字）+ 0.3~0.5 秒。
   *   最多两轮 ≈ 600 token，比一次摘要（1600 token）便宜得多，
   *   比"答错一次"更便宜。所以宽松 > 保守。
   *
   * @param {string} depth 'auto' | 'summary' | 'detail' | 'full'
   * @returns 带 confidence / advice 的结果，advice 是给模型看的下一步建议
   */
  async function search(query, { depth = 'auto', ...opt } = {}) {
    store.maybeRefreshForeign()      // 别人可能刚写了新东西，15 秒内刷一次
    const q = String(query || '').trim()
    const limit = opt.limit || 6

    // auto：按问法猜起始层；猜成 summary 时保留"空了自动落 DL1"的老兜底，
    // 这样不依赖模型驱动的调用方（脚本、测试）也能拿到结果。
    if (depth === 'auto') {
      const guess = DETAIL_HINTS.test(q) ? 'detail' : 'summary'
      const r = await searchOnce(q, { ...opt, layers: DEPTH_LAYERS[guess] })
      if (r.hits.length) {
        const out = { ...r, depth: guess, stages: DEPTH_LAYERS[guess].map(layerName) }
        return withAdvice(out, guess, cfg)
      }
      const fb = await searchOnce(q, { ...opt, layers: [LAYER.DL_HOT] })
      return withAdvice({ ...fb, depth: guess, stages: [...DEPTH_LAYERS[guess].map(layerName), 'DL1'] }, 'full', cfg)
    }

    // 显式档位：只查这一档，不自动下探——下不下探由会话模型决定。
    // 名字兼容：brief = summary。
    const mode = depth === 'brief' ? 'summary' : depth
    const layers = DEPTH_LAYERS[mode]
    if (!layers) {
      const fb = await searchOnce(q, { ...opt, layers: [LAYER.DL_HOT] })
      return withAdvice({ ...fb, depth: 'full', stages: ['DL1'] }, 'full', cfg)
    }

    const r = await searchOnce(q, { ...opt, layers })
    return withAdvice({ ...r, depth: mode, stages: layers.map(layerName) }, mode, cfg)
  }

  /** 层名（DL1/DL2/DL3），日志里看得懂 */
  function layerName(l) {
    return l === LAYER.DL_HOT ? 'DL1' : l === LAYER.DL_LONG_RAW ? 'DL2' : l === LAYER.DL_LONG ? 'DL3' : String(l)
  }

  /**
   * 给结果挂上"下一步怎么办"的建议。
   *
   * ★ 这是整套设计的要害：模型拿到的不只是一堆条目，还有
   *   "这些够不够、不够该往哪走"。它不用懂分层，照着建议调就行。
   */
  function withAdvice(r, mode, c) {
    const top = r.hits.reduce((m, h) => Math.max(m, h.rel ?? 0), 0)
    const next = mode === 'summary' ? 'detail' : mode === 'detail' ? 'full' : null

    // 精排没跑成 → 结果没按相关性筛过，必须告诉模型别当成"都很相关"
    if (r.hits.length && r.reranked === false) {
      return {
        ...r,
        confidence: null,
        advice: '检索降级了（精排没跑，可能是预算或网络问题）：这里没按相关性过滤，' +
          '条目的先后顺序不代表相关程度，用之前务必自己判断。',
      }
    }

    let advice
    if (!r.hits.length) {
      advice = next
        ? `这一层没搜到。如果确实该有，换 depth="${next}" 再搜一次；如果本来就没记过，直接说没找到。`
        : '三层都搜过了，确实没有。可以说没记到。'
    } else if (top >= 0.5) {
      advice = '相关度较高，可以直接用。'
    } else if (top >= c.minRerankStrong) {
      advice = '相关度中等。用之前自己核一下是不是真的在说这件事。'
    } else {
      advice = next
        ? `相关度偏低（最高 ${top.toFixed(3)}），可能只是字面擦边。如果跟当前话题没关系，换 depth="${next}" 再搜一次。`
        : '相关度偏低，三层都搜过了。看着不相关就别硬用。'
    }

    return { ...r, confidence: Number(top.toFixed(3)), advice }
  }

  /**
   * 会话模型确认"这几条真的相关"，才给它们记一次关注
   *
   * ★ 为什么不能搜到就记：模型调工具搜到的可能是错误结果，
   *   拿到后自己判断出跟当前话题无关——这种不该算。
   *   否则被误搜到的记忆反而越来越热，越搜越靠前，形成回音室。
   *
   * ★ 和 fusionCount 的区别：
   *   fusionCount 记「这句话被反复说、被合并掉几次」——内容的重复度，融合时 +1
   *   recallCount 记「被确认相关后用过几次」——内容的关注度，这里 +1
   *
   * @param {string|string[]} ids
   * @return {number} 实际记了关注的条数
   */
  function attend(ids, now = tick()) {
    const list = Array.isArray(ids) ? ids : [ids]
    let n = 0
    for (const id of list) {
      const it = find(id)
      if (!it) continue
      // 别人的条目：热度/关注次数存在他的分片里，我们加的这一下重启就没了，
      // 反而让本次会话的排序和重启后不一致（同一条记忆两次查询排位不同）。
      if (it.__foreign) continue
      touchHeat(it, now, cfg)
      it.recallCount = (Number(it.recallCount) || 0) + 1
      n++

      // 被确认相关后，DL1 的该升回来：
      // 它是「被判无用沉下去的」，现在被证实有用，重新给观察机会。
      if (it.layer === LAYER.DL_HOT) {
        moveTo(it, LAYER.CONSOLIDATE, '被关注·重新观察', now)
      }
    }
    if (n) store.audit(`ATTEND ${n} 条确认相关（关注次数 +1）`)
    return n
  }

  async function searchOnce(query, { limit = 6, person = null, channel = null, dl2 = 'on', includeActive = false, useRerank = true, layers = null } = {}) {
    const q = String(query || '').trim()
    const now = tick()
    const win = parseTime(q, now)
    const kw = keywords(win ? q.replace(win.word, '') : q)
    const qVec = await embedOne(q)
    const noSem = !qVec      // 没连模型（或本条查询取向量失败）→ 纯关键词/热度打分

    const scored = []
    // ★ 只扫目标层（2026-10-31 修）。原来这里是 `for (const it of store.items)`
    //   全库遍历、然后用 layers 过滤——「只查 DL3 摘要层」跟「查全部」
    //   代价完全一样，分级设计的省力全被这一行吃掉了。
    //   现在按层取条目，扫多少取决于目标层有多大，不取决于库有多大。
    const pool = itemsInLayers(layers)
    for (const it of pool) {
      if (!includeActive && !isDeep(it.layer)) continue        // 活跃层不扫
      if (dl2 === 'skip' && it.layer === LAYER.DL_LONG_RAW) continue  // 按需跳过 DL2
      if (it.supersededBy && !q.includes('以前') && !q.includes('之前')) continue  // 作废条默认不出现
      if (channel && it.channel !== channel) continue
      if (person && !(it.people || []).includes(person) && it.speaker !== person) continue

      // 时间窗
      const from = it.spanFrom ?? it.createdAt
      const to = it.spanTo ?? it.createdAt
      const inWin = win ? (to >= win.from && from <= win.to) : true
      if (win && !inWin) continue

      // 关键词覆盖率
      // ★ 必须把 speaker/people 也拼进来：问"星鲸说过什么"时，
      //   "星鲸"只存在于 speaker 字段，正文里没有，只搜 text 会一条都命不中
      const body = [
        String(it.text || ''),
        it.speaker || '',
        ...(it.people || []),
        it.scene || '',
      ].join(' ').toLowerCase()
      let hit = 0
      for (const w of kw) if (body.includes(w)) hit++
      const kwScore = kw.size ? hit / kw.size : 0

      // 语义
      let sem = 0
      const v = store.vectors.get(it.id)
      if (qVec && v) sem = Math.max(0, cosine(qVec, v))

      // 一条都没命中、语义也不够 → 排除（否则全是噪音）
      //
      // ★ 但"有时间窗"的时候不能这么筛。
      //   「昨天发生了什么」这种问法，去掉时间词之后只剩"发生什么"，
      //   没有任何一条记忆会含这个词——按老规则整段时间的记忆全被排除，
      //   结果就是"昨天"搜出 0 条，明明那天的东西都在库里。
      //   时间窗本身就是强约束，这里只需要排掉语义上明显无关的。
      // 没有 embedding 时（qVec 为空）：时间窗查询不能被"零命中"筛掉。
      // 「昨天发生了什么」去掉时间词只剩"发生什么"，没有任何一条会含这个词，
      // 语义又用不上，老规则会把整段时间的记忆全排掉——明明东西都在库里。
      // 时间窗本身就是强约束，这时按热度/重要度排就够了。
      if (win) {
        if (!noSem && hit === 0 && sem < 0.2) continue
      } else if (kw.size && hit === 0 && sem < 0.45) {
        continue
      }

      const heat = heatOf(it, now, cfg)
      const score =
        0.42 * sem +
        0.22 * kwScore +
        0.12 * heat / 3 +
        0.10 * (Number(it.importance) || 0) +
        0.06 * (it.layer === LAYER.LONG ? 1 : it.layer === LAYER.CONSOLIDATE ? 0.6 : 0.3)

      scored.push({ it, score, sem, kwScore })
    }

    // ★ 相关性下限：不相关的一律不返回，别"总得给点什么"。
    //
    //   实测「完全不存在的话题」也能返回 6 条——因为没有下限，排前面的
    //   不管多不相关都会被返回。用户明确说过这个不能忍：
    //   「别要么实际上有却一个都搜不到，要么一搜搜出来一堆不相关的」。
    //
    // ★ 这里**没有**用余弦做闸门，因为实测余弦分不开。
    //
    //   拿 179 条真实记忆测过（Qwen3-Embedding-0.6B）：
    //     「完全不存在的话题」最高 0.573
    //     「今天天气怎么样」  最高 0.484
    //     「奶龙」            最高 0.690
    //   不相关的比相关的还高。这个模型的余弦被压在 0.35~0.7 的窄区间里，
    //   任何阈值都会同时切掉相关的、放过不相关的。相关性只能交给 reranker 判。
    const kept = scored
    kept.sort((a, b) => a.score - b.score)

    // ★ 精排 + 相关性闸门
    //
    // reranker 是交叉编码器，实测区分度差两个数量级：
    //   不相关 → 0.018 / 0.010 / 0.009
    //   相关   → 0.999 / 0.999 / 0.996
    // 所以用它的**原始分**当门槛（minRerank），低于的一律不返回。
    // 这就是"宁可返回 0 条，也不返回一堆不相关的"。
    //
    // 原来的写法只在"候选多于要取的条数"时才精排，结果不相关的查询
    // 照样返回满 limit 条——用户明确说过这个不能忍。
    let top = kept.slice(-limit).reverse()
    let reranked = false
    if (useRerank && typeof o.rerank === 'function' && kept.length) {
      const pool = kept.slice(-Math.min(kept.length, cfg.rerankPool)).reverse()
      bumpCall('rerank', pool.length)
      try {
        const rr = await o.rerank(q, pool.map((r) => String(r.it.text).slice(0, 300)))
        if (rr && rr.length) {
          reranked = true
          const raw = rr.map((x) => Number(x.score) || 0)
          const hi = Math.max(...raw)
          const lo = Math.min(...raw)
          const norm = (x) => (hi - lo < 1e-6 ? 0.5 : (x - lo) / (hi - lo))

          top = rr
            .filter((x) => Number(x.score) >= cfg.minRerank)   // ★ 相关性闸门
            .map((x) => {
              const base = pool[x.index]
              if (!base) return null
              const rn = norm(Number(x.score) || 0)
              // 混合而不是纯按 rerank：原分里有时间和热度，
              // 问「昨天」的时候时间权重不能丢。
              return {
                ...base,
                rrScore: rn,
                rerankRaw: Number(x.score),
                score: cfg.rerankWeight * rn + (1 - cfg.rerankWeight) * base.score,
              }
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
        }
      } catch (e) {
        // ★ 精排挂了不能无声无息。
        //   预算用完时 rerank 会抛 BudgetExceededError，结果就是
        //   "不过滤直接返回 6 条、conf 全是 0"——看起来像检索很烂，
        //   其实是降级了。这里必须留痕（实测 60 天跑就是这样，
        //   8 条查询全部 conf=0，差点被误判成检索质量崩了）。
        store.audit(`RERANK_FAIL ${e?.code === 'BUDGET_EXCEEDED' ? '预算用完' : (e?.message || '未知')} 「${String(q).slice(0, 20)}」`)
      }
    } else if (useRerank) {
      noteSkip('rerank', '未接精排模型·只能用粗排')
    }

    // ★ 不再"搜到就涨热度"（2026-10-31 用户校正）。
    //
    //   原来这里对 top 3 自动 touchHeat + recallCount++。
    //   但模型调工具搜到的可能是**错误结果**，拿到后自己判断出跟当前话题无关，
    //   这种不该算——否则被误搜到的记忆反而越来越热，越搜越靠前，形成回音室。
    //
    //   改成：检索纯只读。热度由 mem.attend(ids) 记，
    //   会话模型确认这几条真的相关时才调它。
    //   层的迁移也跟着走（DL1 → L2 的「重新观察」只在确认后发生）。

    // ★ 检索是只读的，不该在这里全量写盘（2026-10-31 修）。
    //
    //   原来这里有一句 store.save()，而 save() 会把**所有向量**重新
    //   base64 编码、连同所有条目一起写两个文件。
    //   2 万条实测这一步就吃掉 400ms，而分层扫描省下的只有 30ms——
    //   等于「只查摘要层」和「查全部」看起来没区别，分级白做。
    //
    //   改成：热度/层的变化攒着，由写入路径统一落盘
    //   （enforceLimits 末尾有 store.save()）。代价是进程崩溃时
    //   这几次检索的热度会丢——热度是派生数据，丢了不影响正确性。
    return {
      query: q,
      reranked,
      timeWindow: win ? { from: dayKey(win.from), to: dayKey(win.to) } : null,
      hits: top.map((r) => ({
        id: r.it.id,
        layer: r.it.layer,
        channel: r.it.channel,
        speaker: r.it.speaker,
        text: String(r.it.text).slice(0, 240),
        when: new Date(r.it.createdAt).toLocaleString('zh-CN'),
        score: Number(r.score.toFixed(3)),
        sem: Number(r.sem.toFixed(3)),
        // ★ 相关性原始分。给会话模型看的，让它自己判断这条跟当前话题搭不搭。
        //   不取整到 2 位小数——0.02 和 0.01 在判断上是一回事，但 0.18 和 0.02 不是。
        rel: r.rerankRaw === undefined ? null : Number(r.rerankRaw.toFixed(3)),
      })),
    }
  }

  // ============================================================
  // L3 视图（不落盘）
  //
  // DL3 是摘要池，L3 是"从池子里按分数截取出前 N 条"的视图。
  // 分数 = importance × 热度（用户定：相乘，重要的衰减慢一点）。
  //
  // 好处：老摘要热度掉了，分数自动掉下去，**不用搬数据**就退出上下文。
  //       不需要"L3 满了挤出去"这种逻辑，也就不会出现"冷掉的摘要赖着不走"。
  // ============================================================
  // L3 是「视图」不是「层」：每次都从 DL3 现算，条目本身没有副本。
  //
  // ★ 这个排序是全局唯一需要节流的地方（2026-11-01 改）。
  //   以前节流的是「整个记忆块」（L3+L2+L1 一起），那是错的：
  //   ① L1 每轮都有新数据写入，压着不刷新 = 模型看不到刚说的话；
  //   ② 快照是追加在末尾的，前面的历史缓存根本不受影响，没有可省的。
  //
  //   真正会打断缓存的只有 L3：它在注入块里排最前，L3 一变，
  //   后面 L2 / L1 的整段前缀全部失效。而 heat 随时间连续衰减，
  //   边界条目的分数此消彼长，入选集合时不时会变一条——必须压住。
  //
  //   所以：排序结果缓存 viewRefreshMs（默认 30 分钟），期间复用同一批入选条目。
  //   L1 / L2 不缓存，每轮现算。
  let l3Cache = null

  function l3View(now = tick(), opts = {}) {
    const refreshMs = Number(cfg.viewRefreshMs) || 0
    // 容量变了要立刻重算：否则把 longMaxChars 调大要等一个周期才见效
    const key = cfg.longMaxChars
    if (!opts.force && l3Cache && l3Cache.key === key && refreshMs > 0 && now - l3Cache.at < refreshMs) {
      return l3Cache.items
    }

    // all：全库。别人沉淀的摘要也该出现在 L3 里，这才是共享的意义
    const pool = byLayer(LAYER.DL_LONG, { all: true }).filter((it) => !it.supersededBy)

    const scored = pool.map((it) => ({
      it,
      score: (Number(it.importance) || 0) * heatOf(it, now, cfg),
    }))
    scored.sort((a, b) => b.score - a.score)

    const out = []
    let used = 0
    for (const { it } of scored) {
      const len = String(it.text || '').length
      if (used + len > cfg.longMaxChars) break
      out.push(it)
      used += len
    }
    l3Cache = { at: now, key, items: out }
    return out
  }

  // ============================================================
  // 注入
  // ============================================================
  /**
   * @param {number} budget 硬上限，**0 = 不限制**（默认）。
   *   不限制时注入多少完全由三层各自的容量决定：
   *   L3←longMaxChars、L2←consolidateMaxChars、L1←hotMaxChars。
   *   > 0 时才作为最后一道闸门截断（给不信任容量的调用方兜底）。
   * @param {{includeHot?: boolean}} [opts]
   * @param {{includeHot?: boolean}} [opts]
   *   includeHot 恒为 true：三层都注入，没有开关（2026-11-01 移除该开关）。
   *   要调的是各层容量，不是注不注入。参数留着只为兼容旧调用。
   */
  function buildBlock(budget = 0, opts = {}) {
    store.maybeRefreshForeign()      // 上下文里要带上别人刚记的东西
    const includeHot = opts.includeHot !== false
    // ★ L3 是视图：从 DL3 按 importance×热度 截取。
    //   截出来之后按 seq 升序排——新增加末尾，前面逐字节不变，前缀缓存能命中。
    const long = l3View().sort((a, b) => a.seq - b.seq)
    // ★ 共享目录里别人的条目也进上下文，但排在自己人后面：
    //   容量是我们按自己的条目维护的（enforceLimits 只动自己的），
    //   先到先得的话，对方写得越多，我们自己的条目被挤掉得越多。
    const ownFirst = (a, b) => (a.__foreign ? 1 : 0) - (b.__foreign ? 1 : 0)
    const cons = byLayer(LAYER.CONSOLIDATE, { all: true })
      .sort((a, b) => ownFirst(a, b) || (a.seq - b.seq))
    const hot = byLayer(LAYER.HOT, { all: true })
      .sort((a, b) => ownFirst(a, b) || (b.seq - a.seq))   // 最新的在前

    // 作废条不进上下文：新的那条已经在里面了，再放旧的只会让模型看到两条相反的指令。
    // 想查历史可以走 search（那里会改写成"（已作废）…"）。
    const visible = (list) => list.filter((it) => !it.supersededBy)

    const line = (it) => {
      const isSummary = it.kind === 'summary' || !!it.spanFrom
      const tag = isSummary && it.spanFrom
        ? `${dayKey(it.spanFrom).slice(5)}~${dayKey(it.spanTo || it.createdAt).slice(5)} `
        : `${dayKey(it.createdAt).slice(5)} `
      const who = it.speaker ? `[${it.speaker}] ` : (isSummary ? '[摘要] ' : '')
      const mark = it.supersededBy ? '（已作废）' : ''
      return `- ${mark}${tag}${who}${String(it.text).replace(/\s+/g, ' ').trim()}`
    }

    const pack = (list, limit) => {
      const out = []
      let used = 0
      for (const it of list) {
        const l = line(it)
        if (used + l.length > limit) {
          // ★ 单条超预算要截断，不能 break 丢掉整段
          if (!out.length) {
            const cut = l.slice(0, Math.max(20, limit - 1))
            out.push(cut + '…')
            used += cut.length
          }
          break
        }
        out.push(l)
        used += l.length + 1
      }
      return out
    }

    const longLines = pack(visible(long), Infinity)

    // ★ 三层的「进多少」只由各层自己的容量决定，不再分「剩余预算」：
    //     L3 ← longMaxChars（l3View 已经按它截过条）
    //     L2 ← consolidateMaxChars（L2 满就溢出沉淀，所以它是硬上限）
    //     L1 ← hotMaxChars（同理）
    //   以前是 bootMaxChars 当总闸门、L3 吃光后 L2 只剩零头（实测 351 字只进 55 字），
    //   结果「刚沉淀的对话」优先级反而低于「一周前的群聊」——不合理。
    // ★ 单写者时下面等价于直接 pack(..., Infinity)：容量本来就是硬上限，
    //   多写者时才生效——别人的条目只能"借"剩下的空间，
    //   自己那份已经占满时仍留 30% 给共享方（不然对方一条都进不来，共享就没意义了）。
    const packShared = (list, limit) => {
      const mine = pack(list.filter((it) => !it.__foreign), Infinity)
      const used = mine.reduce((s, l) => s + l.length + 1, 0)
      return mine.concat(pack(list.filter((it) => it.__foreign), Math.max(Math.round(limit * 0.3), limit - used)))
    }

    const hotLines = includeHot ? packShared(visible(hot), cfg.hotMaxChars) : []
    const consLines = packShared(visible(cons), cfg.consolidateMaxChars)

    const parts = []
    if (longLines.length) parts.push('## 一直记得的', ...longLines)
    if (consLines.length) parts.push('## 最近沉淀的', ...consLines)
    if (hotLines.length) parts.push('## 刚发生的', ...hotLines)
    const out = parts.join('\n')
    // budget <= 0（默认）不限制：多少由三层容量自己说了算
    if (budget > 0 && out.length > budget) return out.slice(0, budget)
    return out
  }

  // ============================================================
  // 观测 / 维护
  // ============================================================
  function stats() {
    store.maybeRefreshForeign()
    const count = {}
    const charsBy = {}
    for (const l of Object.values(LAYER)) {
      // L3 是视图，按"当前能进上下文的条数"算，不是 DL3 的存储量
      const list = l === LAYER.LONG ? l3View(tick()) : byLayer(l, { all: true })
      count[l] = list.length
      charsBy[l] = chars(list)
    }
    const byChannel = { dialog: 0, action: 0, event: 0, note: 0 }
    for (const it of store.items) byChannel[it.channel] = (byChannel[it.channel] || 0) + 1
    return { count, chars: charsBy, byChannel, total: store.items.length, vectors: store.vectors.size, calls, gates }
  }

  function graveyard({ limit = 50 } = {}) {
    try {
      const f = join(dir, 'graveyard', 'forgotten.jsonl')
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
        .slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }
  }

  /** 清空调用统计（分段计时用） */
  function resetCalls() {
    Object.assign(calls, emptyCalls())
    const g = emptyGates()
    for (const k of Object.keys(g)) gates[k] = g[k]
  }

  function pin(id, v = true) {
    const it = find(id)
    if (!it) return { ok: false, error: '找不到' }
    it.pinned = v
    store.save()
    return { ok: true, id, pinned: v }
  }

  function forgetById(id) {
    const it = find(id)
    if (!it) return { ok: false, error: '找不到' }
    const ok = forget(it, '手动删除', tick())
    store.save()
    return { ok, id }
  }

  function list(layer = null) {
    if (layer === LAYER.LONG) return l3View(tick())   // L3 是视图
    return (layer ? byLayer(layer, { all: true }) : store.items).slice()
  }

  /** 手动快进时间（测试用） */
  function fastForward(ms, { sweep = true } = {}) {
    const target = tick() + ms
    // 直接推 lastMentionedAt 不行——那会改变语义。这里只用于模拟"很久没动"
    if (sweep) enforceLimits(target)
    return target
  }

  return {
    // 写
    write,
    writeMany,
    // 查
    search,
    attend,                 // 会话模型确认相关后记关注（不是搜到就算）
    buildBlock,
    list,
    // 维护
    sweep: enforceLimits,
    compressDL2,                // 手动压缩入口（force:true 忽略容量）
    graveyard,
    pin,
    forget: forgetById,
    // 观测
    stats,
    resetCalls,
    retentionOf,
    heatOf: (it, now) => heatOf(it, now ?? tick(), cfg),
    halfLifeOf: (it) => halfLifeOf(it, cfg),
    // 运维 / 测试
    flushSummaries,
    pendingSummaries,
    dumpVectors: (p) => store.dumpVectors(p),    // 合并导出向量快照（调试/分析用）
    /** 底层 store：测试和多写者调试用 */
    _store: store,
    fuse: consolidateFusion,                    // 手动跑一次全量融合
    fuseDL3: fuseIntoDL3,                       // 摘要入 DL3 时的融合（判重的新位置）
    _seed: (item, vec) => {                                     // 直接注入（测试用）
      store.items.push(item)
      invalidateLayerIndex()
      if (vec) store.vectors.set(item.id, Float32Array.from(vec))
      return item
    },

    // 常量
    LAYER,
    cfg,
    dir,
    fastForward,
  }
}

// ============================================================
// 自测：验证 heat 与 tune.mjs 的结论一致
// ============================================================

function selfTest() {
  const cfg = DEFAULTS
  const results = []
  let failed = 0

  // 用真实时间戳做起点。用 0 会踩到"0 是 falsy"的坑，
  // 那虽然是测试构造问题，但也会掩盖 ?? 与 || 的区别。
  const BASE = Date.UTC(2026, 0, 1, 4, 0, 0)   // 本地 12:00，避免跨日抖动
  const at = (d) => BASE + d * DAY

  const check = (name, actual, expect, tol = 0.02) => {
    const ok = Math.abs(actual - expect) <= tol
    if (!ok) failed++
    results.push({ name, actual, expect, ok })
  }

  const simulate = (touches, importance, observeDay) => {
    const it = makeItem({ text: 'x', importance, at: BASE })
    for (const t of touches) touchHeat(it, at(t), cfg)
    return heatOf(it, at(observeDay), cfg)
  }

  // 1. 爆发 20 次（全在第 0 天，按天去重后只算 1 次）
  check('爆发20次 → 30天后', simulate(Array(20).fill(0), 0.6, 30), 0.20)

  // 2. 只提一次
  check('只提一次 → 30天后', simulate([0], 0.6, 30), 0.20)

  // 3. 写完 7 天没提（巩固层典型）
  check('写完7天没提', simulate([0], 0.6, 7), 0.69)

  // 4. 每 6 天一次（持续）
  check('每6天一次 → 30天后', simulate([0, 6, 12, 18, 24], 0.6, 30), 1.47)

  // 5. 稀疏但持续（每 10 天一次）
  check('每10天一次 → 30天后', simulate([0, 10, 20], 0.6, 30), 1.08)

  // 6. 同一天多次提及不应累加
  const a = makeItem({ text: 'x', importance: 0.6, at: at(0) })
  touchHeat(a, at(0) + 1000, cfg)
  const h1 = a.heat
  touchHeat(a, at(0) + 5000, cfg)     // 同一天，不同时刻
  const h2 = a.heat
  results.push({
    name: '同一天再提不累加',
    actual: h2,
    expect: h1,
    ok: Math.abs(h2 - h1) < 1e-9,
  })
  if (Math.abs(h2 - h1) >= 1e-9) failed++

  // 7. canPromote 判定
  const steady = simulate([0, 6, 12, 18, 24], 0.6, 30)
  results.push({
    name: '持续型够格晋升',
    actual: steady,
    expect: cfg.heatPromoteThreshold,
    ok: steady >= cfg.heatPromoteThreshold,
  })
  if (steady < cfg.heatPromoteThreshold) failed++

  // 8. 淘汰按热度：凉了的先沉，哪怕它 importance 更高
  const coldHighImp = makeItem({ text: 'cold-high-imp', importance: 0.95, layer: LAYER.LONG, at: at(0) })
  const hotLowImp = makeItem({ text: 'hot-low-imp', importance: 0.6, layer: LAYER.LONG, at: at(29) })
  hotLowImp.heat = 2.0
  const s1 = pickDemoteVictims([hotLowImp, coldHighImp], at(30), cfg)
  results.push({
    name: '按热度淘汰(0.95凉了先沉)',
    actual: s1[0].text,
    expect: 'cold-high-imp',
    ok: s1[0].text === 'cold-high-imp',
  })
  if (s1[0].text !== 'cold-high-imp') failed++

  // 9. 热度相同才比时间：老的先沉
  const older = makeItem({ text: 'older', importance: 0.85, layer: LAYER.LONG, at: at(0) })
  const newer = makeItem({ text: 'newer', importance: 0.85, layer: LAYER.LONG, at: at(5) })
  const s2 = pickDemoteVictims([newer, older], at(5), cfg)
  results.push({
    name: '同热度按时间(老的先沉)',
    actual: s2[0].text,
    expect: 'older',
    ok: s2[0].text === 'older',
  })
  if (s2[0].text !== 'older') failed++

  // 10. 钉住的永远排最后
  const pinnedOne = makeItem({ text: 'pinned', importance: 0.85, layer: LAYER.LONG, at: at(0) })
  pinnedOne.pinned = true
  const normalOne = makeItem({ text: 'normal', importance: 0.85, layer: LAYER.LONG, at: at(5) })
  const s3 = pickDemoteVictims([pinnedOne, normalOne], at(6), cfg)
  results.push({
    name: '钉住的排最后不先沉',
    actual: s3[0].text,
    expect: 'normal',
    ok: s3[0].text === 'normal',
  })
  if (s3[0].text !== 'normal') failed++

  // 11. 没满就不淘汰：哪怕热度已经降到接近 0
  const coldButRoom = makeItem({ text: 'x'.repeat(50), importance: 0.85, layer: LAYER.LONG, at: at(0) })
  const roomy = pickOverflowVictims([coldButRoom], 1000, at(365), cfg)
  results.push({
    name: '没满就留着(热度凉也不走)',
    actual: roomy.length,
    expect: 0,
    ok: roomy.length === 0,
  })
  if (roomy.length !== 0) failed++

  // 12. 满了才挤：3 条各 100 字，容量 150 → 挤掉 2 条
  const a1 = makeItem({ text: 'a'.repeat(100), importance: 0.85, layer: LAYER.LONG, at: at(0) })
  const a2 = makeItem({ text: 'b'.repeat(100), importance: 0.85, layer: LAYER.LONG, at: at(1) })
  const a3 = makeItem({ text: 'c'.repeat(100), importance: 0.85, layer: LAYER.LONG, at: at(2) })
  const over = pickOverflowVictims([a1, a2, a3], 150, at(30), cfg)
  results.push({
    name: '满了才挤(超150字挤2条)',
    actual: over.length,
    expect: 2,
    ok: over.length === 2,
  })
  if (over.length !== 2) failed++

  // 13. 钉住的挤不动
  const pinnedKeep = makeItem({ text: 'p'.repeat(100), importance: 0.85, layer: LAYER.LONG, at: at(0) })
  pinnedKeep.pinned = true
  const freeOne = makeItem({ text: 'f'.repeat(100), importance: 0.85, layer: LAYER.LONG, at: at(1) })
  const over2 = pickOverflowVictims([pinnedKeep, freeOne], 100, at(30), cfg)
  results.push({
    name: '钉住的挤不动',
    actual: over2.every((x) => !x.pinned) ? over2.length : -1,
    expect: 1,
    ok: over2.length === 1 && over2[0].text.startsWith('f'),
  })
  if (!(over2.length === 1 && over2[0].text.startsWith('f'))) failed++

  // 13b. 重复效应：活跃天数多的，衰减更慢（艾宾浩斯）
  const activeA = makeItem({ text: 'A', importance: 0.6, at: at(1) })
  for (const d of [5, 9, 30]) touchHeat(activeA, at(d), cfg)
  const suddenB = makeItem({ text: 'B', importance: 0.6, at: at(0) })
  touchHeat(suddenB, at(30), cfg)
  const a60 = heatOf(activeA, at(60), cfg)
  const b60 = heatOf(suddenB, at(60), cfg)
  results.push({
    name: '重复效应(A活跃4天>B2天)',
    actual: a60 > b60 ? 1 : 0,
    expect: 1,
    ok: a60 > b60,
  })
  if (!(a60 > b60)) failed++
  results.push({
    name: '  A半衰期更长',
    actual: halfLifeOf(activeA, cfg),
    expect: halfLifeOf(suddenB, cfg),
    ok: halfLifeOf(activeA, cfg) > halfLifeOf(suddenB, cfg),
  })
  if (!(halfLifeOf(activeA, cfg) > halfLifeOf(suddenB, cfg))) failed++

  // 13c. 间隔效应：同样两次提及，隔 14 天必须强于隔 1 天
  const dense = makeItem({ text: 'dense', importance: 0.6, at: at(0) })
  touchHeat(dense, at(1), cfg)          // 隔 1 天
  const spread = makeItem({ text: 'spread', importance: 0.6, at: at(0) })
  touchHeat(spread, at(14), cfg)        // 隔 14 天
  // 观察点必须"距最后一次提及同样 15 天"，否则比的是窗口偏移
  const d30 = heatOf(dense, at(16), cfg)
  const s30 = heatOf(spread, at(29), cfg)
  results.push({
    name: '间隔效应(疏>密)',
    actual: s30 / Math.max(d30, 0.01),
    expect: 1.33,
    ok: s30 > d30 * 1.2,     // 至少 20% 差异，低于这个就算间隔效应失效
  })
  if (!(s30 > d30 * 1.2)) failed++

  // 14. importance 不影响衰减：两条只差 importance，热度应完全相同
  const impLow = makeItem({ text: 'a', importance: 0.2, at: at(0) })
  const impHigh = makeItem({ text: 'b', importance: 0.95, at: at(0) })
  const hLow = heatOf(impLow, at(10), cfg)
  const hHigh = heatOf(impHigh, at(10), cfg)
  results.push({
    name: 'importance不参与衰减',
    actual: Math.abs(hLow - hHigh),
    expect: 0,
    ok: Math.abs(hLow - hHigh) < 1e-9,
  })
  if (Math.abs(hLow - hHigh) >= 1e-9) failed++

  // —— 输出 ——
  const pad = (s, n) => String(s).padEnd(n)
  console.log('\n' + '='.repeat(66))
  console.log('  memory5 骨架自测')
  console.log('='.repeat(66))
  console.log('  ' + pad('用例', 30) + pad('实际', 10) + pad('期望', 10) + '结果')
  console.log('  ' + '-'.repeat(62))
  for (const r of results) {
    const act = typeof r.actual === 'number' ? r.actual.toFixed(2) : String(r.actual)
    const exp = typeof r.expect === 'number' ? r.expect.toFixed(2) : String(r.expect)
    console.log('  ' + pad(r.name, 28) + pad(act, 10) + pad(exp, 10) + (r.ok ? '✓' : '✗'))
  }
  console.log('  ' + '-'.repeat(62))
  console.log(`  ${results.length - failed} / ${results.length} 通过` + (failed ? `，${failed} 项失败` : ''))
  console.log('='.repeat(66) + '\n')

  return failed === 0
}

// 只在直接运行时执行自测
if (process.argv[1] && process.argv[1].endsWith('memory5.mjs')) {
  const ok = selfTest()
  process.exit(ok ? 0 : 1)
}
