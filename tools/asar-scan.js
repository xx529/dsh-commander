// Grep / list inside Desktop app.asar using the Electron runtime (ASAR-aware).
// usage: ELECTRON_RUN_AS_NODE=1 "<Electron>" tools/asar-scan.js <mode> <target...>
//   list  <dir>
//   grep  <dir> <literal> [maxLines]
const fs = require('node:fs')
const path = require('node:path')

const [, , mode, target, term, maxArg] = process.argv
const MAX_BYTES = 1024 * 1024
const maxLines = Number(maxArg || 30)

function walk(dir, out, depth) {
  if (depth > 8 || out.length > 4000) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out, depth + 1)
    else out.push(p)
  }
}

if (mode === 'list') {
  let entries = []
  try {
    entries = fs.readdirSync(target)
  } catch (err) {
    console.log('LIST FAILED: ' + (err && err.message ? err.message.slice(0, 200) : String(err).slice(0, 200)))
    process.exit(0)
  }
  console.log(entries.slice(0, 400).join('\n'))
} else if (mode === 'grep') {
  const files = []
  let isFile = false
  try {
    isFile = fs.statSync(target).isFile()
  } catch {
    isFile = false
  }
  if (isFile) files.push(target)
  else walk(target, files, 0)
  let printed = 0
  for (const f of files) {
    if (!/\.(md|js|mjs|cjs|ts|tsx|json|yml|yaml)$/.test(f)) continue
    let st
    try {
      st = fs.statSync(f)
    } catch {
      continue
    }
    if (st.size > MAX_BYTES) continue
    let text
    try {
      text = fs.readFileSync(f, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && printed < maxLines; i++) {
      if (lines[i].includes(term)) {
        printed++
        console.log(`${f}:${i + 1}: ${lines[i].slice(0, 240)}`)
      }
    }
    if (printed >= maxLines) {
      console.log(`... truncated at ${maxLines} matches`)
      break
    }
  }
  if (printed === 0) console.log('NO MATCH')
}
