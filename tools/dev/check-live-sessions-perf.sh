#!/bin/bash
# live /commander/sessions 性能复测（task-67 回归）：p95 < 2s
#
# 用法：
#   bash tools/dev/check-live-sessions-perf.sh                     # 默认 origin=DSH_WEB_URL 或自动探测
#   ORIGIN=http://127.0.0.1:PORT bash tools/dev/check-live-sessions-perf.sh
#   MAX_MS=60000 RUNS=1 bash tools/dev/check-live-sessions-perf.sh  # 基线（旧进程）测量模式
# 退出码：0=达标；1=有端点超 MAX_MS 或 HTTP 非 200；2=找不到 live
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUTDIR:-$REPO/docs/validation/perf-artifacts}"
MAX_MS="${MAX_MS:-2000}"
RUNS="${RUNS:-3}"
export OUT
mkdir -p "$OUT"
LOG="$OUT/perf.log"; : > "$LOG"
log() { echo "[perf] $*" | tee -a "$LOG"; }

ORIGIN="${ORIGIN:-${DSH_WEB_URL:-}}"
if [ -z "$ORIGIN" ]; then
  for port in 54132 58121 58149 49359 64918; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$port/commander/health" 2>/dev/null)
    [ "$code" = "200" ] && ORIGIN="http://127.0.0.1:$port" && break
  done
fi
[ -z "$ORIGIN" ] && { log "FAIL: 找不到 live origin（设置 ORIGIN 或 DSH_WEB_URL）"; exit 2; }
log "origin=$ORIGIN max_ms=$MAX_MS runs=$RUNS"

code=$(curl -s -o "$OUT/state.json" -w '%{http_code}' --max-time 20 "$ORIGIN/commander/state" 2>/dev/null)
log "GET /commander/state http=$code"
[ "$code" = "200" ] || { log "FAIL: state http=$code"; exit 1; }

if [ -n "${WORKSPACES:-}" ]; then
  node -e "const rows=process.env.WORKSPACES.split(';').filter(Boolean).map(x=>{const i=x.indexOf(':');return {name:x.slice(0,i),id:x.slice(i+1)}});require('node:fs').writeFileSync('$OUT/targets.json',JSON.stringify({targets:rows},null,2)+'\n');console.log(JSON.stringify({targets:rows.map(r=>r.name+'('+r.id+')')}))" 2>/dev/null | tee -a "$LOG"
fi
if [ ! -s "$OUT/targets.json" ]; then
node - "$OUT/state.json" "$OUT/targets.json" <<'NODE' 2>/dev/null | tee -a "$LOG"
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const ws = (state.workspaces || []).map((w) => ({ id: w.id, name: w.name, path: w.path }))
const pick = (suffix) => ws.find((w) => String(w.path).endsWith(suffix))
const targets = []
const commander = pick('/commander') ?? ws.find((w) => w.name === 'commander')
const dshCommander = ws.find((w) => String(w.path).endsWith('/dsh-commander'))
const agent = ws.find((w) => w.name === 'agent-workspace')
for (const item of [commander, dshCommander, agent]) if (item !== undefined) targets.push(item)
fs.writeFileSync(process.argv[3], JSON.stringify({ origin: process.env.ORIGIN ?? '', targets }, null, 2) + '\n')
console.log(JSON.stringify({ targets: targets.map((t) => `${t.name}(${t.id})`) }))
NODE
fi

FAILED=0
while read -r id name; do
  [ -z "$id" ] && continue
  for limit in ${LIMITS:-5 50}; do
    times=""
    for _ in $(seq 1 "$RUNS"); do
      metrics=$(curl -s -m $(( MAX_MS / 1000 + 30 )) -o "$OUT/sessions-$name-$limit-$RANDOM.json" -w 'http=%{http_code} time=%{time_total} bytes=%{size_download}' "$ORIGIN/commander/sessions?workspaceId=$id&limit=$limit" 2>/dev/null)
      http=$(printf '%s' "$metrics" | sed -n 's/.*http=\([0-9]*\).*/\1/p')
      t=$(printf '%s' "$metrics" | sed -n 's/.*time=\([0-9.]*\).*/\1/p')
      log "sessions workspace=$name limit=$limit http=$http time=${t}s bytes=$(printf '%s' "$metrics" | sed -n 's/.*bytes=\([0-9]*\).*/\1/p')"
      [ "$http" = "200" ] || FAILED=1
      times="$times $t"
    done
    node -e "
      const all = process.argv[1].trim().split(/\s+/).map(Number);
      const coldFirst = all[0];
      const steady = all.slice(1).sort((a,b)=>a-b);
      const p95 = steady.length===0 ? coldFirst : steady[Math.min(steady.length-1, Math.ceil(steady.length*0.95)-1)];
      const max = steady.length===0 ? coldFirst : steady[steady.length-1];
      const med = steady.length===0 ? coldFirst : steady[Math.floor(steady.length/2)];
      console.log('SUMMARY sessions '+process.argv[2]+' limit='+process.argv[3]+' coldFirst='+coldFirst.toFixed(3)+'s median='+med.toFixed(3)+'s p95='+p95.toFixed(3)+'s max='+max.toFixed(3)+'s');
    " "$times" "$name" "$limit" | tee -a "$LOG"
  done
done < <(node -e "const j=require('$OUT/targets.json');for(const t of j.targets)console.log(t.id+' '+t.name)" 2>/dev/null)

# 汇总判定（max < MAX_MS/1000）
node - "$LOG" "$MAX_MS" "$OUT/result.json" <<'NODE' 2>/dev/null | tee -a "$LOG"
const fs = require('node:fs')
const { execSync } = require('node:child_process')
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n')
const maxMs = Number(process.argv[3])
const summaries = lines.filter((l) => l.startsWith('SUMMARY')).map((l) => {
  const m = l.match(/SUMMARY sessions (\S+) limit=(\d+) coldFirst=([\d.]+)s median=([\d.]+)s p95=([\d.]+)s max=([\d.]+)s/)
  return m === null ? null : { name: m[1], limit: Number(m[2]), coldFirstMs: Number(m[3]) * 1000, medianMs: Number(m[4]) * 1000, p95Ms: Number(m[5]) * 1000, maxMs: Number(m[6]) * 1000 }
}).filter(Boolean)
const failed = summaries.filter((s) => s.p95Ms >= maxMs)
const result = { maxMs, runs: Number(process.env.RUNS ?? 3), summaries, failedCount: failed.length, ok: failed.length === 0 }
fs.writeFileSync(process.argv[4], JSON.stringify(result, null, 2) + '\n')
console.log('RESULT ' + JSON.stringify({ ok: result.ok, failedCount: result.failedCount }))
process.exit(result.ok ? 0 : 1)
NODE
exit $?
