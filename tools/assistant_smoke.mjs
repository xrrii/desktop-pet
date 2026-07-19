import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configuredExecutable = process.env.PETDOCK_SMOKE_EXECUTABLE?.trim()
const devMode = !configuredExecutable && process.env.PETDOCK_SMOKE_DEV === '1'
const electronPath = configuredExecutable
  ? resolve(projectRoot, configuredExecutable)
  : join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const electronViteCli = join(projectRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const pythonPath = join(projectRoot, 'python-runtime', '.venv', 'Scripts', 'python.exe')
const screenshotPath = resolve(
  projectRoot,
  process.env.PETDOCK_SMOKE_SCREENSHOT || 'outputs/assistant-stage1.png'
)
const screenshotParts = parse(screenshotPath)
const rightScreenshotPath = join(
  screenshotParts.dir,
  `${screenshotParts.name}-right${screenshotParts.ext}`
)
const backend = process.env.PETDOCK_SMOKE_BACKEND === 'langchain' ? 'langchain' : 'mock'
const expectedResponse = backend === 'langchain' ? '本地模型适配测试通过' : '离线模式回应'
let child

async function main() {
  const port = await getAvailablePort()
  const fakeModel = backend === 'langchain' ? await startFakeModelServer() : null
  const launchCommand = devMode ? process.execPath : electronPath
  const launchArgs = configuredExecutable
    ? [`--remote-debugging-port=${port}`]
    : devMode
      ? [electronViteCli, 'dev', '--remoteDebuggingPort', String(port)]
      : [`--remote-debugging-port=${port}`, projectRoot]
  const environment = {
    ...process.env,
    PETDOCK_ASSISTANT_BACKEND: backend
  }
  if (fakeModel) {
    environment.PETDOCK_LLM_API_KEY = 'local-smoke-key'
    environment.PETDOCK_LLM_BASE_URL = `http://127.0.0.1:${fakeModel.port}/v1`
    environment.PETDOCK_LLM_MODEL = 'petdock-smoke-model'
  }
  if (!configuredExecutable) {
    environment.PETDOCK_PYTHON = pythonPath
  }

  child = spawn(launchCommand, launchArgs, {
    cwd: configuredExecutable ? dirname(electronPath) : projectRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  let processOutput = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    processOutput += chunk
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    processOutput += chunk
  })

  let petClient
  let originalPetPosition

  try {
    const petTarget = await waitForTarget(port, (target) => target.title === 'Desktop Pet')
    petClient = await CdpClient.connect(petTarget.webSocketDebuggerUrl)
    await petClient.send('Runtime.enable')
    await petClient.send('Page.enable')
    await waitForEvaluation(
      petClient,
      `(() => {
        const pet = document.querySelector('#pet-root')?.getBoundingClientRect()
        return document.readyState === 'complete' && getComputedStyle(document.body).margin === '0px' &&
          !!pet && pet.x === 0 && pet.y === 0 && pet.width > 0 && pet.height > 0
      })()`,
      (value) => value === true,
      5_000
    )
    originalPetPosition = await evaluate(
      petClient,
      'window.desktopPet.getWindowPosition()',
      true
    )
    await movePetToHorizontalEdge(petClient, 'right', originalPetPosition.y)
    await openAssistantWithTrace(petClient)
    await assertNoExpandedTopLeftFlash(petClient)

    await waitForEvaluation(
      petClient,
      'document.body.dataset.assistantOpen',
      (value) => value === 'true',
      5_000
    )
    await waitForExpandedWindow(petClient)
    await assertAssistantLayout(petClient, 'left')

    await submitMessage(petClient, '阶段一冒烟测试')
    const conversationText = await waitForEvaluation(
      petClient,
      `document.querySelector('#conversation').innerText`,
      (value) => typeof value === 'string' && value.includes(expectedResponse),
      15_000
    )
    const statusText = await evaluate(
      petClient,
      `document.querySelector('#runtime-status-text').textContent`
    )
    const screenshot = await petClient.send('Page.captureScreenshot', { format: 'png' })
    await mkdir(dirname(screenshotPath), { recursive: true })
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))

    const expectedStatus = backend === 'langchain' ? '在线' : '离线模式'
    if (!conversationText.includes('阶段一冒烟测试') || statusText !== expectedStatus) {
      throw new Error('Assistant UI did not reach the expected completed state.')
    }

    if (backend === 'mock') {
      await evaluate(petClient, `document.querySelector('#new-conversation').click()`)
      await submitMessage(petClient, '请生成一段需要较长时间完成的取消测试内容')
      await delay(100)
      await evaluate(petClient, `document.querySelector('#stop-button').click()`)
      await waitForEvaluation(
        petClient,
        `document.querySelector('#send-button').hidden`,
        (value) => value === false,
        5_000
      )
      const cancelledText = await evaluate(
        petClient,
        `document.querySelector('.message.assistant:last-of-type .message-body').textContent`
      )
      if (cancelledText.includes('当前没有配置模型服务')) {
        throw new Error('Assistant cancellation did not interrupt the stream.')
      }
      await assertConversationWheelScroll(petClient)
    }

    await movePetToHorizontalEdge(petClient, 'left', originalPetPosition.y)
    await waitForEvaluation(
      petClient,
      'document.body.dataset.side',
      (value) => value === 'right',
      5_000
    )
    await waitForExpandedWindow(petClient)
    await assertAssistantLayout(petClient, 'right')
    await delay(300)
    const rightScreenshot = await petClient.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(rightScreenshotPath, Buffer.from(rightScreenshot.data, 'base64'))

    await restorePetPosition(petClient, originalPetPosition)

    await evaluate(petClient, `document.querySelector('#close-button').click()`)
    await waitForEvaluation(
      petClient,
      'document.body.dataset.assistantOpen',
      (value) => value === 'false',
      5_000
    )
    const collapsed = await evaluate(
      petClient,
      `(() => ({
        panelHidden: document.querySelector('#assistant-panel').hidden,
        petRect: document.querySelector('#pet-root').getBoundingClientRect().toJSON(),
        viewport: { width: innerWidth, height: innerHeight }
      }))()`
    )
    if (
      !collapsed.panelHidden ||
      Math.abs(collapsed.viewport.width - collapsed.petRect.width) > 3 ||
      Math.abs(collapsed.viewport.height - collapsed.petRect.height) > 3
    ) {
      throw new Error(`Assistant did not collapse to the pet bounds: ${JSON.stringify(collapsed)}`)
    }
    await waitForTarget(port, (target) => target.title === 'Desktop Pet')

    process.stdout.write(`ASSISTANT_SMOKE_OK\n${screenshotPath}\n${rightScreenshotPath}\n`)
  } catch (error) {
    const details = processOutput.trim() ? `\nElectron output:\n${processOutput.trim()}` : ''
    throw new Error(`${error instanceof Error ? error.message : String(error)}${details}`)
  } finally {
    if (petClient) {
      if (originalPetPosition) {
        await restorePetPosition(petClient, originalPetPosition).catch(() => undefined)
      }
      await evaluate(petClient, 'window.desktopPet.quit()', true).catch(() => undefined)
      petClient.close()
    }
    const exited = await waitForExit(child, 5_000)
    if (!exited) {
      child.kill()
    }
    await fakeModel?.close()
  }
}

