/**
 * 从真实 livingmemory 数据构建压测数据集 —— `node build-dataset.mjs`
 *
 * 为什么不能直接用真实数据：2108 条消息全挤在 3 天里，验证不了衰减、分流、
 * 回温这些"需要时间才发生"的机制。
 *
 * 做法：真实内容做底，按真实模式扩到 60 天。
 *   ① 210 条真实原子记忆原样使用（放在最后 3 天，贴合真实时间）
 *   ② 用真实句子做"骨架变形"生成变体（换人、换数量、换时间词）——
 *      句式是真人的，比凭空编的自然
 *   ③ 少量模板补齐三类真实数据里稀缺的内容：
 *      主人的命令（会被矛盾替换）、项目进展（有数字结果）、刷到的内容
 *
 * 输出 dataset.json：
 *   { meta, items: [{ text, speaker, scene, at, src }] }
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const DATA_DIR = 'C:/Users/Anxiple/.astrbot_launcher/instances/56f66ac7-8570-41f3-82f3-91adacb6a65a/core/data/plugin_data/astrbot_plugin_livingmemory'

// 用系统 python 读 sqlite（node 没有内置 sqlite 驱动）
function query(db, sql) {
  const py = `
import sqlite3, json, sys
con = sqlite3.connect(${JSON.stringify(db)})
con.row_factory = sqlite3.Row
rows = [dict(r) for r in con.execute(${JSON.stringify(sql)})]
con.close()
print(json.dumps(rows, ensure_ascii=False))
`
  const out = execFileSync('python', ['-c', py], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(out)
}

// ──────────────────────────────────────────────────────────────
// ① 真实原子记忆
// ──────────────────────────────────────────────────────────────
console.log('读真实数据…')
const atoms = query(`${DATA_DIR}/livingmemory.db`, `
  SELECT content, importance, atom_type, entities, created_at, session_id
  FROM memory_atoms
  WHERE content IS NOT NULL AND length(trim(content)) > 4
  ORDER BY created_at
`)

const msgs = query(`${DATA_DIR}/conversations.db`, `
  SELECT content, sender_name, session_id, timestamp
  FROM messages
  WHERE role = 'user' AND content IS NOT NULL AND length(trim(content)) > 6
    AND content NOT LIKE '[At:%'
  ORDER BY timestamp
`)

console.log(`  原子记忆 ${atoms.length} 条，用户消息 ${msgs.length} 条`)

// ──────────────────────────────────────────────────────────────
// ② 提取真实素材：说话人、话题、句式种子
// ──────────────────────────────────────────────────────────────
const speakerCount = new Map()
for (const m of msgs) {
  if (!m.sender_name) continue
  speakerCount.set(m.sender_name, (speakerCount.get(m.sender_name) || 0) + 1)
}
// 过滤掉纯数字 ID（那是 bot 自己）
const SPEAKERS = [...speakerCount.entries()]
  .filter(([n]) => !/^\d+$/.test(n) && n !== 'astrbot')
  .sort((a, b) => b[1] - a[1])
  .map(([n]) => n)

const topicCount = new Map()
for (const a of atoms) {
  let list = []
  try { list = JSON.parse(a.entities || '[]') } catch { /* 忽略 */ }
  for (const e of list) {
    if (typeof e !== 'string' || e.length < 2 || e.length > 18) continue
    topicCount.set(e, (topicCount.get(e) || 0) + 1)
  }
}
const TOPICS = [...topicCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t]) => t)

console.log(`  说话人 ${SPEAKERS.length} 个：${SPEAKERS.slice(0, 8).join('、')}`)
console.log(`  话题 ${TOPICS.length} 个：${TOPICS.slice(0, 6).join('、')}`)

// 场景：真实是群 966657516 + 私聊主人
const GROUP = 'group:966657516'
const PRIV = 'private:1129742588'
const OWNER = 'Anxiple'

// ──────────────────────────────────────────────────────────────
// ③ 骨架变形：把真实句子换成别的名字/数量
// ──────────────────────────────────────────────────────────────
const NAME_POOL = SPEAKERS.filter((s) => s !== OWNER)

function pick(arr, i) { return arr[i % arr.length] }

/**
 * 清掉群聊格式噪音
 *
 * 原始消息里带 [At:123456] [引用: xxx] 这类标记，留着会让记忆变成
 * 「[引用: 欸…你都没说要问什么] [At:2134551908] 不要问就说可以」——
 * 这些是 QQ 消息的格式残留，不是内容。
 */
