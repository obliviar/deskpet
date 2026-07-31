import type { ChatStreamEventContext, StreamingAssistantMessage } from '../types/chat'

/**
 * Lifecycle hooks invoked by the runtime around key points of a chat turn.
 *
 * Each `on*` registers a callback and returns an unsubscribe function.
 * Each `emit*` is called by the runtime; implementors should not call them.
 */
export interface ChatHookRegistry {
  onBeforeMessageComposed: (cb: (message: string, ctx: Omit<ChatStreamEventContext, 'composedMessage'>) => Promise<void>) => () => void
  onAfterMessageComposed: (cb: (message: string, ctx: ChatStreamEventContext) => Promise<void>) => () => void
  onBeforeSend: (cb: (message: string, ctx: ChatStreamEventContext) => Promise<void>) => () => void
  onAfterSend: (cb: (message: string, ctx: ChatStreamEventContext) => Promise<void>) => () => void
  onTokenLiteral: (cb: (literal: string, ctx: ChatStreamEventContext) => Promise<void>) => () => void
  onStreamEnd: (cb: (ctx: ChatStreamEventContext) => Promise<void>) => () => void
  onAssistantMessage: (cb: (message: StreamingAssistantMessage, text: string, ctx: ChatStreamEventContext) => Promise<void>) => () => void

  emitBeforeMessageComposedHooks: (message: string, ctx: Omit<ChatStreamEventContext, 'composedMessage'>) => Promise<void>
  emitAfterMessageComposedHooks: (message: string, ctx: ChatStreamEventContext) => Promise<void>
  emitBeforeSendHooks: (message: string, ctx: ChatStreamEventContext) => Promise<void>
  emitAfterSendHooks: (message: string, ctx: ChatStreamEventContext) => Promise<void>
  emitTokenLiteralHooks: (literal: string, ctx: ChatStreamEventContext) => Promise<void>
  emitStreamEndHooks: (ctx: ChatStreamEventContext) => Promise<void>
  emitAssistantMessageHooks: (message: StreamingAssistantMessage, text: string, ctx: ChatStreamEventContext) => Promise<void>

  clearHooks: () => void
}

export type HookUnsubscribe = () => void
