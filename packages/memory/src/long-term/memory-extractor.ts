import type { MemoryCapture, MemorySensitivity, MemorySharePolicy } from '@deskpet/contracts'

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

const PRIVATE_PATTERNS = [
  /(?:身份证|身份证号|id\s*card)/i,
  /(?:家庭住址|详细地址|家庭地址|住址|address)/i,
  /(?:手机号|手机号码|电话号码|联系电话|phone\s*number)/i,
  /(?:银行卡|银行账号|信用卡|bank\s*account|credit\s*card)/i,
  /(?:生日|出生日期|病历|诊断|疾病|过敏|用药|medication|diagnosed|medical)/i,
  /(?:用户|我)(?:现在|目前|现)?住在/u,
  /(?:用户所在地|user\s+location|健康信息|health\s+condition)/i,
  /(?:车牌|license\s*plate)/i,
  /(?:妻子|丈夫|伴侣|爱人|spouse|wife|husband|partner)/i,
  /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i,
  /(?:\+?86[-\s]?)?1[3-9]\d{9}\b/,
  /\b\d{17}[\dXx]\b/,
]

const NON_FACTUAL_CONTEXT_PATTERNS = [
  /(?:如果|假如|假设|假定|要是).{0,100}(?:我叫|我的(?:名字|姓名)|我喜欢|我住在|我的职业)/u,
  /(?:小说|电影|故事|角色|他说|她说|别人说|你(?:刚才)?说).{0,100}(?:我叫|我的(?:名字|姓名)|我喜欢|我住在)/u,
  /(?:我不叫|我的(?:名字|姓名)不是|我并不叫)/u,
  /(?:不是真的|并非事实|那是错的|说错了)/u,
  /(?:以前|过去|曾经).{0,120}(?:现在|如今|目前)/u,
]

/**
 * Local durable-fact extractor. High precision rules cover common Chinese and
 * English personal facts while rejecting questions, hypotheses, quotations,
 * negation and reported speech. Each clause is evaluated independently so
 * parallel facts become atomic memory records.
 */
export function extractMemoryCandidates(turn: MemoryCapture): MemoryCandidate[] {
  const input = normalize(turn.userMessage)
  if (!isSafeMemoryContent(input) || shouldIgnoreInput(input))
    return []

  const candidates: MemoryCandidate[] = []
  for (const clause of splitClauses(input))
    extractClause(candidates, clause)

  const unique = new Map<string, MemoryCandidate>()
  for (const candidate of candidates) {
    if (isSafeMemoryContent(candidate.content))
      unique.set(candidate.content.toLocaleLowerCase(), candidate)
  }
  return [...unique.values()].slice(0, 8)
}

