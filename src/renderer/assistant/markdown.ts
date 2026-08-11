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
  enhanceCodeBlocks(element)
}

/** 为代码块补充语言标识和复制入口，按钮事件由对话区统一处理。 */
function enhanceCodeBlocks(element: HTMLElement): void {
  element.querySelectorAll<HTMLPreElement>('pre').forEach((pre) => {
    const code = pre.querySelector<HTMLElement>(':scope > code')
    if (!code) {
      return
    }

    const block = document.createElement('div')
    block.className = 'markdown-code-block'
    const toolbar = document.createElement('div')
    toolbar.className = 'markdown-code-toolbar'
    const language = document.createElement('span')
    language.className = 'markdown-code-language'
    language.textContent = getCodeLanguage(code)
    const copyButton = document.createElement('button')
    copyButton.type = 'button'
    copyButton.className = 'markdown-code-copy'
    copyButton.title = '复制代码'
    copyButton.setAttribute('aria-label', '复制代码')
    copyButton.textContent = '复制'

    pre.before(block)
    toolbar.append(language, copyButton)
    block.append(toolbar, pre)
  })
}

/** 从 MarkdownIt 生成的语言类名中提取展示名称。 */
function getCodeLanguage(code: HTMLElement): string {
  const languageClass = [...code.classList].find((name) => name.startsWith('language-'))
  return languageClass?.slice('language-'.length) || '代码'
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
