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
  skillId?: string
  attachmentIds?: string[]
}

export interface AssistantAskResult {
  taskId: string
}

export type AssistantAttachmentStatus = 'staging' | 'parsing' | 'ready' | 'error'
export type AssistantAttachmentDropZone = 'pet' | 'conversation'

export interface AssistantDocumentProblem {
  code: string
  message: string
  retryable: boolean
}

export interface AssistantDocumentLocation {
  kind: string
  value: string
  page: number | null
  headingPath: string[]
  paragraph: number | null
  sheet: string | null
  cellRange: string | null
  slide: number | null
}

export interface AssistantDocumentBlock {
  kind: string
  content: string
  location: AssistantDocumentLocation
  metadata: Record<string, unknown>
}

export interface AssistantAttachmentSummary {
  id: string
  conversationId: string | null
  name: string
  extension: string
  detectedMime: string
  sizeBytes: number
  status: AssistantAttachmentStatus
  parserId: string | null
  warning: string | null
  error: string | null
  title?: string
  blocks?: AssistantDocumentBlock[]
  metadata?: Record<string, unknown>
  warnings?: AssistantDocumentProblem[]
  errors?: AssistantDocumentProblem[]
}

export interface AssistantAttachmentDropResult {
  dropZone: AssistantAttachmentDropZone
  attachments: AssistantAttachmentSummary[]
}

export interface AssistantAttachmentMessageRef {
  id: string
  name: string
  detectedMime: string
  sizeBytes: number
}

export interface AssistantAttachmentPreviewInput {
  attachmentId: string
  conversationId: string
  offset?: number
}

export interface AssistantAttachmentPreview {
  id: string
  name: string
  detectedMime: string
  sizeBytes: number
  status: AssistantAttachmentStatus
  error: string | null
  content: string
  offset: number
  nextOffset: number | null
  totalCharacters: number
  truncated: boolean
  title?: string
  blocks?: AssistantDocumentBlock[]
  warnings?: AssistantDocumentProblem[]
  errors?: AssistantDocumentProblem[]
}

export type AssistantVisionStatus =
  | 'unconfigured'
  | 'untested'
  | 'supported'
  | 'unsupported'
  | 'unavailable'
  | 'invalid-credentials'

export interface AssistantVisionSnapshot {
  status: AssistantVisionStatus
  source: 'inherited' | 'custom'
  model: string
  configured: boolean
  lastError: string | null
  protocolVersion: string
}

export interface AssistantVisionSettingsInput {
  mode: 'inherit' | 'custom'
  baseUrl?: string
  model?: string
  independentCredentials?: boolean
  apiKey?: string
  clearApiKey?: boolean
}

/** 主模型设置的脱敏快照，Renderer 不会接触 API Key 明文。 */
export interface AssistantModelSettingsSnapshot {
  baseUrl: string
  model: string
  configuredKey: boolean
  source: 'environment' | 'saved'
}

/** 主模型设置输入；空白 API Key 表示沿用已保存密钥。 */
export interface AssistantModelSettingsInput {
  baseUrl?: string
  model: string
  apiKey?: string
  clearApiKey?: boolean
}

export interface AssistantVisionSettingsSnapshot {
  mode: 'inherit' | 'custom'
  baseUrl: string
  model: string
  independentCredentials: boolean
  configuredKey: boolean
}

export interface AssistantDocumentCapability {
  parserId: string
  extensions: string[]
  maxInputBytes?: number
  visionRequired?: boolean
  visionEnabled?: boolean
}

export interface AssistantDocumentCapabilities {
  parsers: AssistantDocumentCapability[]
  vision: AssistantVisionSnapshot
}

export type AssistantArtifactPreviewKind = 'text' | 'table' | 'none'
export type AssistantArtifactStatus = 'generating' | 'ready' | 'error'

export interface AssistantArtifactSummary {
  id: string
  conversationId: string
  messageId: string | null
  name: string
  detectedMime: string
  sizeBytes: number
  previewKind: AssistantArtifactPreviewKind
  status: AssistantArtifactStatus
  error: string | null
  saved: boolean
}

export interface AssistantArtifactAccessInput {
  artifactId: string
  conversationId: string
}

export interface AssistantArtifactPreviewInput extends AssistantArtifactAccessInput {
  offset?: number
}

export interface AssistantArtifactPreview extends AssistantArtifactSummary {
  content: string
  offset: number
  nextOffset: number | null
  totalCharacters: number
  truncated: boolean
}

