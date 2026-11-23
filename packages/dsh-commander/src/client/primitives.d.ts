/**
 * `@deepseek-ai/dsh-client-ui-primitives` 由 Web 壳的静态模块表提供（React 同级 seed，
 * 服务端不发布类型），这里只声明本插件用到的 Markdown 渲染面；实现与普通会话 assistant
 * 消息共用（`MarkdownText`），所以样式/功能与聊天区一致。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react'

  export interface MarkdownLabels {
    code: {
      copyLabel: string
      copiedLabel: string
      toolbarLabels: { codeLabel: string; wrapLabel: string; unwrapLabel: string }
    }
    footnotes: string
  }

  export interface MarkdownTextProps {
    text: string
    streaming?: boolean
    labels: MarkdownLabels
    variant?: 'body' | 'compact'
    omitHtml?: boolean
    textInteractionSource?: boolean
  }

  /** 普通会话 assistant 文本的 Markdown 渲染器。 */
  export const MarkdownText: ComponentType<MarkdownTextProps>
}
