import type { ToolHandler } from '@deskpet/contracts'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * File read tool: reads the content of a text file from the filesystem.
 */
export const fileReadTool: ToolHandler = {
  name: 'file_read',
  description: 'Read the contents of a file from the local filesystem.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file' },
      maxLength: { type: 'number', description: 'Max characters to read (default: 5000)' },
    },
    required: ['path'],
  },

  async execute(args) {
    const filePath = resolve(String(args.path))
    const maxLength = Number(args.maxLength) || 5000

    if (!existsSync(filePath))
      return JSON.stringify({ error: `File not found: ${filePath}` })

    try {
      const content = readFileSync(filePath, 'utf-8')
      const truncated = content.length > maxLength
        ? content.slice(0, maxLength) + `\n... (truncated, ${content.length} total chars)`
        : content
      return truncated
    }
    catch (err) {
      return JSON.stringify({ error: `Read failed: ${err instanceof Error ? err.message : 'unknown'}` })
    }
  },
}