export const ASSISTANT_PROTOCOL_VERSION = 1 as const

export type AssistantSource = 'pet' | 'assistant-window' | 'shortcut'
export type ToolRisk = 'safe' | 'confirm' | 'dangerous'
export type ToolDecision = 'approved' | 'denied' | 'cancelled'
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

export type KnowledgeLibraryStatus = 'pending' | 'indexing' | 'paused' | 'ready' | 'error'

export interface AssistantKnowledgeSnapshot {
  libraries: AssistantKnowledgeLibrary[]
}

export interface AssistantKnowledgeLibrary {
  id: string
  name: string
  displayPath: string
  status: KnowledgeLibraryStatus
  documentCount: number
  chunkCount: number
  processedFiles: number
  totalFiles: number
  error: string | null
  createdAt: string
  updatedAt: string
  lastIndexedAt: string | null
}

export type AssistantEmbeddingProvider = 'hash' | 'local' | 'online'
export type AssistantEmbeddingModelStatus = 'not-installed' | 'downloading' | 'paused' | 'installed' | 'error'

export interface AssistantEmbeddingModelSnapshot {
  id: string
  displayName: string
  tier: 'light' | 'balanced' | 'quality'
  description: string
  downloadBytes: number
  downloadedBytes: number
  status: AssistantEmbeddingModelStatus
  error: string | null
}

export interface AssistantEmbeddingSnapshot {
  provider: AssistantEmbeddingProvider
  activeModelId: string | null
  online: {
    configured: boolean
    baseUrl: string
    model: string
    dimensions: number
  } | null
  models: AssistantEmbeddingModelSnapshot[]
}

export interface AssistantEmbeddingOnlineInput {
  baseUrl: string
  model: string
  dimensions: number
  apiKey: string
}

export interface AssistantRetrievalSource {
  id: string
  libraryId: string
  libraryName: string
  title: string
  relativePath: string
  excerpt: string
  score: number
}

export type MemoryClearScope = 'all' | 'conversations' | 'memories' | 'tool_logs'
export type MemoryItemKind = 'conversation' | 'memory' | 'app' | 'directory'

export interface AssistantMemorySnapshot {
  conversations: AssistantConversationSummary[]
  memories: AssistantMemorySummary[]
  candidates: AssistantMemoryCandidateSummary[]
  apps: AssistantAppSummary[]
  directories: AssistantDirectorySummary[]
  toolLogs: AssistantToolLogSummary[]
}

export interface AssistantMemoryCandidateSummary {
  id: number
  kind: 'preference'
  content: string
  confidence: number
  reason: string
  createdAt: string
}

export interface AssistantConversationSummary {
  id: string
  title: string
  preview: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface AssistantConversationMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface AssistantMemorySummary {
  id: number
  kind: 'preference'
  value: string
  source: string
  createdAt: string
  updatedAt: string
}

export interface AssistantAppSummary {
  appId: string
  displayName: string
  useCount: number
  lastUsedAt: string
}

export interface AssistantDirectorySummary {
  id: string
  displayPath: string
  useCount: number
  lastUsedAt: string
}

export interface AssistantToolLogSummary {
  id: number
  toolName: string
  risk: string
  policyDecision: string
  userDecision: string | null
  ok: boolean | null
  error: string | null
  durationMs: number | null
  createdAt: string
}

export interface AssistantPermissionResolution {
  taskId: string
  toolCallId: string
  decision: Extract<ToolDecision, 'approved' | 'denied'>
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
  knowledgeLibraryIds: string[]
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
  risk: ToolRisk
  preview: string
}

export interface AssistantToolResultRequest {
  protocolVersion: typeof ASSISTANT_PROTOCOL_VERSION
  taskId: string
  toolCallId: string
  decision: ToolDecision
  result?: unknown
  error?: string
}

export type AssistantEvent =
  | AssistantMessageDeltaEvent
  | AssistantRetrievalSourcesEvent
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

export interface AssistantRetrievalSourcesEvent extends AssistantEventBase {
  type: 'retrieval_sources'
  payload: {
    sources: AssistantRetrievalSource[]
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
