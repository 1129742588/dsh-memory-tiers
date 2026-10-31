/**
 * memory5 真实场景模拟 —— `node simulate-m5.mjs`
 *
 * 接真实模型跑六层架构的完整生命周期，验证语义质量（测试套件用的是假向量，验不了这个）。
 *
 *   node simulate-m5.mjs          接模型（需要 AstrBot 配置里的 key）
 *   node simulate-m5.mjs --local  不联网，用本地规则跑同一批数据做对照
 *
 * 场景：30 天，真实群成员和真实事件（发表情包、戳一戳、种花、对骂、刷抖音），
 * 加上项目线的真实进展（分割、标注、医院数据、投稿）。
 *
 * 重点验证：
 *   ① 分类质量：模型判 importance/channel 准不准
 *   ② 分流正确性：特重要 → DL2 原文 + 摘要；中等 → L2；不重要 → DL1
 *   ③ 摘要质量：带不带人名、span 对不对、有没有自相矛盾
 *   ④ 矛盾处理：命令改了之后，旧的有没有标作废、摘要里有没有混进去
 *   ⑤ 检索：时间词、人名、类别、深层翻旧账
 *   ⑥ 成本：调了多少次、花了多少时间
 */

import { rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMemory5, LAYER, DAY, dayKey } from './memory5.mjs'
import { createSilicon, keyFromAstrbot } from './silicon.mjs'

const LOCAL = process.argv.includes('--local')
const DIR = LOCAL ? '.sim5-local' : '.sim5'
const ASTRBOT_CFG = 'C:/Users/Anxiple/.astrbot_launcher/instances/56f66ac7-8570-41f3-82f3-91adacb6a65a/core/data/cmd_config.json'

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

// ──────────────────────────────────────────────────────────────
// 时钟 & 输出
// ──────────────────────────────────────────────────────────────
let clock = new Date('2026-10-24T09:00:00+08:00').getTime()
const lines = []
const log = (x = '') => { console.log(x); lines.push(x) }
const head = (t) => log(`\n${'─'.repeat(70)}\n${t}`)

// 场景常量
const G = 'group:966657516'
const P = 'private:1129742588'
const DY = 'douyin'

// ──────────────────────────────────────────────────────────────
// 接模型
// ──────────────────────────────────────────────────────────────
let api = null
if (!LOCAL) {
  const cred = keyFromAstrbot(ASTRBOT_CFG)
  if (!cred) {
    console.log('\n没找到模型 key，改用 --local 模式重跑。\n')
    process.exit(1)
  }
  api = createSilicon(cred)
}

const mem = createMemory5({
  dir: DIR,
  now: () => clock,
  embed: api ? (t) => api.embed(t) : undefined,
  classify: api ? (t) => api.classify(t) : undefined,
  classifyBatch: api ? (t) => api.classifyBatch(t) : undefined,
  judgeRelation: api ? (a, b) => api.relation(a, b) : undefined,
  rerank: api ? (q, docs, n) => api.rerank(q, docs, n) : undefined,
  summarize: api
    ? async (texts, channel, people) => {
        const focus = {
          dialog: '重点：谁说了什么、定了什么、聊到哪了。每句必须有主语（人名）。',
          action: '重点：做了什么、结果如何、数字变化。',
          event: '重点：发生了什么。细节可以模糊，但"发生过什么"的骨架必须留住。',
        }[channel] || '重点：发生了什么、得出什么结论。'
        const out = await api.summarize(texts, focus, channel)
        return out
      }
    : undefined,
  compress: api
    ? async (text) => {
        // DL2 压缩：只压缩字数，不改写事实
        const r = await api.summarize([text], '只压缩字数，保留全部事实和数字，不要归纳、不要改写措辞', 'dialog')
        return r
      }
    : undefined,
  cfg: {
    hotMaxChars: 320,          // 压小，逼出分流
    hotMaxItems: 200,
    consolidateMaxChars: 2000, // 按时间到期，不按容量
    consolidateDays: 7,
    longMaxChars: 900,
    dl2MaxChars: 3000,
    dl2CompressTarget: 300,
    fusionEveryNWrites: 25,
    // ★ 摘要在后台跑：写入不等模型压完
    summarizeMode: 'deferred',
  },
})

