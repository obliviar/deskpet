import type { AgentRuntime } from '@deskpet/core'
import { Hono } from 'hono'

type Env = { Variables: { runtime: AgentRuntime } }

export const chatRoutes = new Hono<Env>()

chatRoutes.post('/', async (c) => {
  const runtime = c.get('runtime')
  const body = await c.req.json().catch(() => ({}))
  const { sessionId = 'default', message, model } = body

  if (!message)
    return c.json({ error: 'message is required' }, 400)

  try {
    const result = await runtime.send(sessionId, message, model ? { model } : undefined)
    return c.json({ text: result.text, toolCalls: result.toolCalls })
  }
  catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  }
})