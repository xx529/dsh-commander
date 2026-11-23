#!/usr/bin/env node
/**
 * Run both Client bundle harnesses against the built `lib/client.js`:
 *   1. smoke.mjs    — fake module loader + react-dom/server: loader id, exports,
 *                     slot registrations/inject faces, SSR render of ball + settings.
 *   2. interact.mjs — jsdom: click ball → open panel → type → Enter/click send →
 *                     assistant reply renders → Escape closes; settings mounts,
 *                     loads config, saves workspaces.
 *
 * Optional runtime deps (react, react-dom, jsdom) are resolved from
 * `DSH_COMMANDER_HARNESS_MODULES` or from the package node_modules — they are
 * intentionally NOT Client dependencies (the shipped bundle keeps zero runtime
 * dependencies; see README.md).
 *
 * Usage:
 *   pnpm --filter dsh-commander build:client
 *   DSH_COMMANDER_HARNESS_MODULES=<dir-with-node_modules> \
 *     node packages/dsh-commander/tests/client/harness/run-harness.mjs [lib/client.js]
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = process.argv[2] ?? resolve(here, '../../../lib/client.js')
const modules = process.env.DSH_COMMANDER_HARNESS_MODULES
const env = {
  ...process.env,
  ...(modules === undefined || modules === '' ? {} : { DSH_COMMANDER_HARNESS_MODULES: resolve(modules) }),
}

let failed = 0
for (const script of ['smoke.mjs', 'interact.mjs']) {
  console.log(`\n== ${script} (client=${clientPath})`)
  const result = spawnSync(process.execPath, [resolve(here, script), clientPath], { env, stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}

console.log(failed === 0 ? '\n[harness] PASS (smoke + interact)' : `\n[harness] FAIL (${failed} script(s))`)
process.exit(failed === 0 ? 0 : 1)