// ──────────────────────────────────────────────────────────────
// 场景：30 天
//
// 每条 [天偏移, 文本, 说话人, 场景]
// 不指定 channel 和 importance —— 全部交给模型判，这正是要验证的东西
// ──────────────────────────────────────────────────────────────
const SCRIPT = [
  // 第 1 天
  [0, '先把手头那个分割跑通，分类的事下周再说', '主人', P],
  [0, '把脚本的预处理改成按 1.5mm 重采样，跑通了，Dice 从 0.86 涨到 0.88', '我', P],
  [0, '今天被导师催了三次，头都要炸了', '星鲸', G],
  [0, '刷到一个讲肺结节早筛的视频，说得挺在理', '我', DY],

  // 第 2 天
  [1, '以后评估一律以召回率为准，别老看准确率', '主人', P],
  [1, '清了一轮空标注，删掉 37 个坏样本', '我', P],
  [1, '发了个表情包，被我吐槽像年糕', '艾小', G],
  [1, '在抖音评论区跟人吵了一架，吵的啥记不清了', '我', DY],

  // 第 3 天
  [2, '周末去不去爬山，看天气吧', '星鲸', G],
  [2, '你这号是不是买的', '看不清摸不着', G],
  [2, '你猜', 'Ugly', G],
  [2, '漏诊比误报严重得多，宁可多报几个', '主人', P],
  [2, '给验证集补了一份人工标注，一共 64 例', '我', P],

  // 第 4 天
  [3, '服务器扩容到四张卡，训练时间从 9 小时压到 3 小时', '我', P],
  [3, '手快点成错误表情了', '封魔', G],
  [3, '快把植二下回来', '糖果入平静', G],
  [3, '下个月能拿到 200 例带病理的 CT', '主人', P],
  [3, '群里两个人对骂，骂到最后互删了', '我', G],

  // 第 5 天
  [4, '论文投稿目标定 MICCAI，先看消融结果', '主人', P],
  [4, '消融实验跑完了，加连通域过滤那组 Dice 掉了 0.01 但假阳性降了四成', '我', P],
  [4, '今天食堂的菜太咸了', '艾小', G],
  [4, '刷到个视频讲怎么用 nnUNet 做多模态，讲得挺清楚', '我', DY],

  // 第 6 天
  [5, '数据脱敏流程必须过一遍法务，这个不能省', '主人', P],
  [5, '把标注平台的批量导入做完了，一天能处理八百例', '我', P],
  [5, '地铁上有人外放音乐，很吵', '艾小', G],
  [5, '看到有人在群里发广告，被管理员踢了', '我', G],

  // 第 7 天
  [6, '周末爬山去了，累死了但风景不错', '星鲸', G],
  [6, '新买的耳机左声道有杂音，退了', '艾小', G],
  [6, '训练脚本改完，八卡能起了', '我', P],
  [6, '看完那篇肺结节综述，说假阴性率是关键指标', '我', DY],

  // 第 8 天
  [7, '以后报告统一用 markdown 输出，别再发截图了', '主人', P],
  [7, '所有报告统一用 markdown 输出', '主人', P],   // 重复，应合并
  [7, '推理服务部署到四台机器，QPS 过了 50', '我', P],
  [7, '楼下那只橘猫又蹲在门口', '艾小', G],

  // 第 9 天
  [8, '数据集规模扩到 800 例，月底前完成', '我', P],
  [8, '快递被放错了柜子，跑了两趟才拿到', '封魔', G],
  [8, '公司楼下的咖啡涨价了，一杯快三十', 'Ugly', G],
  [8, '刷到个做菜视频，想试试红烧肉', '我', DY],

  // 第 10 天
  [9, '每周五同步一次进度给导师', '主人', P],
  [9, '后处理又调了一版，假阳性再降一成', '我', P],
  [9, '手机屏幕摔裂了一道缝', '星鲸', G],
  [9, '在评论区看到有人吹某家公司的结节产品，明显是广告', '我', DY],

  // 第 11 天
  [10, '群里不要发表情包了', '主人', G],
  [10, '测试集单独留 150 例不参与训练', '主人', P],
  [10, '把验证集的预测结果重新生成了一遍', '我', P],
  [10, '天气突然降温，得加衣服', '艾小', G],

  // 第 12 天
  [11, '假阴性率必须压到 5% 以下，宁可多报', '主人', P],
  [11, '模型版本要能回滚，保留最近三版', '主人', P],
  [11, '同事说他跳槽了，去了大厂', '星鲸', G],
  [11, '空调遥控器找不到了', 'Ugly', G],

  // 第 13 天
  [12, '标注质量抽查比例不低于 10%', '主人', P],
  [12, '补完了 128 例标注，抽查了 15 例，两例有问题已退回', '我', P],
  [12, '楼下装修吵得没法午睡', '艾小', G],
  [12, '看到一个讲微波消融治疗结节的直播', '我', DY],

  // 第 14 天
  [13, '数据集里 12 例左右肺标反了，要重标', '我', P],
  [13, '周末又去爬山了，这次带了相机', '星鲸', G],
  [13, '打印机又卡纸，修了半天', '封魔', G],
  [13, '刷到个旅行 vlog，拍的是西藏', '我', DY],

  // 第 15 天
  [14, '群里要发表情包', '主人', G],   // 跟第 11 天的命令矛盾
  [14, '推理延迟要压到 200ms 以内', '主人', P],
  [14, '推理服务做了一版优化，延迟从 340ms 降到 210ms', '我', P],
  [14, '小区门口的超市在打折', '艾小', G],

  // 第 16 天
  [15, '所有实验记录写进同一个表格，别散在各处', '主人', P],
  [15, '把最近两周的实验都整理进表格了，一共 37 组', '我', P],
  [15, '小区物业在修水管，停水一天', '封魔', G],
  [15, '看到群里在聊显卡，说 4090 又涨价了', '我', G],

  // 第 17 天
  [16, '和附属医院又谈了一次，能提前到下月中给第一批', '主人', P],
  [16, '消融第二组跑完，去掉后处理那组假阳性翻倍', '我', P],
  [16, '昨天熬夜看球，今天很困', '星鲸', G],
  [16, '刷到个讲医疗 AI 监管的视频，说审批越来越严', '我', DY],

  // 第 18 天
  [17, 'Dice 计算口径改成按切片统计', '主人', P],
  [17, '按新口径重算了一遍，从 0.88 变成 0.85', '我', P],
  [17, '隔壁组在裁员，气氛有点紧', 'Ugly', G],
  [17, '同事请客吃饭，吃了顿火锅', '艾小', G],

  // 第 19 天
  [18, '训练改成八卡并行，一次能跑三个实验', '我', P],
  [18, '周末想去逛展，有人一起吗', '艾小', G],
  [18, '我要加班，不去了', '星鲸', G],
  [18, '看到有人晒自己在健身房练了半年，变化挺大', '我', DY],

  // 第 20 天
  [19, '分割模型确定用 nnUNet，不再试别的了', '主人', P],
  [19, '把 nnUNet 的配置整理成文档了', '我', P],
  [19, '手机没电了，借了个充电宝', '封魔', G],
  [19, '刷到个讲怎么写论文 introduction 的帖子', '我', DY],

  // 第 21 天
  [20, '论文初稿写完前三节', '我', P],
  [20, '食堂换了个厨师，菜好吃了点', '艾小', G],
  [20, '小区里在装新的门禁', 'Ugly', G],
  [20, '看到一条新闻说某医院用 AI 筛查肺癌，准确率九成', '我', DY],

  // 第 22 天
  [21, '所有实验必须记录随机种子，不然复现不了', '主人', P],
  [21, '给所有训练脚本加了 seed 参数', '我', P],
  [21, '快递又送错了，这次送到了隔壁楼', '封魔', G],
  [21, '天气转晴了，适合出门', '星鲸', G],

  // 第 23 天
  [22, '消融表整理好了，一共五组对比', '我', P],
  [22, '楼下开了家新的奶茶店', '艾小', G],
  [22, '刷到个讲肺结节随访周期的视频，说要按大小分级', '我', DY],
  [22, '电脑风扇声音特别大，得清灰了', '星鲸', G],

  // 第 24 天
  [23, '论文初稿全部写完，等导师看', '我', P],
  [23, '导师说下周给反馈', '主人', P],
  [23, '地铁又晚点了，等了二十分钟', '艾小', G],
  [23, '看到有人在群里问有没有推荐的显卡', '我', G],

  // 第 25 天
  [24, '把 DL2 的压缩逻辑也整理进文档', '我', P],
  [24, '周末继续爬山，这次去了另一条路线', '星鲸', G],
  [24, '新买的键盘手感不错', 'Ugly', G],
  [24, '刷到个视频讲模型部署的成本优化', '我', DY],

  // 第 26 天
  [25, '导师反馈回来了，说方法部分要再详细点', '主人', P],
  [25, '按导师意见改了方法部分，加了算法伪代码', '我', P],
  [25, '小区的快递柜换了个位置', '封魔', G],
  [25, '看到群里在讨论要不要换群头像', '我', G],

  // 第 27 天
  [26, '召回率在测试集上是 0.94，假阴性率 4.8%', '我', P],
  [26, '这个数可以，达到要求了', '主人', P],
  [26, '楼下超市的鸡蛋涨价了', '艾小', G],
  [26, '刷到个讲医学影像标注规范的视频', '我', DY],

  // 第 28 天
  [27, '论文投出去了，等审稿', '我', P],
  [27, '投完就轻松了，先歇两天', '主人', P],
  [27, '周末去唱K，有人来吗', '艾小', G],
  [27, '看到有人在群里发自拍，被起哄', '我', G],

  // 第 29 天
  [28, '把项目的所有文档整理了一遍', '我', P],
  [28, '新来的实习生啥都不会，得手把手教', '星鲸', G],
  [28, '空调终于修好了', 'Ugly', G],
  [28, '刷到个讲怎么准备答辩的视频', '我', DY],

  // 第 30 天
  [29, '答辩定在下个月中，要准备 PPT', '主人', P],
  [29, '开始做答辩 PPT，先把框架列出来', '我', P],
  [29, '食堂今天的汤不错', '艾小', G],
  [29, '看到群里在组织团建，说去郊区', '我', G],
]

