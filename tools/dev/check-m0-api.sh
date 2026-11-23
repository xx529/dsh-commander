#!/bin/bash
# M0-2 面板消息通道「形状验证」：在隔离 profile（/tmp DSH_HOME，绝不写 live desktop）里
# 安装本地包 → 启动 web Host → 按 backend 清单验证 **两条真实成功分支**：
#   case A: binding mode=new + workspaceId（隔离 Home 先注册一个工作区，见 fixture）
#   case B: binding mode=new + cwd（无注册工作区分支）
# 每 case 都验证：binding 200 → message 200 accepted → 同 requestId 幂等（同 messageId）
#   → state.messages 有 user echo → SSE 首帧 snapshot + commander.message(role=user)。
#
# 隔离 Home 无模型 provider 凭据：prompt 可能在 admission 后异步失败（多回合/assistant 部分留 live），
# 只要 message 200 accepted + user echo + SSE user 即视为形状 PASS。
#
# 用法：bash tools/dev/check-m0-api.sh
#       PROBE_ROOT=/tmp/x OUTDIR=/tmp/m0-api-ev bash tools/dev/check-m0-api.sh
# 退出码：0 = 两个 case 全部硬断言 PASS；非 0 = 有失败（详见 artifacts/commands.log）。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_BASE="${PROBE_ROOT:-/tmp/dsh-commander-m0-api}"
ART="${OUTDIR:-$REPO/docs/validation/m0-artifacts-api}"
PROFILE=m0
FAILED=0
CMDS="$ART/commands.log"
mkdir -p "$ART"
: > "$CMDS"
SUM="$ART/00-run-summary.txt"
: > "$SUM"
log() { echo "[m0-api] $*"; echo "[m0-api] $*" >> "$SUM"; }
record() { echo "$*" >> "$CMDS"; }
assert() {
  local tag="$1" name="$2" expected="$3" actual="$4"
  if [ "$expected" = "$actual" ]; then record "## ASSERT PASS [$tag] $name ($actual)"; log "PASS [$tag] $name ($actual)"
  else record "## ASSERT FAIL [$tag] $name expected=$expected actual=$actual"; log "FAIL [$tag] $name expected=$expected actual=$actual"; FAILED=1; fi
}
assert_in() { # tag name haystack needle
  if printf '%s' "$3" | grep -q -- "$4"; then record "## ASSERT PASS [$1] $2"; log "PASS [$1] $2"
  else record "## ASSERT FAIL [$1] $2 (missing '$4')"; log "FAIL [$1] $2 (missing '$4')"; FAILED=1; fi
}
SAFE_ENV=(env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

# ---------------------------------------------------------------- 环境版本 + live 前基线
{
  echo "# M0-2 API 形状验证环境 $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "dsh CLI: $(dsh --version 2>/dev/null)"; echo "node(PATH): $(node --version)"; echo "pnpm: $(pnpm --version 2>/dev/null)"
  echo "PROBE_BASE=$PROBE_BASE"; echo "ART=$ART"
} > "$ART/env-versions.txt" 2>&1
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-pre.txt" >/dev/null 2>&1 || true

# ---------------------------------------------------------------- 构建（真实 Host+Client）
( cd "$REPO" && pnpm --filter dsh-commander build ) > "$ART/01-build.log" 2>&1
BUILD_EXIT=$?
record "\$ pnpm --filter dsh-commander build   # exit=$BUILD_EXIT"
assert "" "build exit" "0" "$BUILD_EXIT"
[ "$BUILD_EXIT" -ne 0 ] && { log "build failed"; exit 2; }

# ---------------------------------------------------------------- 帮助函数
CLI_DIR=""
DSH_BIN="$(command -v dsh || true)"
if [ -n "$DSH_BIN" ] && [ -f "$DSH_BIN" ]; then
  CLI_BINJS="$(sed -n 's#.*"\([^"]*lib/node_modules/@deepseek-ai/dsh/lib/bin.js\)".*#\1#p' "$DSH_BIN" | head -1)"
  CLI_BINJS="${CLI_BINJS//\$HOME/$HOME}"
  [ -f "$CLI_BINJS" ] && CLI_DIR="$(dirname "$(dirname "$CLI_BINJS")")"
fi
if [ -z "$CLI_DIR" ] || [ ! -d "$CLI_DIR" ]; then CLI_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh 2>/dev/null | tail -1)"; fi

init_probe() { # $1 = probe root
  local root="$1"
  PROBE_ROOT="$root"; DSH_HOME="$root/home"; DSH_AGENTS_HOME="$root/agents"
  export DSH_HOME DSH_AGENTS_HOME
  rm -rf "$PROBE_ROOT/home" "$PROBE_ROOT/agents"; mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$PROBE_ROOT/ws-m0"
  "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --from-default-profile web --dump-default-config > "$ART/02-default-config-$(basename "$root").yml" 2> "$ART/02-default-config-$(basename "$root").err"
  local init_exit=$?
  record "\$ dsh --profile $PROFILE --from-default-profile web --dump-default-config   # ($(basename "$root")) exit=$init_exit"
  [ "$init_exit" -eq 0 ] || return 1
  if [ -n "$CLI_DIR" ] && [ -d "$CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat" ]; then
    mkdir -p "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai"
    ln -sfn "$CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat" "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai/dsh-client-ui-chat"
  fi
  env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX \
    npm_config_registry="${npm_config_registry:-https://mirrors.cloud.tencent.com/npm/}" \
    npm_config_store_dir="$PROBE_ROOT/.pnpm-store" \
    dsh plugin --profile "$PROFILE" add "file:$REPO/packages/dsh-commander" > "$ART/03-plugin-add-$(basename "$root").log" 2>&1
  local add_exit=$?
  record "\$ dsh plugin --profile $PROFILE add file:$REPO/packages/dsh-commander   # ($(basename "$root")) exit=$add_exit"
  [ "$add_exit" -eq 0 ] || return 1
  return 0
}

boot_host() { # $1=tag $2=patch(optional, empty=none) $3=probe root
  local tag="$1" patch="$2" root="$3"
  PROBE_ROOT="$root"; DSH_HOME="$root/home"; DSH_AGENTS_HOME="$root/agents"
  export DSH_HOME DSH_AGENTS_HOME
  : > "$ART/04-boot-$tag.out"; : > "$ART/04-boot-$tag.err"
  if [ -n "$patch" ]; then
    COMMANDER_BOOT_LOG=warn "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$patch" --port 0 --no-open \
      > "$ART/04-boot-$tag.out" 2> "$ART/04-boot-$tag.err" &
  else
    COMMANDER_BOOT_LOG=warn "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --port 0 --no-open \
      > "$ART/04-boot-$tag.out" 2> "$ART/04-boot-$tag.err" &
  fi
  BOOT_PID=$!
  BASE=""
  for _ in $(seq 1 160); do
    BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$ART/04-boot-$tag.out" | head -1)
    [ -n "$BASE" ] && break
    sleep 0.25
  done
  if [ -z "$BASE" ]; then log "FAIL [$tag] host did not print URL"; head -10 "$ART/04-boot-$tag.err" >> "$SUM"; return 1; fi
  for _ in $(seq 1 120); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/commander/health" || true)
    [ "$code" = "200" ] && break
    sleep 0.25
  done
  sleep 0.5
  record "## boot [$tag] BASE=$BASE"
  return 0
}

stop_host() { kill "$BOOT_PID" 2>/dev/null; wait "$BOOT_PID" 2>/dev/null; }

get() { # tag path out
  local tag="$1" path="$2" out="$3" code
  code=$(curl -s "$BASE$path" -o "$ART/$out" -w '%{http_code}' 2>> "$ART/.curl.err")
  record "\$ curl -s '$BASE$path'   # [$tag] http=$code"
  echo "$code"
}
put() { # tag path body out（PUT 路由）
  local tag="$1" path="$2" body="$3" out="$4" code
  code=$(curl -s -X PUT "$BASE$path" -H 'content-type: application/json' -d "$body" -o "$ART/$out" -w '%{http_code}' 2>> "$ART/.curl.err")
  record "\$ curl -s -X PUT '$BASE$path' -d '$body'   # [$tag] http=$code"
  echo "$code"
}
post() { # tag path body out
  local tag="$1" path="$2" body="$3" out="$4" code
  code=$(curl -s -X POST "$BASE$path" -H 'content-type: application/json' -d "$body" -o "$ART/$out" -w '%{http_code}' 2>> "$ART/.curl.err")
  record "\$ curl -s -X POST '$BASE$path' -d '$body'   # [$tag] http=$code"
  echo "$code"
}

# ================================================================ 公共：message 路径验证
verify_message_path() { # $1=tag $2=bound sessionId
  local tag="$1" sid="$2"
  local msg_code msg_body
  msg_code=$(post "$tag" /commander/message '{"text":"只回一句：m0-ok","requestId":"req_msg_smoke_1"}' "14-message-$tag.json")
  msg_body="$(cat "$ART/14-message-$tag.json")"
  record "## [$tag] message first http=$msg_code body=$msg_body"
  assert "$tag" "POST /commander/message → 200" "200" "$msg_code"
  if [ "$msg_code" = "200" ]; then
    assert_in "$tag" "message has accepted:true" "$msg_body" '"accepted":true'
    assert_in "$tag" "message has messageId" "$msg_body" '"messageId"'
    assert_in "$tag" "message has sessionId" "$msg_body" '"sessionId"'
  fi
  # 幂等：同 requestId 再发
  local rep_code
  rep_code=$(post "$tag" /commander/message '{"text":"只回一句：m0-ok","requestId":"req_msg_smoke_1"}' "15-message-repeat-$tag.json")
  record "## [$tag] message repeat http=$rep_code body=$(cat "$ART/15-message-repeat-$tag.json")"
  if [ "$msg_code" = "200" ] && [ "$rep_code" = "200" ]; then
    local mid1 mid2
    mid1=$(node -e "try{console.log(require('$ART/14-message-$tag.json').messageId ?? '')}catch{console.log('')}")
    mid2=$(node -e "try{console.log(require('$ART/15-message-repeat-$tag.json').messageId ?? '')}catch{console.log('')}")
    assert "$tag" "idempotent same messageId" "$mid1" "$mid2"
  else
    record "## WARN [$tag] idempotency not asserted (status $msg_code/$rep_code)"
  fi
  # state: user echo
  local state_code msg_count echo_ok
  state_code=$(get "$tag" /commander/state "16-state-after-message-$tag.json")
  assert "$tag" "GET /commander/state after message" "200" "$state_code"
  echo_ok=$(node -e "try{const j=require('$ART/16-state-after-message-$tag.json');const m=(j.messages||[]);const hit=m.find(x=>x.messageId==='req_msg_smoke_1')||m.find(x=>(x.text||'').includes('m0-ok'));console.log(hit?('role='+(hit.role??'?')+',messageId='+(hit.messageId??'')):'no-echo')}catch(e){console.log('parse-error')}")
  record "## [$tag] state.messages echo: $echo_ok (count=$(node -e "try{console.log((require('$ART/16-state-after-message-$tag.json').messages||[]).length)}catch{console.log(-1)}"))"
  if printf '%s' "$echo_ok" | grep -q "role=user"; then
    assert "$tag" "state.messages has user echo" "1" "1"
  else
    assert_in "$tag" "state.messages has user echo" "$echo_ok" "role=user"
  fi
  record "## [$tag] commanderStatus=$(node -e "try{console.log(require('$ART/16-state-after-message-$tag.json').commanderStatus)}catch{console.log('?')}") commanderBusy=$(node -e "try{console.log(require('$ART/16-state-after-message-$tag.json').commanderBusy)}catch{console.log('?')}")"
  # SSE：先开流，再发一条新消息，断言 snapshot + commander.message(role=user)
  ( curl -sN --max-time 6 -H 'accept: text/event-stream' "$BASE/commander/state" > "$ART/17-sse-$tag.txt" 2>/dev/null ) &
  local sse_pid=$!
  sleep 1
  post "$tag" /commander/message '{"text":"SSE 探测：m0-ok","requestId":"req_msg_sse_smoke_1"}' "17b-message-sse-$tag.json" >/dev/null
  sleep 1
  wait "$sse_pid" 2>/dev/null
  head -c 900 "$ART/17-sse-$tag.txt" > "$ART/17-sse-head-$tag.txt"
  record "## [$tag] SSE bytes=$(wc -c < "$ART/17-sse-$tag.txt" | tr -d ' ') head=$(head -c 300 "$ART/17-sse-$tag.txt" | tr '\n' ' ')"
  assert_in "$tag" "SSE first frame snapshot" "$(cat "$ART/17-sse-$tag.txt")" "event: snapshot"
  assert_in "$tag" "SSE pushes commander.message" "$(cat "$ART/17-sse-$tag.txt")" "event: commander.message"
  assert_in "$tag" "SSE message role user" "$(cat "$ART/17-sse-$tag.txt")" '"role":"user"'
}

# ================================================================ case A：workspaceId 绑定
log "===== case A: binding mode=new + workspaceId ====="
ROOT_A="$PROBE_BASE-wsid"
init_probe "$ROOT_A" || { log "init probe A failed"; exit 2; }
# fixture：隔离 Home 注册工作区
FIXTURE_A="$ROOT_A/workspace-fixture.patch.yml"
cat > "$FIXTURE_A" <<EOF
- insert:
    - id: m0-workspace-fixture
      name: 'file://$REPO/tools/dev/spike/m0-workspace-fixture.mjs'
      config:
        path: $ROOT_A/ws-m0
EOF
boot_host "a-wsid" "$FIXTURE_A" "$ROOT_A" || { FAILED=1; }
if [ -n "${BASE:-}" ]; then
  for _ in $(seq 1 60); do grep -q "workspace created\|workspace exists" "$ART/04-boot-a-wsid.out" 2>/dev/null && break; sleep 0.25; done; sleep 0.5
  { grep -n "commander\|m0-workspace-fixture" "$ART/04-boot-a-wsid.out" 2>/dev/null; grep -n "commander" "$ART/04-boot-a-wsid.err" 2>/dev/null; } > "$ART/05-boot-commander-lines-a.txt" 2>&1 || true
  assert_in "a-wsid" "boot ready line visible (COMMANDER_BOOT_LOG=warn; stdout+stderr)" "$(cat "$ART/05-boot-commander-lines-a.txt")" "commander] host ready"
  assert_in "a-wsid" "fixture workspace registered" "$(cat "$ART/04-boot-a-wsid.out")" "m0-workspace-fixture] workspace"
  code=$(get "a-wsid" /commander/state "10-state-initial-a.json"); assert "a-wsid" "GET /commander/state" "200" "$code"
  WS_ID=$(node -e "try{console.log(require('$ART/10-state-initial-a.json').workspaces?.[0]?.id ?? '')}catch{console.log('')}")
  record "## [a-wsid] workspaces[0].id=$WS_ID"
  BIND_CODE=$(post "a-wsid" /commander/binding "{\"mode\":\"new\",\"workspaceId\":\"$WS_ID\",\"requestId\":\"req_bind_smoke_wsid_1\"}" "12-binding-wsid.json")
  record "## [a-wsid] binding body=$(cat "$ART/12-binding-wsid.json")"
  assert "a-wsid" "binding mode=new + workspaceId → 200" "200" "$BIND_CODE"
  assert_in "a-wsid" "binding has sessionId" "$(cat "$ART/12-binding-wsid.json")" '"sessionId"'
  assert_in "a-wsid" "commanderStatus bound" "$(cat "$ART/12-binding-wsid.json")" '"commanderStatus":"bound"'
  SID_A=$(node -e "try{const j=require('$ART/12-binding-wsid.json');console.log(j.binding?.sessionId ?? '')}catch{console.log('')}")
  code=$(get "a-wsid" /commander/config "11-config.json"); assert "a-wsid" "GET /commander/config" "200" "$code"
  assert_in "a-wsid" "config has jev.threshold" "$(cat "$ART/11-config.json")" '"threshold"'
  verify_message_path "a-wsid" "$SID_A"

  # ---- case A2：V4 式持久化（同 home 第二次 boot）----
  PUT_CFG=$(put "a-wsid" /commander/config '{"jev":{"threshold":0.66}}' "18-put-config.json")
  assert "a-wsid" "PUT /commander/config → 200" "200" "$PUT_CFG"
  PUT_WS=$(put "a-wsid" /commander/workspaces "{\"workspaces\":[{\"id\":\"$WS_ID\",\"allowed\":false,\"summary\":\"m0-persist-probe\",\"policy\":\"inherit\"}]}" "18b-put-workspaces.json")
  assert "a-wsid" "PUT /commander/workspaces → 200" "200" "$PUT_WS"
  stop_host
  # 第二次 boot 同一 home（fixture 已存在，走 exists 分支）
  boot_host "a2-persist" "$FIXTURE_A" "$ROOT_A" || FAILED=1
  if [ -n "${BASE:-}" ]; then
    code=$(get "a2-persist" /commander/config "19-config-after-restart.json"); assert "a2-persist" "GET /commander/config (after restart)" "200" "$code"
    THRESH=$(node -e "try{console.log(require('$ART/19-config-after-restart.json').config?.jev?.threshold)}catch{console.log('?')}")
    assert "a2-persist" "jev.threshold persisted (0.66)" "0.66" "$THRESH"
    code=$(get "a2-persist" /commander/state "19b-state-after-restart.json"); assert "a2-persist" "GET /commander/state (after restart)" "200" "$code"
    BIND_SID2=$(node -e "try{console.log(require('$ART/19b-state-after-restart.json').binding?.sessionId ?? '')}catch{console.log('')}")
    assert "a2-persist" "binding.sessionId persisted" "$SID_A" "$BIND_SID2"
    WS_SUMMARY=$(node -e "try{const w=(require('$ART/19b-state-after-restart.json').workspaces||[]).find(x=>x.id==='$WS_ID');console.log((w?.summary??'')+'|'+String(w?.allowed))}catch{console.log('?')}")
    assert "a2-persist" "workspace record persisted (summary|allowed)" "m0-persist-probe|false" "$WS_SUMMARY"
    stop_host
  fi
fi

# ================================================================ case B：cwd 绑定
log "===== case B: binding mode=new + cwd（无注册工作区） ====="
ROOT_B="$PROBE_BASE-cwd"
init_probe "$ROOT_B" || { log "init probe B failed"; exit 2; }
boot_host "b-cwd" "" "$ROOT_B" || { FAILED=1; }
if [ -n "${BASE:-}" ]; then
  sleep 0.5
  { grep -n "commander" "$ART/04-boot-b-cwd.out" 2>/dev/null; grep -n "commander" "$ART/04-boot-b-cwd.err" 2>/dev/null; } > "$ART/05-boot-commander-lines-b.txt" 2>&1 || true
  assert_in "b-cwd" "boot ready line visible (COMMANDER_BOOT_LOG=warn; stdout+stderr)" "$(cat "$ART/05-boot-commander-lines-b.txt")" "commander] host ready"
  code=$(get "b-cwd" /commander/state "10-state-initial-b.json"); assert "b-cwd" "GET /commander/state (fresh)" "200" "$code"
  WS_COUNT_B=$(node -e "try{console.log((require('$ART/10-state-initial-b.json').workspaces||[]).length)}catch{console.log(-1)}")
  record "## [b-cwd] fresh workspaces.count=$WS_COUNT_B (预期 0，走 cwd-only 分支)"
  BIND_CODE=$(post "b-cwd" /commander/binding "{\"mode\":\"new\",\"cwd\":\"$ROOT_B\",\"requestId\":\"req_bind_smoke_cwd_1\"}" "12-binding-cwd.json")
  record "## [b-cwd] binding body=$(cat "$ART/12-binding-cwd.json")"
  assert "b-cwd" "binding mode=new + cwd → 200" "200" "$BIND_CODE"
  assert_in "b-cwd" "binding has sessionId" "$(cat "$ART/12-binding-cwd.json")" '"sessionId"'
  assert_in "b-cwd" "commanderStatus bound" "$(cat "$ART/12-binding-cwd.json")" '"commanderStatus":"bound"'
  SID_B=$(node -e "try{const j=require('$ART/12-binding-cwd.json');console.log(j.binding?.sessionId ?? '')}catch{console.log('')}")
  verify_message_path "b-cwd" "$SID_B"
  stop_host
fi

# ================================================================ 收尾
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-post.txt" >/dev/null 2>&1 || true
if diff <(grep -v '^#' "$ART/live-pre.txt" 2>/dev/null) <(grep -v '^#' "$ART/live-post.txt" 2>/dev/null) > "$ART/live-state-diff.txt" 2>&1; then
  record "## LIVE-STATE: identical except timestamp header"; log "live-state identical"
else
  record "## LIVE-STATE: DIFF DETECTED"; log "LIVE-STATE: DIFF DETECTED"
fi

if [ "$FAILED" -eq 0 ]; then record "## RESULT: PASS"; log "PASS (artifacts: $ART)"; exit 0; fi
record "## RESULT: FAIL"; log "FAIL (artifacts: $ART)"; exit 1
