/**
 * 导出 dsh 侧的全部提示词（供 compare_prompts.py 与 astrbot 逐行对照）。
 *
 * 为什么用源码正则提取而不是 import：这些 prompt 是 silicon.mjs 的模块内私有常量，
 * 为了一个对照脚本去把它们导出，等于为了测试改生产接口。这里只读源码文本、
 * 用 eval 求值数组字面量，不执行任何业务逻辑。
 *
 * 用法：node dsh/test/prompt_dump.mjs   → 输出 JSON 到 stdout
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'core', 'silicon.mjs'), 'utf8')
const MEM = readFileSync(join(HERE, '..', 'core', 'memory.mjs'), 'utf8')

/** 取 `const NAME = [ ... ].join('\n')` 的字符串结果 */
function take(name, src = SRC) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\.join\\('\\\\n'\\)`)
  const m = src.match(re)
  if (!m) throw new Error(`找不到 ${name}`)
  return eval(`[${m[1]}].join('\\n')`)
}

/** 取某个函数体内的 `const NAME = [ ... ].join('\n')` */
function takeIn(fnName, name) {
  const start = SRC.indexOf(`function ${fnName}`)
  if (start < 0) throw new Error(`找不到函数 ${fnName}`)
  const body = SRC.slice(start, start + 8000)
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\.join\\('\\\\n'\\)`)
  const m = body.match(re)
  if (!m) throw new Error(`在 ${fnName} 里找不到 ${name}`)
  return eval(`[${m[1]}].join('\\n')`)
}

/**
 * 摘要 prompt 的 user 模板：把动态值替换成占位符，
 * 这样两端可以用同样的输入比"模板"而不是比数值。
 */
function summaryTemplate() {
  const start = SRC.indexOf('async function summarizeWithSources')
  const body = SRC.slice(start, start + 6000)
  const re = /const user = \[([\s\S]*?)\]\.join\('\\n'\)/
  const m = body.match(re)
  if (!m) throw new Error('找不到 summarizeWithSources 的 user')
  return `[${m[1]}].join('\\n')`
}

const out = {
  side: 'dsh',
  relation: takeIn('relation', 'sys'),
  classify: take('CLASSIFY_SYS'),
  classifyBatch: take('CLASSIFY_BATCH_SYS'),
  summarySystem: (() => {
    const m = SRC.match(/const sys = '(你把几条记忆压成摘要[^']*)'/)
    return m ? m[1] : null
  })(),
  summaryUserExpr: summaryTemplate(),
  // 注入位置：systemPrompt.context(order 250) → 系统提示词末尾
  inject: {
    api: (MEM.match(/order:\s*(\d+)/) || [])[1] || null,
  },
}

process.stdout.write(JSON.stringify(out, null, 1))
