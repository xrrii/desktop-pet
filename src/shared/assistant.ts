export const ASSISTANT_PROTOCOL_VERSION = 1 as const

export type AssistantSource = 'pet' | 'assistant-window' | 'shortcut'
export type ToolRisk = 'safe' | 'confirm' | 'dangerous'
export type AssistantRuntimeState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed'
export type AssistantBackend = 'mock' | 'langchain'
export type AssistantDockSide = 'left' | 'right'

export interface AssistantWindowLayout {
  revision: number
  expanded: boolean
  side: AssistantDockSide
  pet: LayoutRectangle
  panel: LayoutRectangle
}

export interface LayoutRectangle {
  x: number
  y: number
  width: number
  height: number
}

export type AssistantLayoutTracePhase =
  | 'double-click'
  | 'layout-applied'
  | 'frame-1'
  | 'frame-2'

export interface AssistantLayoutTrace {
  phase: AssistantLayoutTracePhase
  revision: number | null
  viewport: { width: number; height: number }
  pet: LayoutRectangle
}

export interface AssistantRuntimeStatus {
  state: AssistantRuntimeState
  backend: AssistantBackend | null
  error: string | null
}

export interface AssistantAskInput {
  input: string
  conversationId: string
}

export interface AssistantAskResult {
  taskId: string
}

export interface AssistantRuntimeReady {
  type: 'ready'
  protocolVersion: typeof ASSISTANT_PROTOCOL_VERSION
  port: number
  pid: number
  backend: AssistantBackend
}

export interface AssistantRequest {
  protocolVersion: typeof ASSISTANT_PROTOCOL_VERSION
  taskId: string
  conversationId: string
  input: string
  source: AssistantSource
  context: {
    activePetId: string
    locale: string
    timezone: string
  }
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
  risk: ToolRisk
  preview: string
}

export type AssistantEvent =
  | AssistantMessageDeltaEvent
  | AssistantToolCallEvent
  | AssistantPermissionRequiredEvent
  | AssistantToolResultEvent
  | AssistantDoneEvent
  | AssistantErrorEvent

interface AssistantEventBase {
  protocolVersion: typeof ASSISTANT_PROTOCOL_VERSION
  taskId: string
  sequence: number
}

export interface AssistantMessageDeltaEvent extends AssistantEventBase {
  type: 'message_delta'
  payload: {
    delta: string
  }
}

export interface AssistantToolCallEvent extends AssistantEventBase {
  type: 'tool_call'
  payload: ToolCall
}

export interface AssistantPermissionRequiredEvent extends AssistantEventBase {
  type: 'permission_required'
  payload: ToolCall
}

export interface AssistantToolResultEvent extends AssistantEventBase {
  type: 'tool_result'
  payload: {
    toolCallId: string
    ok: boolean
    result?: unknown
    error?: string
  }
}

export interface AssistantDoneEvent extends AssistantEventBase {
  type: 'done'
  payload: {
    finishReason: 'stop' | 'cancelled' | 'error'
  }
}

export interface AssistantErrorEvent extends AssistantEventBase {
  type: 'error'
  payload: {
    code: string
    message: string
    retryable: boolean
  }
}
