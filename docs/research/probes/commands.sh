#!/bin/bash
# scout 探针配方（V0）—— 复制粘贴可复现。全部写入只在 /tmp 与工作区。
# 前提：全局 dsh = 0.2.2-rc.2（~/.local/bin/dsh，node v24.19.0 shim）。
# 安全：不写 ~/.dsh、不读 ~/.dsh/.env、不重启 live Desktop。
set -euo pipefail

REPO="/Users/lzx/Documents/GitHub/dsh-commander"
PROBE="/tmp/dsh-commander-probe"
CLI="/Users/lzx/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh"
export DSH_HOME="$PROBE/home"
export DSH_AGENTS_HOME="$PROBE/agents"
mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$PROBE/evidence"

# ---------- 0) live 基线（探针前后比对，只读） ----------
live_snapshot() {
  {
    echo "## git status"; git -C "$REPO" status --porcelain
    echo "## desktop tree hash"
    find ~/.dsh/profiles/desktop -maxdepth 2 \( -name node_modules -prune \) -o -print 2>/dev/null \
      | sort | while read -r f; do stat -f '%N|%z|%m' "$f"; done | shasum -a 256
    echo "## .env stat (no content)"; stat -f '%N|%z|%m' ~/.dsh/.env
  }
}
live_snapshot > "$REPO/docs/research/probes/pre-state.txt"

# ---------- 1) 最小 Host（base 模板） ----------
dsh plugin --profile scout version-exemptions            # 输出 {}，退出码 0
mkdir -p "$DSH_HOME/profiles/scout/node_modules"
ln -sfn ~/.dsh/profiles/desktop/node_modules/dsh-capability-settings \
        "$DSH_HOME/profiles/scout/node_modules/dsh-capability-settings"
node -e '
const fs=require("fs");const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.dsh.profile.bundles=["@deepseek-ai/dsh-base","dsh-capability-settings"];
fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' "$DSH_HOME/profiles/scout/package.json"

# 先 boot-free 验证 patch 合成
dsh --profile scout --patch "$REPO/docs/research/probes/probe.patch.yml" --dump-config \
  > "$PROBE/evidence/dump-config.yml"
grep -A4 scout-probe "$PROBE/evidence/dump-config.yml"

# 启动（探针插件写证据后 appExit(0)，~2s）
JEV_API_KEY=probe-synthetic-not-a-real-key \
  dsh --profile scout --patch "$REPO/docs/research/probes/probe.patch.yml" \
  > "$PROBE/evidence/boot-base.out" 2> "$PROBE/evidence/boot-base.err"
cat "$PROBE/evidence/plugin-boot.json"

# ---------- 2) web Host（带 HTTP/UI，随机端口，常驻） ----------
mkdir -p "$DSH_HOME/profiles/web/node_modules/@deepseek-ai"
ln -sfn "$CLI/node_modules/@deepseek-ai/dsh-client-ui-chat" \
        "$DSH_HOME/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-chat"
dsh --profile web --port 0 --no-open > "$PROBE/evidence/boot-web.out" 2> "$PROBE/evidence/boot-web.err" &
WEB_PID=$!
for _ in $(seq 1 40); do
  URL=$(grep -o 'http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$PROBE/evidence/boot-web.out" 2>/dev/null | head -1 || true)
  [ -n "${URL:-}" ] && break; sleep 0.5
done
echo "web URL: ${URL:-<none>}"
JAR="$PROBE/evidence/cookies.txt"
curl -sL -c "$JAR" -b "$JAR" -o "$PROBE/evidence/web-index.html" \
     -w 'index: HTTP %{http_code} size=%{size_download}\n' "$URL"
kill "$WEB_PID" 2>/dev/null || true; wait "$WEB_PID" 2>/dev/null || true

# ---------- 3) V3 链路（sessionController.create + 面板真实 apply） ----------
dsh --profile webtest --from-default-profile web --dump-default-config > /dev/null
ln -sfn ~/.dsh/profiles/desktop/node_modules/dsh-capability-settings \
        "$DSH_HOME/profiles/webtest/node_modules/dsh-capability-settings" 2>/dev/null || {
  mkdir -p "$DSH_HOME/profiles/webtest/node_modules"
  ln -sfn ~/.dsh/profiles/desktop/node_modules/dsh-capability-settings \
          "$DSH_HOME/profiles/webtest/node_modules/dsh-capability-settings"; }
JEV_API_KEY=probe-synthetic-not-a-real-key \
  dsh --profile webtest --patch "$REPO/docs/research/probes/probe.v3.patch.yml" --port 0 --no-open \
  > "$PROBE/evidence/boot-v3.out" 2> "$PROBE/evidence/boot-v3.err"
cat "$PROBE/evidence/v3.json"
cat "$DSH_HOME/dsh-capability-settings/session-capabilities.json"

# ---------- 4) V5 数据源盘点（只读，不输出正文） ----------
node "$REPO/docs/research/probes/inventory-v5-data.mjs" --home ~/.dsh \
     --out "$PROBE/evidence/data-inventory.json"
node "$REPO/docs/research/probes/read-session-log.mjs" \
     "/Users/lzx/.dsh/sessions/--Users-lzx-.dsh--/0ad76f8d-4748-4df3-a466-783be7881ced/session.v4.jsonl.zstd" --events

# ---------- 5) live 后置基线 ----------
live_snapshot > "$REPO/docs/research/probes/post-state.txt"
diff <(grep -v '^#' "$REPO/docs/research/probes/pre-state.txt") \
     <(grep -v '^#' "$REPO/docs/research/probes/post-state.txt") && echo "live 状态未变（除新增 docs）"
