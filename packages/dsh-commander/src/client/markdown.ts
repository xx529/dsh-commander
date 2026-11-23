/**
 * 指挥官对话的 Markdown 渲染：直接复用 Web 壳内置的 `MarkdownText`（普通会话 assistant
 * 消息用的同一个组件），所以标题/列表/表格/代码块/链接的样式与聊天区一致，不另造渲染器。
 */
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

export { MarkdownText }

/** 代码块工具栏/脚注文案 seat（与普通会话同构，文案走本插件 locale）。 */
export function markdownLabels(t: (key: string) => string): MarkdownLabels {
  return {
    code: {
      copyLabel: t('markdown.copy'),
      copiedLabel: t('markdown.copied'),
      toolbarLabels: {
        codeLabel: t('markdown.code'),
        wrapLabel: t('markdown.wrap'),
        unwrapLabel: t('markdown.unwrap'),
      },
    },
    footnotes: t('markdown.footnotes'),
  }
}