function extractClause(candidates: MemoryCandidate[], clause: string): void {
  if (!clause || shouldIgnoreClause(clause))
    return
  const countBefore = candidates.length

  addMatch(candidates, clause, /(?:我叫|我的(?:名字|姓名)是)\s*([^，。！？,.!?\n]{1,40})/u, 'identity', '用户姓名/名字', 'profile.name', 'single')
  addMatch(candidates, clause, /(?:请)?(?:叫我|称呼我(?:为)?)\s*([^，。！？,.!?\n]{1,40})/u, 'identity', '用户希望的称呼', 'profile.preferred_name', 'single')
  addMatch(candidates, clause, /(?:我的生日是|我生日是)\s*([^。！？.!?\n]{1,80})/u, 'identity', '用户生日', 'profile.birthday', 'single')
  addMatch(candidates, clause, /我(?:最)?(?:喜欢|偏好)\s*([^。！？.!?\n]{1,200})/u, 'preference', '用户喜好/偏好')
  addMatch(candidates, clause, /也(?:喜欢|偏好)\s*([^。！？.!?\n]{1,200})/u, 'preference', '用户喜好/偏好')
  addMatch(candidates, clause, /我(?:不喜欢|讨厌)\s*([^。！？.!?\n]{1,200})/u, 'preference', '用户不喜欢')
  addMatch(candidates, clause, /我(?:正在|在)(?:做|开发|研究|进行)\s*([^。！？.!?\n]{1,200})/u, 'project', '用户当前项目', 'project.current', 'single')

  addReverseMatch(candidates, clause, /([^，。！？,.!?\n]{1,80})是我的最爱/u, 'preference', '用户喜好/偏好')
  addMatch(candidates, clause, /比起[^，。！？,.!?\n]{1,80}我(?:更爱|更喜欢|更偏好)\s*([^，。！？,.!?\n]{1,100})/u, 'preference', '用户喜好/偏好')
  addMatch(candidates, clause, /我对\s*([^，。！？,.!?\n]{1,80})\s*过敏/u, 'health', '用户过敏信息', 'health.allergy')
  addMatch(candidates, clause, /医生说我(?:有|患有)\s*([^，。！？,.!?\n]{1,100})/u, 'health', '用户健康信息', 'health.condition')
  addMatch(candidates, clause, /我家(?:的)?(?:猫咪|猫|狗狗|狗|宠物)(?:的)?(?:名字)?(?:叫|是)\s*([^，。！？,.!?\n]{1,60})/u, 'relationship', '用户宠物名字', 'relationship.pet_name')
  addMatch(candidates, clause, /我的(?:猫咪|猫|狗狗|狗|宠物)(?:的)?(?:名字)?(?:叫|是)\s*([^，。！？,.!?\n]{1,60})/u, 'relationship', '用户宠物名字', 'relationship.pet_name')
  addMatch(candidates, clause, /我(?:现在|目前|现)?住在\s*([^，。！？,.!?\n]{1,100})/u, 'identity', '用户所在地', 'profile.location', 'single')
  addRoutineMatch(candidates, clause)
  addMatch(candidates, clause, /我的职业是\s*([^，。！？,.!?\n]{1,80})/u, 'identity', '用户职业', 'profile.occupation', 'single')
  addMatch(candidates, clause, /我通常\s*([^，。！？,.!?\n]{1,40})(?:工作|办公)/u, 'routine', '用户工作时间偏好')
  addMatch(candidates, clause, /我的车牌(?:号)?是\s*([\p{L}\p{N}-]{4,20})/u, 'identity', '用户车牌', 'profile.vehicle_plate')
  addMatch(candidates, clause, /我的(?:妻子|丈夫|伴侣|爱人)叫\s*([^，。！？,.!?\n]{1,60})/u, 'relationship', '用户伴侣姓名', 'relationship.partner_name', 'single')
  addMatch(candidates, clause, /我(?:今年)?的目标是\s*([^，。！？,.!?\n]{1,160})/u, 'goal', '用户目标', 'goal.current')
  addMatch(candidates, clause, /我的电脑是\s*([^，。！？,.!?\n]{1,100})/u, 'identity', '用户电脑设备', 'profile.computer')
  addMatch(candidates, clause, /我的(?:手机号|手机号码|电话号码|联系电话)是\s*([^，。！？,.!?\n]{5,40})/u, 'contact', '用户联系电话', 'profile.phone', 'single')
  addMatch(candidates, clause, /我的邮箱(?:地址)?是\s*([^，。！？,!?\n\s]+@[\w.-]+\.[a-z]{2,})/iu, 'contact', '用户邮箱', 'profile.email', 'single')

  addMatch(candidates, clause, /\bmy name is\s+([^,.!?\n]{1,60})/i, 'identity', 'User name', 'profile.name', 'single')
  addMatch(candidates, clause, /\bcall me\s+([^,.!?\n]{1,60})/i, 'identity', 'Preferred form of address', 'profile.preferred_name', 'single')
  addMatch(candidates, clause, /\bi (?:prefer|like)\s+([^.!?\n]{1,200})/i, 'preference', 'User preference')
  addMatch(candidates, clause, /\bi (?:dislike|hate)\s+([^.!?\n]{1,200})/i, 'preference', 'User dislikes')
  addMatch(candidates, clause, /\bi (?:am based|live) in\s+([^,.!?\n]{1,100})/i, 'identity', 'User location', 'profile.location', 'single')
  addMatch(candidates, clause, /\bi work as\s+(?:an?\s+)?([^,.!?\n]{1,80})/i, 'identity', 'User occupation', 'profile.occupation', 'single')
  addMatch(candidates, clause, /\bmy (?:dog|cat|pet)(?:'s name)? is\s+([^,.!?\n]{1,60})/i, 'relationship', 'User pet name', 'relationship.pet_name')

  if (candidates.length === countBefore)
    addExplicitCandidate(candidates, clause)
}

function addRoutineMatch(candidates: MemoryCandidate[], input: string): void {
  const match = /(?:我)?每周([一二三四五六日天1-7])(?:我)?(?:都会|会|通常)?(?:去)?\s*([^，。！？,.!?\n]{1,80})/u.exec(input)
  const day = match?.[1]
  const activity = cleanValue(match?.[2] ?? '')
  if (!day || !activity || isUnsafe(activity))
    return
  addCandidate(candidates, `用户固定安排：每周${day}${activity}`, 'routine', 'routine.weekly')
}

function addExplicitCandidate(candidates: MemoryCandidate[], input: string): void {
  const explicit = /(?:请记住|记住)[：:，,\s]*(?:这件事[：:，,\s]*)?([^。！？.!?\n]{2,300})/u.exec(input)
    ?? /\bremember(?: that)?\s+([^.!?\n]{2,300})/i.exec(input)
  const fact = cleanValue(explicit?.[1] ?? '')
  if (!fact || !isSafeMemoryContent(fact))
    return
  addCandidate(candidates, `用户明确希望记住：${fact}`, 'explicit', undefined, 'multiple', 0.95, 0.9)
}

function addMatch(
  candidates: MemoryCandidate[],
  input: string,
  pattern: RegExp,
  kind: string,
  label: string,
  memoryKey?: string,
  cardinality: 'single' | 'multiple' = 'multiple',
): void {
  const value = cleanValue(pattern.exec(input)?.[1] ?? '')
  if (!value || isUnsafe(value))
    return
  addCandidate(candidates, `${label}：${value}`, kind, memoryKey, cardinality)
}

function addReverseMatch(
  candidates: MemoryCandidate[],
  input: string,
  pattern: RegExp,
  kind: string,
  label: string,
): void {
  addMatch(candidates, input, pattern, kind, label)
}

function addCandidate(
  candidates: MemoryCandidate[],
  content: string,
  kind: string,
  memoryKey?: string,
  cardinality: 'single' | 'multiple' = 'multiple',
  importance = 0.8,
  confidence = 0.9,
): void {
  const privacy = inferMemoryPrivacy(content)
  candidates.push({
    content,
    metadata: {
      kind,
      importance,
      confidence,
      cardinality,
      ...(memoryKey ? { memoryKey } : {}),
      ...privacy,
    },
  })
}

function splitClauses(input: string): string[] {
  return input
    .replace(/[。！？!?;；\n]+/gu, '\n')
    .replace(/[，,](?=\s*(?:我|我的|请|记住|别忘了|每周|平时|通常|现在|也|而且|同时|I\b|My\b|Call\b|Remember\b))/giu, '\n')
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean)
}

function shouldIgnoreInput(input: string): boolean {
  return NON_FACTUAL_CONTEXT_PATTERNS.some(pattern => pattern.test(input))
    || /(?:吗|么|呢)\s*[？?]?$/u.test(input)
    || /[？?]\s*$/u.test(input)
}

function shouldIgnoreClause(clause: string): boolean {
  return /^(?:请问|能否|可否|为什么|怎么|怎样)/u.test(clause)
    || NON_FACTUAL_CONTEXT_PATTERNS.some(pattern => pattern.test(clause))
}

function cleanValue(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/^[“”"'‘’]+|[“”"'‘’]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
}

/** Validate content before it is manually persisted as long-term memory. */
export function isSafeMemoryContent(value: string): boolean {
  const normalized = normalize(value)
  return !!normalized && !isUnsafe(normalized)
}

/** Apply a conservative local privacy floor even when an LLM labels content as public. */
export function inferMemoryPrivacy(value: string): {
  sensitivity: MemorySensitivity
  sharePolicy: MemorySharePolicy
} {
  const normalized = normalize(value)
  if (PRIVATE_PATTERNS.some(pattern => pattern.test(normalized)))
    return { sensitivity: 'private', sharePolicy: 'local-only' }
  return { sensitivity: 'normal', sharePolicy: 'allow-remote' }
}

function isUnsafe(value: string): boolean {
  return UNSAFE_PATTERNS.some(pattern => pattern.test(value))
    || SENSITIVE_PATTERNS.some(pattern => pattern.test(value))
}
