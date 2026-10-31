/**
 * 压测看门狗
 *
 * 用法：
 *   node watch.mjs            # 看 .big 的进度
 *   node watch.mjs .big-local # 看别的目录
 *
 * 输出一行状态。核心是**心跳距今多久**：
 * 压测每天都会重写 progress.json，所以文件 mtime 超过 2 分钟没动，
 * 就说明不是慢，是卡住了（网络挂起、429 长退避、死循环……）。
 *
 * 只读不写，随时可以跑，不会干扰正在跑的那一份。
 */
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 不给目录就自动找"最新写过的 progress.json"。
// ★ 必须自动找：压测在旧目录删不掉时会换 `.big-<时间戳>`，
//   这时盯 `.big` 会读到上一次的残留进度（心跳 583 秒前，看着像卡死）。
function autoDetect() {
  const cands = ['.big', '.big-local']
  for (const d of readdirSync('.', { withFileTypes: true })) {
    if (d.isDirectory() && /^\.big(-\d+)?$/.test(d.name)) cands.push(d.name)
  }
  let best = null
  for (const d of [...new Set(cands)]) {
    const f = join(d, 'progress.json')
    if (!existsSync(f)) continue
    const m = statSync(f).mtimeMs
    if (!best || m > best.m) best = { dir: d, m }
  }
  return best ? best.dir : '.big'
}

const dir = process.argv[2] || autoDetect()
const file = join(dir, 'progress.json')
const logFile = join(dir, '..', dir.replace(/^\./, '') + '.log')

if (!existsSync(file)) {
  console.log(`[watch] 还没有进度文件 ${file}（可能刚启动，或者跑的是别的目录）`)
  process.exit(0)
}

let snap
try {
  snap = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.log(`[watch] 进度文件读不出来（正在写？）：${e.message}`)
  process.exit(0)
}

// 心跳距今多久——这是判断"死没死"的唯一可靠信号
const ageSec = Math.round((Date.now() - statSync(file).mtimeMs) / 1000)

const mm = (s) => (s === null || s === undefined ? '?' : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`)

// 进程还在不在
let alive = null
try { process.kill(snap.pid, 0); alive = true } catch { alive = false }

const status = !alive ? '已结束/已崩溃'
  : ageSec > 180 ? '★ 卡住了（心跳 3 分钟没动）'
  : ageSec > 60 ? '偏慢（心跳 1 分钟没动）'
  : '正常'

console.log(
  `[watch ${new Date().toLocaleTimeString('zh-CN')}] ` +
  `${snap.day || '-'} (${snap.dayIndex ?? '?'}/${snap.totalDays}) ` +
  `${snap.doneItems}/${snap.totalItems} 条 ${snap.pct}% | ` +
  `阶段 ${snap.stage} | 已跑 ${mm(snap.elapsedSec)} 剩余约 ${mm(snap.etaSec)} | ` +
  `token ${snap.tokens}${snap.budget ? `/${snap.budget}` : ''} | ` +
  `心跳 ${ageSec}s 前 ${status}`
)

if (!alive) process.exit(1)
if (ageSec > 180) {
  console.log('[watch] 建议：看日志尾部找最后一行，确认卡在写入还是摘要。')
  console.log(`[watch] 日志：${logFile}`)
  process.exit(3)
}
