import type { ChatHookRegistry, ChatStreamEventContext, HookUnsubscribe, StreamingAssistantMessage } from '@deskpet/contracts'

type AsyncCb<T> = (arg: T, ctx: ChatStreamEventContext) => Promise<void>

/**
 * Creates a hook registry that stores callbacks and emits them in registration order.
 *
 * Errors thrown by a callback are caught and logged so a faulty hook cannot
 * abort the whole chat turn.
 */
export function createChatHooks(): ChatHookRegistry {
  const beforeComposed: AsyncCb<string>[] = []
  const afterComposed: AsyncCb<string>[] = []
  const beforeSend: AsyncCb<string>[] = []
  const afterSend: AsyncCb<string>[] = []
  const tokenLiteral: AsyncCb<string>[] = []
  const streamEnd: ((ctx: ChatStreamEventContext) => Promise<void>)[] = []
  const assistantMessage: ((msg: StreamingAssistantMessage, text: string, ctx: ChatStreamEventContext) => Promise<void>)[] = []

  function register<T>(list: T[], cb: T): HookUnsubscribe {
    list.push(cb)
    return () => {
      const i = list.indexOf(cb)
      if (i >= 0)
        list.splice(i, 1)
    }
  }

  async function run<T>(list: AsyncCb<T>[], arg: T, ctx: ChatStreamEventContext): Promise<void> {
    for (const cb of list) {
      try {
        await cb(arg, ctx)
      }
      catch (err) {
        console.error('[deskpet] hook error:', err)
      }
    }
  }

  return {
    onBeforeMessageComposed: cb => register(beforeComposed, cb as AsyncCb<string>),
    onAfterMessageComposed: cb => register(afterComposed, cb as AsyncCb<string>),
    onBeforeSend: cb => register(beforeSend, cb as AsyncCb<string>),
    onAfterSend: cb => register(afterSend, cb as AsyncCb<string>),
    onTokenLiteral: cb => register(tokenLiteral, cb as AsyncCb<string>),
    onStreamEnd: cb => register(streamEnd, cb),
    onAssistantMessage: cb => register(assistantMessage, cb),

    emitBeforeMessageComposedHooks: (msg, ctx) => run(beforeComposed, msg, { ...ctx, composedMessage: msg } as ChatStreamEventContext),
    emitAfterMessageComposedHooks: (msg, ctx) => run(afterComposed, msg, ctx),
    emitBeforeSendHooks: (msg, ctx) => run(beforeSend, msg, ctx),
    emitAfterSendHooks: (msg, ctx) => run(afterSend, msg, ctx),
    emitTokenLiteralHooks: (literal, ctx) => run(tokenLiteral, literal, ctx),
    emitStreamEndHooks: async (ctx) => {
      for (const cb of streamEnd) {
        try {
          await cb(ctx)
        }
        catch (err) {
          console.error('[deskpet] streamEnd hook error:', err)
        }
      }
    },
    emitAssistantMessageHooks: async (msg, text, ctx) => {
      for (const cb of assistantMessage) {
        try {
          await cb(msg, text, ctx)
        }
        catch (err) {
          console.error('[deskpet] assistantMessage hook error:', err)
        }
      }
    },

    clearHooks: () => {
      beforeComposed.length = 0
      afterComposed.length = 0
      beforeSend.length = 0
      afterSend.length = 0
      tokenLiteral.length = 0
      streamEnd.length = 0
      assistantMessage.length = 0
    },
  }
}
