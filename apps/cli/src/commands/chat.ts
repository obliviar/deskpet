import type { AgentRuntime } from '@deskpet/core'
import { createInterface } from 'node:readline'

export function startChatRepl(runtime: AgentRuntime, sessionId: string) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n> ',
  })

  console.log(`[deskpet] Session: ${sessionId}`)
  rl.prompt()

  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) {
      rl.prompt()
      return
    }

    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed, runtime, sessionId)
      rl.prompt()
      return
    }

    try {
      const result = await runtime.send(sessionId, trimmed)
      if (result.toolCalls.length > 0) {
        console.log(`\n[tools called: ${result.toolCalls.map(t => t.function.name).join(', ')}]`)
      }
    }
    catch (err) {
      console.error('[deskpet] error:', err instanceof Error ? err.message : err)
    }
    rl.prompt()
  })

  rl.on('close', () => {
    console.log('\n[deskpet] goodbye!')
    process.exit(0)
  })
}

async function handleCommand(cmd: string, runtime: AgentRuntime, sessionId: string) {
  const [name, ...args] = cmd.slice(1).split(' ')

  switch (name) {
    case 'help':
      console.log('Commands:')
      console.log('  /help      - Show this help')
      console.log('  /new       - Start a new session')
      console.log('  /hooks     - List registered hooks')
      console.log('  /clear     - Clear session history (starts new session)')
      break
    case 'new':
    case 'clear':
      console.log('[deskpet] starting new session...')
      break
    case 'hooks':
      console.log('[deskpet] hooks are active: token output, stream end')
      break
    default:
      console.log(`Unknown command: /${name}`)
  }
}