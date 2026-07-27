import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

const HTTP_URL_PATTERN = /^https?:\/\/[^\s]+$/i
const ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
]

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false
})

markdown.validateLink = isAllowedExternalUrl
markdown.renderer.rules.image = (tokens, index) => {
  const description = markdown.utils.escapeHtml(tokens[index].content || '未描述图片')
  return `<span class="markdown-image-placeholder">[图片：${description}]</span>`
}
markdown.renderer.rules.table_open = () => '<div class="markdown-table-scroll"><table>'
markdown.renderer.rules.table_close = () => '</table></div>'

/** 将不可信的助手 Markdown 转为经过白名单清洗的 HTML。 */
export function renderAssistantMarkdown(source: string): string {
  const rendered = markdown.render(source)
  return DOMPurify.sanitize(rendered, {
    ALLOWED_ATTR: ['class', 'href', 'title'],
    ALLOWED_TAGS,
    ALLOWED_URI_REGEXP: HTTP_URL_PATTERN,
    ALLOW_DATA_ATTR: false
  })
}

/** 把助手 Markdown 安全写入指定气泡节点。 */
export function renderAssistantMarkdownInto(element: HTMLElement, source: string): void {
  element.innerHTML = renderAssistantMarkdown(source)
}

/** 仅允许可交给 Main 进程打开的 HTTP(S) 绝对地址。 */
function isAllowedExternalUrl(value: string): boolean {
  if (!HTTP_URL_PATTERN.test(value)) {
    return false
  }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