// ──────────────────────────────────────────────────────────────
// 按天分组，一天一批 writeMany
// ──────────────────────────────────────────────────────────────
head(`写入 ${SCRIPT.length} 条（${LOCAL ? '本地规则' : '真实模型'}）`)

const byDay = new Map()
for (const [d, text, who, scene] of SCRIPT) {
  if (!byDay.has(d)) byDay.set(d, [])
  byDay.get(d).push({ text, speaker: who, scene })
}

const timeline = []
let totalMs = 0
let totalSumMs = 0

for (const d of [...byDay.keys()].sort((a, b) => a - b)) {
  const list = byDay.get(d)
  clock = new Date('2026-10-24T09:00:00+08:00').getTime() + d * DAY + 10 * 3600e3

  // ① 写入（应该很快：只有分类 + 向量，不碰大模型）
  const t0 = Date.now()
  await mem.writeMany(list)
  const ms = Date.now() - t0
  totalMs += ms

  // ② 摘要（后台，慢也无所谓）
  const pending = mem.pendingSummaries()
  const t1 = Date.now()
  await mem.flushSummaries()
  const msSum = Date.now() - t1
  totalSumMs += msSum

  const s = mem.stats()
  timeline.push({ day: d, add: list.length, ms, msSum, ...s.count, chars: { ...s.chars } })
  log(
    `  ${dayKey(clock).slice(5)}  +${list.length} 条 ` +
    `写入 ${String(ms).padStart(4)}ms` +
    (msSum ? ` 摘要 ${String(msSum).padStart(5)}ms(${pending}条)` : '            ') +
    `  L1=${s.count.L1} L2=${s.count.L2} L3=${s.count.L3} ` +
    `DL1=${s.count.DL1} DL2=${s.count.DL2} DL3=${s.count.DL3}  (${s.total} 条)`
  )
}

