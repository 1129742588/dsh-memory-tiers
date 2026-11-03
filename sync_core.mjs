#!/usr/bin/env node
/**
 * 把 core/ 里的源码同步到插件根目录。
 *
 * 为什么会有两份：
 *   dsh 装载插件时从包根目录读 package.json / cordis.patch.yml，所以这些必须在根；
 *   但源码真源统一放在 core/，和 astrbot 端结构保持一致。
 *
 * 约定：
 *   真源 = core/      改代码只改这里
 *   副本 = 根目录     由本脚本生成，别手改（改了也会被覆盖）
 *
 * 用法：
 *   node sync_core.mjs            # core -> 根目录
 *   node sync_core.mjs --check    # 只检查是否一致，不一致退出码 1
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, 'core')
const SUFFIXES = new Set(['.mjs', '.js', '.json', '.yml', '.yaml'])
const SKIP = new Set(['sync_core.mjs'])

const check = process.argv.includes('--check')

if (!existsSync(CORE)) {
  console.error(`找不到 ${CORE}`)
  process.exit(2)
}

const files = readdirSync(CORE)
  .filter((f) => SUFFIXES.has(extname(f)) && !SKIP.has(f))
  .sort()

const stale = []
const same = []

for (const name of files) {
  const src = join(CORE, name)
  if (!statSync(src).isFile()) continue
  const dst = join(HERE, name)
  const a = readFileSync(src)
  const b = existsSync(dst) ? readFileSync(dst) : null
  if (b && a.equals(b)) {
    same.push(name)
    continue
  }
  stale.push(name)
  if (!check) writeFileSync(dst, a)
}

if (check) {
  if (stale.length) {
    console.error(`根目录副本与 core/ 不一致：${stale.join(', ')}`)
    console.error('跑一次 node sync_core.mjs 即可。')
    process.exit(1)
  }
  console.log(`一致：${same.length} 个文件`)
  process.exit(0)
}

console.log(`已同步 ${stale.length} 个：${stale.length ? stale.join(', ') : '（无变化）'}`)
console.log(`未变化 ${same.length} 个`)
