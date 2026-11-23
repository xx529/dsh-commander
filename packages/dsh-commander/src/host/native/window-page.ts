// 窗口页：一次性 token + 内联窗口 bundle（契约 §5）。
// 生产路径：从 lib/window.js 读取；测试可注入 readBundle。
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

export interface WindowPageOptions {
  /** 返回窗口 bundle 源码；默认读构建产物 lib/window.js。 */
  readBundle?: () => string
  /** 固定 token（测试用）；缺省每次创建随机 32 hex。 */
  token?: string
  locale?: 'zh' | 'en'
}

export interface WindowPage {
  readonly token: string
  /** token 不匹配返回 null（路由层转 404）。 */
  html(requestUrl: string): string | null
}

/** 默认读取包内 lib/window.js（源码树/安装树相对 lib/host/native 都是 ../../window.js）。 */
function defaultReadBundle(): string {
  return readFileSync(new URL('../../window.js', import.meta.url), 'utf8')
}

/**
 * 创建窗口页渲染器。
 * @param options - bundle 读取器、固定 token、语言。
 */
export function createWindowPage(options: WindowPageOptions = {}): WindowPage {
  const token = options.token ?? randomBytes(16).toString('hex')
  const readBundle = options.readBundle ?? defaultReadBundle
  const locale = options.locale ?? 'zh'
  let bundle: string | undefined
  const cache = new Map<string, string>()
  return {
    token,
    html(requestUrl: string): string | null {
      const query = requestUrl.indexOf('?')
      const params = new URLSearchParams(query >= 0 ? requestUrl.slice(query + 1) : '')
      if (params.get('token') !== token) return null
      // `panel=1` 仅用于无头截图/调试：直接以面板态渲染。
      const panel = params.get('panel') === '1'
      const session = params.get('session') ?? ''
      const key = `${panel ? 1 : 0}:${session}`
      const hit = cache.get(key)
      if (hit !== undefined) return hit
      bundle ??= readBundle()
      const html = render(bundle, token, locale, panel, session)
      cache.set(key, html)
      return html
    },
  }
}

function render(bundle: string, token: string, locale: 'zh' | 'en', panel: boolean, session: string): string {
  // 内联 bundle 时防止提前闭合 <script>。
  const safeBundle = bundle.replaceAll('</script', '<\\/script')
  const boot = JSON.stringify({ token, locale, panel, session })
  const diagnostics = `<script>
window.addEventListener('error', function (event) {
  try { fetch('/commander/window-error?message=' + encodeURIComponent(String(event.message) + ' @' + (event.filename || '') + ':' + (event.lineno || 0))).catch(function () {}); } catch (_) {}
});
window.addEventListener('unhandledrejection', function (event) {
  try { fetch('/commander/window-error?message=' + encodeURIComponent('rejection: ' + String(event.reason))).catch(function () {}); } catch (_) {}
});
setTimeout(function () {
  var root = document.getElementById('root');
  if (root && root.childElementCount === 0) {
    var ball = document.createElement('button');
    ball.id = '__fallback_ball';
    ball.textContent = '⚑';
    ball.addEventListener('click', function () {
      try {
        if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
          window.__TAURI__.core.invoke('set_mode', { mode: 'panel' }).catch(function () {});
        }
      } catch (_) {}
      ball.style.display = 'none';
    });
    document.body.appendChild(ball);
  }
}, 3000);
</script>
<style>
#__fallback_ball {
  position: fixed; right: 16px; bottom: 16px; width: 48px; height: 48px;
  border: 0; border-radius: 50%; color: #fff; font: 600 20px -apple-system, sans-serif;
  background: radial-gradient(circle at 32% 28%, #4f8bff, #1f63eb 62%, #1748b8);
  box-shadow: 0 6px 18px rgba(15, 40, 100, 0.45); cursor: pointer; z-index: 2147483647;
}
</style>`
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Commander</title>
<style>html,body,#root{width:100%;height:100%;margin:0;padding:0;background:transparent;overflow:hidden}</style>
</head>
<body>
<div id="root"></div>
${diagnostics}
<script>window.__COMMANDER_SHELL__ = ${boot};</script>
<script>${safeBundle}</script>
</body>
</html>`
}