async function assertConversationWheelScroll(client) {
  const scrollState = await evaluate(
    client,
    `(() => {
      const conversation = document.querySelector('#conversation')
      for (let index = 0; index < 24; index += 1) {
        const message = document.createElement('article')
        message.className = 'message assistant wheel-test-message'
        const body = document.createElement('div')
        body.className = 'message-body'
        body.textContent = '滚轮历史消息测试 ' + index
        message.append(body)
        conversation.append(message)
      }
      conversation.scrollTop = conversation.scrollHeight
      const rect = conversation.getBoundingClientRect()
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        before: conversation.scrollTop,
        max: conversation.scrollHeight - conversation.clientHeight
      }
    })()`
  )
  if (scrollState.max <= 0 || scrollState.before <= 0) {
    throw new Error(`Conversation did not become scrollable: ${JSON.stringify(scrollState)}`)
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: scrollState.x,
    y: scrollState.y,
    deltaX: 0,
    deltaY: -600
  })
  await waitForEvaluation(
    client,
    `document.querySelector('#conversation').scrollTop`,
    (value) => typeof value === 'number' && value < scrollState.before,
    5_000
  )
  await evaluate(
    client,
    `document.querySelectorAll('.wheel-test-message').forEach((message) => message.remove())`
  )
}

function openAssistantWithTrace(client) {
  return evaluate(
    client,
    `(() => {
      const pet = document.querySelector('#pet-root').getBoundingClientRect()
      window.desktopPet.traceAssistantLayout({
        phase: 'double-click',
        revision: null,
        viewport: { width: innerWidth, height: innerHeight },
        pet: { x: pet.x, y: pet.y, width: pet.width, height: pet.height }
      })
      return window.desktopPet.openAssistant()
    })()`,
    true
  )
}

async function assertNoExpandedTopLeftFlash(client) {
  const deadline = Date.now() + 180
  while (Date.now() < deadline) {
    const sample = await evaluate(
      client,
      `(() => {
        const pet = document.querySelector('#pet-root').getBoundingClientRect()
        return { viewportWidth: innerWidth, petWidth: pet.width, petX: pet.x }
      })()`
    )
    if (sample.viewportWidth > sample.petWidth + 100 && sample.petX < 100) {
      throw new Error(`Pet flashed at the expanded window origin: ${JSON.stringify(sample)}`)
    }
    await delay(4)
  }
}