const sEnd = mem.stats()
head('最终分布')
log(`  ${JSON.stringify(sEnd.count)}`)
log(`  通道：${JSON.stringify(sEnd.byChannel)}`)
log(`  字数：${JSON.stringify(sEnd.chars)}`)
log(`  总条数 ${sEnd.total}，向量 ${sEnd.vectors}`)

// ──────────────────────────────────────────────────────────────
// 调用统计
// ──────────────────────────────────────────────────────────────
head('调用统计')
log('  ' + '能力'.padEnd(12) + '请求'.padEnd(8) + '波次'.padEnd(8) + '条目')
for (const [k, v] of Object.entries(sEnd.calls)) {
  if (!v.rounds) continue
  log(`  ${k.padEnd(12)}${String(v.rounds).padEnd(8)}${String(v.waves).padEnd(8)}${v.items}`)
}
log(`  写入总耗时 ${(totalMs / 1000).toFixed(1)}s（平均每条 ${(totalMs / SCRIPT.length).toFixed(0)}ms）`)
log(`  摘要总耗时 ${(totalSumMs / 1000).toFixed(1)}s（后台跑，不阻塞写入）`)

// ──────────────────────────────────────────────────────────────
// 分类质量抽检
// ──────────────────────────────────────────────────────────────
head('分类质量抽检（前 12 条 + 所有原则类）')
const all = mem.list()
const byImp = { 0.85: [], 0.6: [], 0.3: [] }
const raw = {}
for (const it of all) {
  if (it.kind === 'summary') continue
  const k = Number(it.importance)
  if (!raw[k]) raw[k] = []
  raw[k].push(it)
}
for (const [k, list] of Object.entries(raw).sort((a, b) => Number(b[0]) - Number(a[0]))) {
  log(`  importance=${k} 共 ${list.length} 条`)
  for (const it of list.slice(0, 4)) {
    log(`    [${it.channel.padEnd(6)}] ${it.speaker ? `[${it.speaker}] ` : ''}${String(it.text).slice(0, 46)}`)
  }
}

