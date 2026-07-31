import type { ToolHandler } from '@deskpet/contracts'

/**
 * HTTP fetch tool: sends a GET/POST request and returns the response body.
 */
export const httpFetchTool: ToolHandler = {
  name: 'http_fetch',
  description: 'Make an HTTP request to a URL and return the response.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      method: { type: 'string', description: 'HTTP method (GET, POST, etc.)', default: 'GET' },
      body: { type: 'string', description: 'Request body for POST/PUT' },
      headers: { type: 'object', description: 'Additional headers as key-value pairs' },
    },
    required: ['url'],
  },

  async execute(args) {
    const url = String(args.url)
    const method = String(args.method || 'GET').toUpperCase()
    const body = args.body ? String(args.body) : undefined

    try {
      const res = await fetch(url, {
        method,
        body,
        headers: {
          'User-Agent': 'deskpet-agent/0.1',
          ...(args.headers as Record<string, string> ?? {}),
        },
      })

      const text = await res.text()
      const max = 5000
      return text.length > max ? text.slice(0, max) + `\n... (truncated)` : text
    }
    catch (err) {
      return JSON.stringify({ error: `HTTP fetch failed: ${err instanceof Error ? err.message : 'unknown'}` })
    }
  },
}