function waitForExpandedWindow(client) {
  return waitForEvaluation(
    client,
    `(() => {
      const pet = document.querySelector('#pet-root').getBoundingClientRect()
      const panel = document.querySelector('#assistant-panel').getBoundingClientRect()
      return pet.right <= innerWidth + 1 && pet.bottom <= innerHeight + 1 &&
        panel.right <= innerWidth + 1 && panel.bottom <= innerHeight + 1
    })()`,
    (value) => value === true,
    5_000
  )
}

async function assertAssistantLayout(client, side) {
  const layout = await evaluate(
    client,
    `(() => {
      const composer = document.querySelector('#composer')
      const style = getComputedStyle(composer)
      return {
        side: document.body.dataset.side,
        expanded: document.body.dataset.assistantOpen,
        display: style.display,
        animationName: style.animationName,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        rootBackground: getComputedStyle(document.documentElement).backgroundColor,
        petRect: document.querySelector('#pet-root').getBoundingClientRect().toJSON(),
        composerRect: composer.getBoundingClientRect().toJSON()
      }
    })()`
  )
  const expectedAnimation = side === 'left' ? 'reveal-from-right' : 'reveal-from-left'
  if (
    layout.side !== side ||
    layout.expanded !== 'true' ||
    layout.display !== 'grid' ||
    !layout.animationName.split(',').map((name) => name.trim()).includes(expectedAnimation) ||
    layout.bodyBackground !== 'rgba(0, 0, 0, 0)' ||
    layout.rootBackground !== 'rgba(0, 0, 0, 0)' ||
    Math.abs(layout.petRect.bottom - layout.composerRect.bottom) > 16
  ) {
    throw new Error(
      `Assistant ${side}-side layout or transparent CSS was not applied: ${JSON.stringify(layout)}`
    )
  }
}

function movePetToHorizontalEdge(client, edge, y) {
  const x = edge === 'left' ? -100_000 : 100_000
  return evaluate(client, `window.desktopPet.moveWindow(${x}, ${Math.round(y)})`, true)
}

function restorePetPosition(client, position) {
  return evaluate(
    client,
    `window.desktopPet.moveWindow(${Math.round(position.x)}, ${Math.round(position.y)})`,
    true
  )
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (message) => {
      const payload = JSON.parse(String(message.data))
      if (!payload.id) {
        return
      }
      const pending = this.pending.get(payload.id)
      if (!pending) {
        return
      }
      this.pending.delete(payload.id)
      if (payload.error) {
        pending.reject(new Error(payload.error.message))
      } else {
        pending.resolve(payload.result)
      }
    })
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolve(new CdpClient(socket)), { once: true })
      socket.addEventListener('error', () => reject(new Error('Unable to connect to Electron CDP.')), {
        once: true
      })
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.socket.close()
  }
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Electron evaluation failed.')
  }
  return result.result.value
}

async function waitForEvaluation(client, expression, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(client, expression)
    if (predicate(value)) {
      return value
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for evaluation: ${expression}`)
}

function submitMessage(client, message) {
  return evaluate(
    client,
    `(() => {
      const input = document.querySelector('#message-input')
      input.value = ${JSON.stringify(message)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('#composer').requestSubmit()
    })()`
  )
}

async function waitForTarget(port, predicate) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      const target = targets.find((candidate) => candidate.type === 'page' && predicate(candidate))
      if (target) {
        return target
      }
    } catch {
      // Electron has not opened the debugging endpoint yet.
    }
    if (child.exitCode !== null) {
      throw new Error(`Electron exited before opening a window (code=${child.exitCode}).`)
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for an Electron window.')
}

function getAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createTcpServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const selectedPort = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolvePort(selectedPort)))
    })
  })
}

async function startFakeModelServer() {
  const port = await getAvailablePort()
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }

    request.resume()
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    const chunks = ['本地', '模型', '适配', '测试', '通过', '。']
    let index = 0
    const timer = setInterval(() => {
      if (index < chunks.length) {
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-petdock-smoke',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'petdock-smoke-model',
            choices: [
              {
                index: 0,
                delta: index === 0 ? { role: 'assistant', content: chunks[index] } : { content: chunks[index] },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        index += 1
        return
      }
      clearInterval(timer)
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-petdock-smoke',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'petdock-smoke-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        })}\n\n`
      )
      response.end('data: [DONE]\n\n')
    }, 25)
    response.on('close', () => clearInterval(timer))
  })

  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolveListen)
  })
  return {
    port,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose()))
  }
}

function waitForExit(process, timeoutMs) {
  if (process.exitCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      process.removeListener('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolveExit(true)
    }
    process.once('exit', onExit)
  })
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

await main()