export interface AssistantArtifactSaveResult {
  status: 'saved' | 'cancelled' | 'failed'
  artifact: AssistantArtifactSummary
  error: string | null
}

export type AssistantWebProvider = 'volcengine' | 'brave'
export type AssistantWebSourceKind = 'search-summary' | 'fetched-page'

export interface AssistantWebSettingsSnapshot {
  enabled: boolean
  provider: AssistantWebProvider
  configured: boolean
  configuredProviders: AssistantWebProvider[]
}

export interface AssistantWebSettingsInput {
  enabled: boolean
  provider: AssistantWebProvider
  apiKey?: string
  clearApiKey?: boolean
}

export interface AssistantWebSource {
  id: string
  citationIndex: number
  title: string
  url: string
  domain: string
  excerpt: string
  kind: AssistantWebSourceKind
  publishedAt: string | null
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
  location?: AssistantDocumentLocation
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
  attachments?: AssistantAttachmentMessageRef[]
  artifacts?: AssistantArtifactSummary[]
  webSources?: AssistantWebSource[]
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
    webSearchEnabled: boolean
    webSearchProvider: AssistantWebProvider | null
  }
  knowledgeLibraryIds: string[]
  attachmentIds: string[]
  skillInvocation?: {
    skillId: string
  }
}

export type AssistantSkillSourceType = 'local' | 'github'
export type AssistantSkillCompatibility =
  | 'compatible'
  | 'instruction-only'
  | 'missing-dependencies'
  | 'unsupported-runtime'
  | 'invalid'

export interface AssistantSkillSummary {
  id: string
  name: string
  description: string
  sourceType: AssistantSkillSourceType
  sourceDisplay: string
  sourceUrl: string | null
  versionLabel: string | null
  resolvedCommit: string | null
  compatibility: AssistantSkillCompatibility
  permissions: string[]
  enabled: boolean
  installedAt: string
  updatedAt: string
  lastError: string | null
  lastRun: {
    status: 'running' | 'completed' | 'error' | 'cancelled'
    errorMessage: string | null
    createdAt: string
  } | null
}

export interface AssistantSkillSnapshot {
  skills: AssistantSkillSummary[]
}

export interface AssistantSkillInstallCandidate {
  id: string
  name: string
  description: string
  relativePath: string
  compatibility: AssistantSkillCompatibility
  permissions: string[]
}

export interface AssistantSkillInstallPreview {
  previewToken: string
  sourceType: AssistantSkillSourceType
  sourceDisplay: string
  resolvedCommit: string | null
  expiresInSeconds: number
  candidates: AssistantSkillInstallCandidate[]
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
  | AssistantAttachmentSourcesEvent
  | AssistantArtifactCreatedEvent
  | AssistantArtifactStatusEvent
  | AssistantWebSourcesEvent
  | AssistantSkillStartedEvent
  | AssistantSkillCompletedEvent
  | AssistantSkillErrorEvent
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

export interface AssistantSkillStartedEvent extends AssistantEventBase {
  type: 'skill_started'
  payload: {
    skillId: string
    name: string
    trigger: 'explicit-menu' | 'explicit-management' | 'agent'
  }
}

export interface AssistantSkillCompletedEvent extends AssistantEventBase {
  type: 'skill_completed'
  payload: {
    skillId: string
    name: string
    durationMs: number
  }
}

export interface AssistantSkillErrorEvent extends AssistantEventBase {
  type: 'skill_error'
  payload: {
    skillId: string
    code: string
    message: string
  }
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

export interface AssistantAttachmentSourcesEvent extends AssistantEventBase {
  type: 'attachment_sources'
  payload: {
    sources: Array<{
      id: string
      name: string
      excerpt: string
      truncated: boolean
      location?: AssistantDocumentLocation | null
    }>
  }
}

export interface AssistantArtifactCreatedEvent extends AssistantEventBase {
  type: 'artifact_created'
  payload: {
    artifact: AssistantArtifactSummary
  }
}

export interface AssistantArtifactStatusEvent extends AssistantEventBase {
  type: 'artifact_status'
  payload: {
    artifact: AssistantArtifactSummary
  }
}

export interface AssistantWebSourcesEvent extends AssistantEventBase {
  type: 'web_sources'
  payload: {
    sources: AssistantWebSource[]
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
