/**
 * Core chat message types shared across the agent runtime.
 *
 * These mirror the OpenAI chat message shape but stay provider-agnostic so the
 * runtime never imports a concrete SDK.
 */

/** Role of a message within a chat turn. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** A single content part for multimodal messages. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** A chat message in the normalized agent format. */
export interface ChatMessage {
  role: ChatRole
  content: string | ContentPart[]
  /** Tool call id when role is 'tool', or tool calls emitted by the assistant. */
  toolCallId?: string
  toolCalls?: ToolCall[]
  /** Optional name for tool-role messages. */
  name?: string
}

/** A tool call requested by the assistant. */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** A finalized history entry persisted in a session. */
export interface ChatHistoryItem {
  id: string
  role: ChatRole
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
  name?: string
  createdAt: number
}

/** Metadata describing the transport that produced a user message. */
export interface ChatStreamEventContext {
  sessionId: string
  generation: number
  input?: { type: 'text' | 'voice' | 'image' }
}

/** A streaming assistant message being assembled token by token. */
export interface StreamingAssistantMessage {
  id: string
  role: 'assistant'
  content: string
  toolCalls?: ToolCall[]
  done: boolean
}