function clean(text) {
  return String(text || '')
    .replace(/\[At:\d+\]/g, '')
    .replace(/\[引用[^\]]*\]/g, '')
    .replace(/\[图片\]/g, '')
    .replace(/\[表情\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 把句子里出现的人名换掉（避开原句自己的人名，换成另一个） */
function swapName(text, i) {
  const present = SPEAKERS.filter((s) => text.includes(s))
  if (!present.length) return text
  const from = pick(present, i)
  const to = pick(NAME_POOL.filter((s) => !text.includes(s)), i * 7 + 3) || from
  if (to === from) return text
  return text.split(from).join(to)
}

const NUM_SWAP = [
  ['三', '五'], ['两', '四'], ['四', '六'], ['五', '七'], ['七', '九'],
  ['十', '十二'], ['一', '两'], ['幾', '几'], ['几', '好几'],
]

/** 把数量词换掉，制造"类似但不完全相同"的变体 */
function swapNum(text, i) {
  for (let k = 0; k < NUM_SWAP.length; k++) {
    const [a, b] = NUM_SWAP[(i + k) % NUM_SWAP.length]
    if (text.includes(a)) return text.replace(a, b)
  }
  return text
}

// 真实句子做种子（太短的跳过）
const SEEDS = atoms
  .map((a) => String(a.content || '').trim())
  .filter((t) => t.length >= 8 && t.length <= 60)

function variant(seed, i) {
  let t = seed
  if (i % 3 === 0) t = swapName(t, i)
  else if (i % 3 === 1) t = swapNum(t, i)
  else { t = swapName(t, i); t = swapNum(t, i + 5) }
  return t
}

// ──────────────────────────────────────────────────────────────
// ④ 模板：补真实数据里稀缺的三类
//
// 真实群聊里几乎没有"我做的事有数字结果"和"主人下的命令"，
// 但这恰恰是分层机制最吃紧的部分（0.85 直进 DL2、命令会被矛盾替换）。
// ──────────────────────────────────────────────────────────────
const TEMPLATE_ACTIONS = [
  '把群公告改完了，一共整理了 12 条群规',
  '清了一轮重复的表情包，删掉 47 张',
  '给表情包库打了标签，分了 8 类',
  '把聊天记录的备份做完，压缩到 9G',
  '重写了欢迎语，从 3 行缩到 1 行',
  '统计了这个月的活跃人数，一共 43 个',
  '把机器人的人格文件整理了一遍，删掉重复的 6 段',
  '做了个自动回复的黑名单，加了 15 个关键词',
  '把群文件清理了一遍，腾出 2G',
  '修好了欢迎语的变量，之前一直显示错的名字',
  '把奶龙表情包按尺寸重新排了一遍，一共 96 张',
  '备份了三次对话记录，加起来 4000 多条',
]
const TEMPLATE_EVENTS = [
  '刷到一个讲表情包版权的视频，说商用要注意',
  '在别的群看到有人用同样的头像，愣了一下',
  '抖音上刷到个讲群聊运营的，说关键是活跃度',
  '看到有人发了个机器人被玩坏了的截图',
  '刷到个视频说现在 AI 聊天机器人越来越像人了',
  '在评论区看到有人问怎么让机器人记住自己',
  '看到个帖子讲群管理怎么定规矩，说得挺细',
  '刷到个讲表情包怎么做的教程，看着不难',
  '在别的群看到一模一样的欢迎语，怀疑是同款机器人',
  '看到有人晒自己群的机器人，功能比我们的多',
]
const TEMPLATE_ORDERS = [
  '以后别在群里发那种带攻击性的图了',
  '以后群里说话别带脏字，看着不舒服',
  '以后发图之前看一眼，别刷屏',
  '以后晚上十二点之后别在群里刷消息',
  '以后欢迎语别写那么长，一句话就行',
  '以后涉及别人的事别在群里说',
  '以后群里发链接之前先说一句这是什么',
  '以后别随便把聊天记录截图发出去',
]

// ──────────────────────────────────────────────────────────────
// ⑤ 组装 60 天
// ──────────────────────────────────────────────────────────────
// ★ 支持 --days=N 扩展到更长（2026-10-31）。默认 60 天。
//   要跑 90 天超万字模拟就传 --days=90。
const daysArg = process.argv.find((a) => a.startsWith('--days='))
const DAYS = daysArg ? Number(daysArg.split('=')[1]) : 60
const START = new Date('2026-09-01T08:00:00+08:00').getTime()
const DAY = 86400e3

const items = []
let seedIdx = 0
let orderIdx = 0

// 让每天 14~20 条，模拟真实的密度波动
// mulberry32：32 位状态，不涉及超过 2^53 的乘法，分布稳定。
// （第一版用 LCG，rnd * 1103515245 超过 Number 精度，结果退化成
//   某一天爆出 318 条、其他天十几条——一眼看不出问题，但分布全废）
let rnd = 0x9e3779b9
const rand = () => {
  rnd = (rnd + 0x6D2B79F5) | 0
  let t = Math.imul(rnd ^ (rnd >>> 15), 1 | rnd)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const ri = (n) => Math.floor(rand() * n)

for (let d = 0; d < DAYS; d++) {
  const dayStart = START + d * DAY
  const n = 14 + ri(7)
  // 每天的时间点：白天几波，晚上一波
  const slots = []
  for (let k = 0; k < n; k++) slots.push(dayStart + (8 + Math.floor((k / n) * 14)) * 3600e3 + ri(3000) * 1000)

  for (let k = 0; k < n; k++) {
    const at = slots[k]
    const roll = rand()

    let text, speaker, scene

    if (roll < 0.06) {
      // 主人的命令（约 6%）
      text = TEMPLATE_ORDERS[orderIdx % TEMPLATE_ORDERS.length]
      orderIdx++
      speaker = OWNER
      scene = GROUP
    } else if (roll < 0.16) {
      // 我做的事（约 10%）
      text = TEMPLATE_ACTIONS[ri(TEMPLATE_ACTIONS.length)]
      speaker = '我'
      scene = PRIV
    } else if (roll < 0.26) {
      // 刷到的内容（约 10%）
      text = TEMPLATE_EVENTS[ri(TEMPLATE_EVENTS.length)]
      speaker = '我'
      scene = 'douyin'
    } else {
      // 群聊（约 74%）：真实句子变形
      const seed = SEEDS[seedIdx % SEEDS.length]
      seedIdx++
      text = variant(seed, seedIdx)
      // ★ speaker 跟句中主语对齐。
      //   不对齐会出现「[㊗️你小㊗️] 艾婷门-梼杌表示自己没那么容易被带坏」这种，
      //   读起来像别人转述——虽然合法，但会让"谁说的"这个信号变弱，
      //   而这正是要验证的东西。
      speaker = SPEAKERS.find((x) => text.startsWith(x)) || SPEAKERS[ri(SPEAKERS.length)]
      scene = GROUP
    }

    items.push({ text, speaker, scene, at, src: 'gen' })
  }
}

// ──────────────────────────────────────────────────────────────
// ⑥ 真实数据放最后 3 天（10-28 ~ 10-30），原样不加工
// ──────────────────────────────────────────────────────────────
// 真实数据摊到后 20 天（10-11 ~ 10-30）。
// 全挤在原始那 3 天里的话，最后几天每天 400+ 条，分布畸重，
// 一压就是上百条，看不出分层节奏。
const REAL_DAYS = 20
const REAL_START = new Date('2026-10-11T09:00:00+08:00').getTime()
// ★ 按序号均摊，不按原始时间比例。
//   真实数据的时间分布本身极端不均（10-28 一天有 1064 条，其余天几十条），
//   按比例摊开还是会堆成两个尖峰。均摊至少保证"每天都有真实内容"。
const REAL_SPAN_MS = (REAL_DAYS - 1) * DAY
const spread = (i, total) => REAL_START + (total <= 1 ? 0 : (i / (total - 1)) * REAL_SPAN_MS) + rand() * 12 * 3600e3

const atomsSorted = [...atoms].sort((a, b) => Number(a.created_at) - Number(b.created_at))

for (let i = 0; i < atomsSorted.length; i++) {
  const a = atomsSorted[i]
  const who = SPEAKERS.find((s) => String(a.content).startsWith(s)) || '我'
  items.push({
    text: clean(a.content),
    speaker: who,
    scene: /FriendMessage/.test(a.session_id || '') ? PRIV : GROUP,
    at: spread(i, atomsSorted.length),
    src: 'real',
  })
}

// 真实用户消息也抽一部分（挑有信息量、不太短的）
const msgsKept = []
for (const m of msgs) {
  const c = clean(m.content)
  if (c.length < 8 || c.length > 60) continue
  if (!/[\u4e00-\u9fa5]/.test(c)) continue        // 必须含中文，纯符号跳过
  if (/^[\d\s.。?？!！~～]+$/.test(c)) continue
  // 纯数字是 bot 自己的 ID，不是人名——留着会变成"3891407632 说…"
  const who = m.sender_name || ''
  if (!who || /^\d+$/.test(who) || who === 'astrbot') continue
  msgsKept.push({ c, who, scene: /FriendMessage/.test(m.session_id || '') ? PRIV : GROUP })
}

msgsKept.sort((a, b) => a.c.localeCompare(b.c))
for (let i = 0; i < msgsKept.length; i++) {
  const m = msgsKept[i]
  items.push({ text: m.c, speaker: m.who, scene: m.scene, at: spread(i, msgsKept.length), src: 'real-msg' })
}

// 按时间排序
items.sort((a, b) => a.at - b.at)

const real = items.filter((x) => x.src === 'real' || x.src === 'real-msg').length
const gen = items.length - real
const byDay = new Map()
for (const it of items) {
  const d = new Date(it.at).toISOString().slice(0, 10)
  byDay.set(d, (byDay.get(d) || 0) + 1)
}

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: 'livingmemory.db + conversations.db',
    realAtoms: atoms.length,
    realMessages: msgs.length,
    total: items.length,
    real,
    gen,
    days: DAYS,
    from: new Date(items[0].at).toISOString(),
    to: new Date(items[items.length - 1].at).toISOString(),
    speakers: SPEAKERS,
  },
  items,
}

writeFileSync('.dataset.json', JSON.stringify(out, null, 1), 'utf8')

console.log(`\n生成 ${items.length} 条（真实 ${real} + 生成 ${gen}）`)
console.log(`时间 ${out.meta.from.slice(0, 10)} ~ ${out.meta.to.slice(0, 10)}，覆盖 ${byDay.size} 天`)
const counts = [...byDay.values()]
console.log(`每天 ${Math.min(...counts)}~${Math.max(...counts)} 条，平均 ${(items.length / byDay.size).toFixed(1)}`)
console.log('写入 .dataset.json')
