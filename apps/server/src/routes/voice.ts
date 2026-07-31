import type { AgentRuntime } from '@deskpet/core'
import { Hono } from 'hono'

type Env = { Variables: { runtime: AgentRuntime } }

export const voiceRoutes = new Hono<Env>()

voiceRoutes.post('/transcribe', async (c) => {
  const runtime = c.get('runtime')
  const body = await c.req.parseBody()
  const sessionId = String(body.sessionId || 'default')
  const text = body.text

  if (!text || typeof text !== 'string')
    return c.json({ error: 'text field is required' }, 400)

  try {
    const result = await runtime.send(sessionId, text as string, { input: { type: 'voice' } })
    return c.json({ text: result.text, toolCalls: result.toolCalls })
  }
  catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  }
})

voiceRoutes.get('/health', (c) => c.json({ voice: 'ok' }))