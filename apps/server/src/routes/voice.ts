import { Hono } from 'hono'
import type { AppEnv } from '../index'

export const voiceRoutes = new Hono<AppEnv>()

voiceRoutes.post('/transcribe', async (c) => {
  const runtime = c.get('runtime')
  const body = await c.req.parseBody()
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : 'default'
  const text = typeof body.text === 'string' ? body.text : ''

  if (!text.trim())
    return c.json({ error: 'text field is required' }, 400)

  try {
    const result = await runtime.send(sessionId, text, { input: { type: 'voice' } })
    return c.json({ text: result.text, toolCalls: result.toolCalls })
  }
  catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  }
})

voiceRoutes.get('/health', (c) => c.json({ voice: 'ok' }))