// ──────────────────────────────────────────────────────────────
// DL2（重要原文）与摘要
// ──────────────────────────────────────────────────────────────
head('DL2 重要原文库')
const dl2 = mem.list(LAYER.DL_LONG_RAW)
log(`  ${dl2.length} 条 / ${mem.stats().chars.DL2} 字`)
for (const it of dl2.slice(0, 8)) {
  log(`    [${it.channel}] imp=${it.importance} ${String(it.text).slice(0, 52)}`)
}

head('摘要（DL3 池子）')
const dl3 = mem.list().filter((it) => it.layer === LAYER.DL_LONG)
log(`  ${dl3.length} 条`)
for (const it of dl3) {
  const from = it.spanFrom ? dayKey(it.spanFrom).slice(5) : '?'
  const to = it.spanTo ? dayKey(it.spanTo).slice(5) : '?'
  log(`\n  [${it.channel}] ${from}~${to}  people=${JSON.stringify(it.people || [])}  来源${(it.sources || []).length}条`)
  for (const line of String(it.text).split('\n')) log(`    ${line}`)
}

// ──────────────────────────────────────────────────────────────
// 矛盾处理
// ──────────────────────────────────────────────────────────────
head('矛盾处理（表情包命令改过主意）')
const dead = mem.list().filter((it) => it.supersededBy)
log(`  作废条 ${dead.length} 条`)
for (const it of dead) {
  log(`    （已作废）[${it.speaker}] ${it.text}`)
  const newer = mem.list().find((x) => x.id === it.supersededBy)
  if (newer) log(`      被替代为 → [${newer.speaker}] ${newer.text}`)
}
// 查的是"旧命令还在不在摘要里"——新命令当然会提表情包，不能用这个词判
const inSummary = dl3.filter((it) => /不要发表情包|停止发表情包|别再发表情包/.test(String(it.text)))
log(`  摘要里还含旧命令的：${inSummary.length} 条（应为 0）`)
for (const it of inSummary) log(`    ${String(it.text).slice(0, 90)}`)

const newCmd = dl3.filter((it) => /要发表情包/.test(String(it.text)))
log(`  摘要里含新命令的：${newCmd.length} 条（应 ≥1，新命令要能进上下文）`)

// ──────────────────────────────────────────────────────────────
// 检索
// ──────────────────────────────────────────────────────────────
head('检索实测')

clock = new Date('2026-10-24T09:00:00+08:00').getTime() + 30 * DAY

const queries = [
  ['昨天发生了什么', {}],
  ['昨天发生了什么（含活跃层）', { includeActive: true }],
  ['星鲸说过什么', { person: '星鲸' }],
  ['那天我刷到什么了', {}],
  ['医院给数据的事', {}],
  ['召回率是怎么定的', {}],
]

for (const [q, opt] of queries) {
  const t0 = Date.now()
  const r = await mem.search(q, opt)
  const ms = Date.now() - t0
  log(`\n  「${q}」 ${r.hits.length} 条 ${ms}ms${r.timeWindow ? `  时间窗 ${r.timeWindow.from}~${r.timeWindow.to}` : ''}`)
  for (const h of r.hits.slice(0, 4)) {
    log(`    [${h.layer}/${h.channel}] ${h.when.slice(5, 16)} ${String(h.text).replace(/\s+/g, ' ').slice(0, 50)}`)
  }
  if (!r.hits.length) log('    （无命中）')
}

