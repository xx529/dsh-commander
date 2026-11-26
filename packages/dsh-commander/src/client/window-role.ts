// 窗口角色（契约 native-shell-contract.md §5）：壳内球窗口、面板窗口、气泡窗口各加载一份窗口页。
// 无角色（浏览器直接打开 / 旧同窗两态）时保持 expanded 决定渲染。
export type WindowRole = '' | 'ball' | 'panel' | 'bubble'

/** 只接受 ball/panel/bubble；未知值回落成空角色（同窗两态）。 */
export function resolveWindowRole(raw: unknown): WindowRole {
  return raw === 'ball' || raw === 'panel' || raw === 'bubble' ? raw : ''
}

/** 渲染面板还是球：面板窗口恒面板、球窗口恒球；气泡窗口与空角色不渲染面板。 */
export function showsPanel(role: WindowRole, expanded: boolean): boolean {
  if (role === 'panel') return true
  if (role === 'ball' || role === 'bubble') return false
  return expanded
}
