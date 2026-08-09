import type { MemoryCapture } from '@deskpet/contracts'

export interface MemoryCandidate {
  content: string
  metadata: Record<string, unknown>
}

export type MemoryExtractor = (turn: MemoryCapture) => Promise<MemoryCandidate[]> | MemoryCandidate[]

const UNSAFE_PATTERNS = [
  /ignore\s+(all\s+)?(previous\s+)?instructions?/i,
  /system\s*prompt/i,
  /developer\s+message/i,
  /忽略.{0,12}(规则|指令|提示词|系统)/u,
  /(执行|运行).{0,12}(命令|脚本)/u,
]

const SENSITIVE_PATTERNS = [
  /\bsk-[a-z0-9_-]{12,}\b/i,
  /\b(api[_ -]?key|password|passwd|密码|验证码|access[_ -]?token)\b/i,
]

/**
 * Conservative rule-based extractor. It only keeps durable personal facts and
 * explicit remember requests; ordinary chat and assistant output are ignored.
 */
export function extractMemoryCandidates(turn: MemoryCapture): MemoryCandidate[] {
  const input = normalize(turn.userMessage)
  if (!input || isUnsafe(input))
    return []

  const candidates: MemoryCandidate[] = []
  addMatch(candidates, input, /(?:我叫|我的(?:名字|姓名)是)\s*([^，。！？,.!?\n]{1,40})/u, 'identity', '用户姓名/名字')
  addMatch(candidates, input, /(?:请)?(?:叫我|称呼我(?:为)?)\s*([^，。！？,.!?\n]{1,40})/u, 'identity', '用户希望的称呼')
  addMatch(candidates, input, /(?:我的生日是|我生日是)\s*([^。！？.!?\n]{1,80})/u, 'identity', '用户生日')
  addMatch(candidates, input, /我(?:最)?(?:喜欢|偏好)\s*([^。！？.!?\n]{1,200})/u, 'preference', '用户喜好/偏好')
  addMatch(candidates, input, /我(?:不喜欢|讨厌)\s*([^。！？.!?\n]{1,200})/u, 'preference', '用户不喜欢')
  addMatch(candidates, input, /我(?:正在|在)(?:做|开发|研究|进行)\s*([^。！？.!?\n]{1,200})/u, 'project', '用户当前项目')

  addMatch(candidates, input, /\bmy name is\s+([^,.!?\n]{1,60})/i, 'identity', 'User name')
  addMatch(candidates, input, /\bcall me\s+([^,.!?\n]{1,60})/i, 'identity', 'Preferred form of address')
  addMatch(candidates, input, /\bi (?:prefer|like)\s+([^.!?\n]{1,200})/i, 'preference', 'User preference')
  addMatch(candidates, input, /\bi (?:dislike|hate)\s+([^.!?\n]{1,200})/i, 'preference', 'User dislikes')

  if (candidates.length === 0) {
    const explicit = /(?:请记住|记住)[：:，,\s]*(?:这件事[：:，,\s]*)?([^。！？.!?\n]{2,300})/u.exec(input)
      ?? /\bremember(?: that)?\s+([^.!?\n]{2,300})/i.exec(input)
    const fact = explicit?.[1]?.trim()
    if (fact && !isUnsafe(fact)) {
      candidates.push({
        content: `用户明确希望记住：${fact}`,
        metadata: { kind: 'explicit', importance: 0.95, confidence: 0.9 },
      })
    }
  }

  const unique = new Map<string, MemoryCandidate>()
  for (const candidate of candidates) {
    if (!isUnsafe(candidate.content))
      unique.set(candidate.content.toLocaleLowerCase(), candidate)
  }
  return [...unique.values()].slice(0, 4)
}

function addMatch(
  candidates: MemoryCandidate[],
  input: string,
  pattern: RegExp,
  kind: string,
  label: string,
): void {
  const value = pattern.exec(input)?.[1]?.trim()
  if (!value || isUnsafe(value))
    return
  candidates.push({
    content: `${label}：${value}`,
    metadata: { kind, importance: 0.8, confidence: 0.9 },
  })
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
}

function isUnsafe(value: string): boolean {
  return UNSAFE_PATTERNS.some(pattern => pattern.test(value))
    || SENSITIVE_PATTERNS.some(pattern => pattern.test(value))
}
