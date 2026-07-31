import type { ToolHandler, ToolExecutionContext } from '@deskpet/contracts'

/**
 * Tool call executor with retry and timeout support.
 */
export interface ExecutorOptions {
  /** Per-tool timeout in ms. */
  timeout?: number
  /** Max retry attempts on transient errors. */
  maxRetries?: number
}

/**
 * Wraps a ToolHandler with timeout and retry logic.
 */
export function wrapHandler(handler: ToolHandler, options: ExecutorOptions = {}): ToolHandler {
  const { timeout = 30_000, maxRetries = 1 } = options

  return {
    ...handler,
    async execute(args, context) {
      let lastError: unknown
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await withTimeout(handler.execute(args, context), timeout)
          return result
        }
        catch (err) {
          lastError = err
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
          }
        }
      }
      throw lastError
    },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tool execution timed out after ${ms}ms`)), ms)
    promise.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}