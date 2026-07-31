import type { ToolHandler, ToolExecutionContext } from '@deskpet/contracts'

/**
 * Web search tool using a configurable search API.
 *
 * Defaults to DuckDuckGo HTML scraping; swap for Google/Bing/serp API.
 */
export const webSearchTool: ToolHandler = {
  name: 'web_search',
  description: 'Search the web for current information. Use this when you need up-to-date facts.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      maxResults: { type: 'number', description: 'Maximum results to return (default: 5)' },
    },
    required: ['query'],
  },

  async execute(args) {
    const query = encodeURIComponent(String(args.query))
    const maxResults = Number(args.maxResults) || 5

    try {
      const url = `https://html.duckduckgo.com/html/?q=${query}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'deskpet-agent/0.1' },
      })
      const html = await res.text()

      const results: string[] = []
      const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
      let match
      let count = 0
      while ((match = snippetRe.exec(html)) !== null && count < maxResults) {
        const snippet = match[1]!.replace(/<[^>]+>/g, '').trim()
        if (snippet) {
          results.push(snippet)
          count++
        }
      }

      return results.length > 0
        ? JSON.stringify(results)
        : JSON.stringify([{ error: 'No results found' }])
    }
    catch (err) {
      return JSON.stringify({ error: `Search failed: ${err instanceof Error ? err.message : 'unknown'}` })
    }
  },
}