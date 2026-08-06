import { Hono } from 'hono'
import type { AppEnv } from '../index'

export const chatRoutes = new Hono<AppEnv>()

chatRoutes.post('/', async (c) => {
  const runtime = c.get('runtime')
  const body = await c.req.json().catch(() => ({}))
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : 'default'
  const message = typeof body.message === 'string' ? body.message : ''
  const model = typeof body.model === 'string' ? body.model : undefined

  if (!message.trim())
    return c.json({ error: 'message is required' }, 400)

  try {
    const result = await runtime.send(sessionId, message, model ? { model } : undefined)
    return c.json({ text: result.text, toolCalls: result.toolCalls })
  }
  catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  }
})