import { createHash } from 'node:crypto'
import { parentPort } from 'node:worker_threads'
import {
  createMemoryV4Repository,
  createMemoryV4ShadowRetriever,
} from '@deskpet/memory'
import type {
  MemoryV4Repository,
  MemoryV4ShadowRetriever,
} from '@deskpet/memory'
import type {
  MemoryV4ShadowWorkerRequest,
  MemoryV4ShadowWorkerResponse,
} from './memory-v4-shadow-worker-protocol'

const port = parentPort
if (!port)
  throw new Error('Memory V4 shadow worker requires a parent port')

let repository: MemoryV4Repository | undefined
let retriever: MemoryV4ShadowRetriever | undefined

port.on('message', (request: MemoryV4ShadowWorkerRequest) => {
  const response = execute(request)
  port.postMessage(response)
})

function execute(request: MemoryV4ShadowWorkerRequest): MemoryV4ShadowWorkerResponse {
  try {
    if (!request || request.type !== 'recall' || !Number.isSafeInteger(request.requestId))
      throw new TypeError('Invalid Memory V4 worker request')
    if (request.snapshot) {
      if (!repository) {
        repository = createMemoryV4Repository({ readOnly: false })
        retriever = createMemoryV4ShadowRetriever(repository)
      }
      repository.replace(request.snapshot)
    }
    if (!retriever)
      throw new Error('Memory V4 worker has no synchronized snapshot')
    return {
      type: 'result',
      requestId: request.requestId,
      result: retriever.recall(request.query, request.options),
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      type: 'error',
      requestId: Number.isSafeInteger(request?.requestId) ? request.requestId : -1,
      errorName: safeErrorName(error),
      errorFingerprint: createHash('sha256').update(message).digest('hex'),
    }
  }
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error))
    return 'UnknownError'
  return ['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(error.name)
    ? error.name
    : 'OtherError'
}
