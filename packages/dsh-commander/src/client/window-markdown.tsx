// 窗口页专用轻量 Markdown 渲染（无 DSH 依赖）：覆盖对话里常见的块级/行内语法，
// 包括标题、段落、有序/无序列表（含续行）、GFM 表格、代码块、引用、链接与行内标记。
import type { ReactNode } from 'react'

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/
const HEADING = /^(#{1,4})\s+(.*)$/
const FENCE = /^```([A-Za-z0-9_+-]*)\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/

/** 把 commander assistant 消息渲染为 Markdown。 */
export function WindowMarkdown({ text }: { text: string }): ReactNode {
  return <div className="dshcn-md">{parseBlocks(preprocess(text))}</div>
}

function preprocess(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    // 跨行链接 `[text](\n/url)` 合并成一行，避免 URL 泄漏成普通文本。
    .replace(/\]\s*\(\s*\n\s*/g, '](')
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function parseBlocks(input: string): ReactNode[] {
  const lines = input.split('\n')
  const nodes: ReactNode[] = []
  let index = 0
  let key = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }
    const fence = FENCE.exec(line.trim())
    if (fence !== null) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index]?.trim() ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      nodes.push(
        <pre key={key++} className="dshcn-md-pre" data-lang={fence[1] ?? ''}>
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = Math.min(4, heading[1]?.length ?? 1)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4'
      nodes.push(<Tag key={key++} className="dshcn-md-h">{inline(heading[2] ?? '', key)}</Tag>)
      index += 1
      continue
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      nodes.push(<hr key={key++} />)
      index += 1
      continue
    }
    // GFM 表格：当前行以 | 开头，下一行是分隔行。
    if (line.trimStart().startsWith('|') && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      const header = splitTableRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('|')) {
        rows.push(splitTableRow(lines[index] ?? ''))
        index += 1
      }
      nodes.push(
        <table key={key++} className="dshcn-md-table">
          <thead>
            <tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell, key + cellIndex)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell, key + rowIndex * 10 + cellIndex)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }
    if (line.trimStart().startsWith('>')) {
      const quoted: string[] = []
      while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('>')) {
        quoted.push((lines[index] ?? '').trimStart().slice(1).trim())
        index += 1
      }
      nodes.push(<blockquote key={key++}>{inline(quoted.join('\n'), key)}</blockquote>)
      continue
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items: string[][] = []
      while (index < lines.length) {
        const match = LIST_ITEM.exec(lines[index] ?? '')
        if (match !== null) {
          items.push([match[2] ?? ''])
          index += 1
          continue
        }
        // 续行（缩进 ≥2 空格）并入上一项。
        const current = lines[index] ?? ''
        if (items.length > 0 && /^\s{2,}\S/.test(current)) {
          items[items.length - 1]?.push(current.trim())
          index += 1
          continue
        }
        break
      }
      const Tag = ordered ? 'ol' : 'ul'
      nodes.push(
        <Tag key={key++} className="dshcn-md-list">
          {items.map((item, itemIndex) => <li key={itemIndex}>{inline(item.join(' '), key + itemIndex)}</li>)}
        </Tag>,
      )
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (
        current.trim() === ''
        || FENCE.test(current.trim())
        || HEADING.test(current)
        || LIST_ITEM.test(current)
        || current.trimStart().startsWith('>')
        || (current.trimStart().startsWith('|') && TABLE_SEPARATOR.test(lines[index + 1] ?? ''))
        || /^(-{3,}|\*{3,})\s*$/.test(current.trim())
      ) break
      paragraph.push(current)
      index += 1
    }
    nodes.push(<p key={key++} className="dshcn-md-p">{inline(paragraph.join('\n'), key)}</p>)
  }
  return nodes
}

function inline(text: string, seed: number): ReactNode[] {
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g
  const nodes: ReactNode[] = []
  let last = 0
  let key = seed * 1000
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) pushText(nodes, text.slice(last, match.index), key++)
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(<code key={key++} className="dshcn-md-code">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>)
    } else {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(token)
      if (link !== null && /^https?:\/\//i.test(link[2] ?? '')) {
        nodes.push(<a key={key++} href={link[2]} target="_blank" rel="noreferrer">{link[1] ?? ''}</a>)
      } else if (link !== null) {
        // 本地绝对路径不是可点击链接：只显示标题，避免长 URL 泄漏成一坨文本。
        pushText(nodes, link[1] ?? '', key++)
      } else {
        pushText(nodes, token, key++)
      }
    }
    last = match.index + token.length
  }
  if (last < text.length) pushText(nodes, text.slice(last), key++)
  return nodes
}

function pushText(nodes: ReactNode[], text: string, key: number): void {
  const parts = text.split('\n')
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(<br key={`${key}-br-${index}`} />)
    if (part.length > 0) nodes.push(part)
  })
}