// ──────────────────────────────────────────────────────────────
// 注入样例
// ──────────────────────────────────────────────────────────────
head('最终注入样例（这就是模型每轮会看到的东西）')
const block = mem.buildBlock(2000)
log(block)

// ──────────────────────────────────────────────────────────────
// 时间推进：看热度衰减和视图变化
// ──────────────────────────────────────────────────────────────
// ★ 快进之前先存一份第 30 天的完整快照。
//   快进会让 DL3 的摘要按衰减曲线被遗忘、从库里删掉，
//   如果之后再读 store.json 就只剩不参与遗忘的 DL2 了——
//   看起来像"摘要全丢了"，其实是模拟脚本自己的顺序问题。
copyFileSync(join(DIR, 'store.json'), join(DIR, 'store_day30.json'))
mem.dumpVectors(join(DIR, 'vectors_day30.json'))   // 向量已分片，导出合并快照

head('快进 90 天（不写入，只看衰减）')
for (const step of [30, 60, 90]) {
  clock = new Date('2026-10-24T09:00:00+08:00').getTime() + (30 + step) * DAY
  await mem.sweep(clock)
  const s = mem.stats()
  const l3Now = mem.list(LAYER.LONG)
  log(`  +${step} 天：L3 视图 ${l3Now.length} 条 / DL3 池子 ${s.count.DL3} / DL1 ${s.count.DL1}`)
}

// ──────────────────────────────────────────────────────────────
// 写报告
// ──────────────────────────────────────────────────────────────
const report = [
  `# memory5 模拟报告（${LOCAL ? '本地规则' : '真实模型'}）`,
  '',
  `生成时间：${new Date().toLocaleString('zh-CN')}`,
  `数据目录：\`${DIR}\``,
  '',
  `- \`store_day30.json\` —— **第 30 天的完整快照**（含全部摘要，看这个）`,
  `- \`store.json\` —— 快进 90 天之后的状态（深层摘要已按衰减曲线遗忘）`,
  '',
  '## 一、写入演进',
  '',
  '| 天 | 新增 | 写入 | 摘要 | L1 | L2 | L3 | DL1 | DL2 | DL3 | 总数 |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...timeline.map((x) =>
    `| ${dayKey(new Date('2026-10-24T09:00:00+08:00').getTime() + x.day * DAY).slice(5)} | ` +
    `${x.add} | ${x.ms}ms | ${x.msSum ? x.msSum + 'ms' : '—'} | ${x.L1} | ${x.L2} | ${x.L3} | ${x.DL1} | ${x.DL2} | ${x.DL3} | ${x.total} |`
  ),
  '',
  '## 二、最终分布',
  '',
  '```json',
  JSON.stringify({ count: sEnd.count, byChannel: sEnd.byChannel, chars: sEnd.chars, total: sEnd.total }, null, 2),
  '```',
  '',
  '## 三、调用统计',
  '',
  '| 能力 | 请求 | 波次 | 条目 |',
  '|---|---|---|---|',
  ...Object.entries(sEnd.calls).filter(([, v]) => v.rounds).map(([k, v]) => `| ${k} | ${v.rounds} | ${v.waves} | ${v.items} |`),
  '',
  `写入总耗时 ${(totalMs / 1000).toFixed(1)}s`,
  '',
  '## 四、摘要',
  '',
  ...dl3.map((it) => {
    const from = it.spanFrom ? dayKey(it.spanFrom).slice(5) : '?'
    const to = it.spanTo ? dayKey(it.spanTo).slice(5) : '?'
    return `### [${it.channel}] ${from}~${to}\n\n\`\`\`\n${it.text}\n\`\`\`\n\npeople=${JSON.stringify(it.people || [])}，来源 ${(it.sources || []).length} 条\n`
  }),
  '',
  '## 五、矛盾处理',
  '',
  ...dead.map((it) => `- （已作废）[${it.speaker}] ${it.text}`),
  '',
  `摘要里提到表情包的：${inSummary.length} 条（应为 0）`,
  '',
  '## 六、最终注入',
  '',
  '```',
  block,
  '```',
  '',
].join('\n')

writeFileSync(join(DIR, '报告.md'), report, 'utf8')
writeFileSync(join(DIR, '完整输出.txt'), lines.join('\n'), 'utf8')

console.log(`\n${'='.repeat(70)}`)
console.log(`  报告：${DIR}/报告.md`)
console.log(`  完整输出：${DIR}/完整输出.txt`)
console.log('='.repeat(70))
