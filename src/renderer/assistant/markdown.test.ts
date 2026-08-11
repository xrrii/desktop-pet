// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { renderAssistantMarkdown, renderAssistantMarkdownInto } from './markdown'

describe('助手 Markdown 渲染', () => {
  it('渲染常用 Markdown 结构', () => {
    const html = renderAssistantMarkdown([
      '## 配置说明',
      '',
      '**重点**与`行内代码`',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '```yaml',
      'enabled: true',
      '```',
      '',
      '| 名称 | 状态 |',
      '| --- | --- |',
      '| 服务 | 正常 |'
    ].join('\n'))

    expect(html).toContain('<h2>配置说明</h2>')
    expect(html).toContain('<strong>重点</strong>')
    expect(html).toContain('<code>行内代码</code>')
    expect(html).toContain('<pre><code class="language-yaml">enabled: true')
    expect(html).toContain('class="markdown-table-scroll"')
  })

  it('不执行内嵌 HTML、事件属性和危险协议', () => {
    const html = renderAssistantMarkdown([
      '<img src=x onerror="alert(1)">',
      '',
      '[危险链接](javascript:alert(1))',
      '',
      '[本地文件](file:///C:/secret.txt)'
    ].join('\n'))

    const container = document.createElement('div')
    container.innerHTML = html

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(container.querySelector('a[href^="file:"]')).toBeNull()
  })

  it('保留安全外链并阻止远程图片请求', () => {
    const html = renderAssistantMarkdown([
      '[官方网站](https://example.com/docs)',
      '',
      '![架构图](https://example.com/architecture.png)'
    ].join('\n'))

    expect(html).toContain('href="https://example.com/docs"')
    expect(html).not.toContain('<img')
    expect(html).toContain('[图片：架构图]')
  })

  it('流式分片拼接后可以形成完整代码块', () => {
    const fragments = ['```ya', 'ml\nenabled:', ' true\n```']
    const html = renderAssistantMarkdown(fragments.join(''))

    expect(html).toContain('class="language-yaml"')
    expect(html).toContain('enabled: true')
  })

  it('为代码块补充语言标识和复制按钮', () => {
    const container = document.createElement('div')

    renderAssistantMarkdownInto(container, '```typescript\nconst enabled = true\n```')

    const block = container.querySelector('.markdown-code-block')
    const button = block?.querySelector<HTMLButtonElement>('.markdown-code-copy')
    expect(block?.querySelector('.markdown-code-language')?.textContent).toBe('typescript')
    expect(block?.querySelector('code')?.textContent).toBe('const enabled = true\n')
    expect(button?.type).toBe('button')
    expect(button?.textContent).toBe('复制')
    expect(button?.getAttribute('aria-label')).toBe('复制代码')
  })
})
