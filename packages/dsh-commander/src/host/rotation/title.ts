// R1：换任标题（纯函数）。口径：docs/architecture/rotation-contract-patch.md §5.4。
/**
 * 换任后新会话的标题：`第 N 任 · YYYY-MM-DD`。
 * 日期取**本机时区**的换任当天，N 为换任后的新代际（旧任 + 1）。
 * 纯函数：同一 `(generation, at)` 恒等，便于测试与重放。
 */
export function rotationTitle(generation: number, at: number): string {
  const date = new Date(at)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `第 ${generation} 任 · ${year}-${month}-${day}`
}
