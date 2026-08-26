import type {
  MemoryV4ShadowRecallOptions,
  MemoryV4ShadowRecallResult,
  MemoryV4SemanticIndexSnapshot,
  MemoryV4Snapshot,
} from '@deskpet/memory'

export interface MemoryV4ShadowWorkerRecallRequest {
  type: 'recall'
  requestId: number
  query: string
  options: MemoryV4ShadowRecallOptions
  snapshot?: MemoryV4Snapshot
  semanticIndex?: MemoryV4SemanticIndexSnapshot
}

export interface MemoryV4ShadowWorkerResultResponse {
  type: 'result'
  requestId: number
  result: MemoryV4ShadowRecallResult
}

export interface MemoryV4ShadowWorkerErrorResponse {
  type: 'error'
  requestId: number
  errorName: string
  errorFingerprint: string
}

export type MemoryV4ShadowWorkerRequest = MemoryV4ShadowWorkerRecallRequest
export type MemoryV4ShadowWorkerResponse =
  | MemoryV4ShadowWorkerResultResponse
  | MemoryV4ShadowWorkerErrorResponse
