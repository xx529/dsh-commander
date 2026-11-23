// 原生壳窗口页入口：普通浏览器 bundle（非 DSH module loader 格式），由 Host 内联返回。
import { createRoot } from 'react-dom/client'
import { WindowApp } from './WindowApp'
import { WINDOW_STYLES } from './window-styles'
import { STYLES } from './styles'

function mount(): void {
  const style = document.createElement('style')
  style.dataset.commander = 'native-window'
  style.textContent = WINDOW_STYLES
  document.head.appendChild(style)
  // 复用 DSH 页内组件的样式（派发确认卡等）。窗口页自己的 .dshcn-* 规则优先级更高。
  const shared = document.createElement('style')
  shared.dataset.commander = 'shared-components'
  shared.textContent = STYLES
  document.head.appendChild(shared)
  const container = document.getElementById('root')
  if (container === null) {
    console.error('[commander-window] #root is missing')
    return
  }
  createRoot(container).render(<WindowApp />)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true })
} else {
  mount()
}
