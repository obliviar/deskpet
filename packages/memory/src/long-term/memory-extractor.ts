import type { MemoryCapture, MemorySensitivity, MemorySharePolicy } from '@deskpet/contracts'
import { normalizeMemoryCandidate } from './memory-normalizer'

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
  /\b(?:api[_ -]?key|password|passwd|access[_ -]?token)\b/i,
  /(?:密码|验证码|访问令牌|密钥)/u,
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
  /^(?:如果|假如|假设|假定|要是)/u,
  /(?:小说|电影|故事|角色|他说|她说|别人说|你(?:刚才)?说).{0,100}(?:我叫|我的(?:名字|姓名)|我喜欢|我住在)/u,
  /(?:不是真的|并非事实|那是错的|说错了)/u,
  /(?:以前|过去|曾经).{0,120}(?:现在|如今|目前)/u,
  /(?:十年前|[一二三四五六七八九十百〇零两\d]+年前|以前|过去|曾经).{0,120}(?:后来|之后).{0,80}(?:转行|不再|已经不是|已经停止)/u,
]

const NEGATED_IDENTITY_PATTERNS = [
  /(?:我不叫|我的(?:名字|姓名)不是|我并不叫)/u,
]

const META_CONTEXT_PATTERNS = [
  /^(?:请)?(?:翻译|把.{0,100}翻译|举(?:个)?例(?:子)?|举例|例如|比如|示例)(?:这句|如下|是)?[：:，,\s]/u,
  /^(?:角色扮演|扮演角色|假想场景|虚构设定|在(?:小说|故事|电影|游戏)中)/u,
]

const REPORTED_SELF_PATTERNS = [
  /(?:^|[，。！？,.!?])(?!(?:我|医生)说)(?:他|她|他们|她们|别人|朋友|同事|[\p{L}\p{N}]{2,16})说[“"'‘’]?(?:我|我的)/u,
]

const TRANSIENT_CLAUSE_PATTERNS = [
  /(?:我喜欢|我偏好)\s*(?:今天的天气|(?:你)?刚才的(?:回答|回复|结果|表现)|这次的(?:回答|回复|结果|体验))/u,
  /(?:刚才|临时|暂时|这(?:两|几|\d+)(?:秒|分钟|小时)).{0,40}(?:我)?(?:在|正在)(?:做|进行|测试)/u,
]

const SUPPORTED_NAME_CORRECTION = /(?:我的(?:名字|姓名))(?:不是)\s*[^，。！？,.!?]{1,40}[，,]\s*(?:而是|是)\s*([^，。！？,.!?]{1,40})/u
const SUPPORTED_LOCATION_TRANSITION = /我(?:以前|过去|曾经)住(?:在)?\s*([^，。！？,.!?]{1,80})[，,]\s*(?:我)?(?:现在|目前|如今)住(?:在)?\s*([^，。！？,.!?]{1,80})/u
const SUPPORTED_LOCATION_DURATION = /(?:我)?搬(?:来|到)\s*([\p{L}]{1,30})(?=(?:已经|有|[，,])).{0,60}(?:现在|目前|如今)(?:仍|还)(?:住|生活)(?:在)?(?:这里|当地|这儿)?/u

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
  addSupportedCorrections(candidates, input)
  for (const clause of splitClauses(input))
    extractClause(candidates, clause)
  addContextConfirmedCandidates(candidates, turn, input)

  const unique = new Map<string, MemoryCandidate>()
  for (const candidate of candidates) {
    if (isSafeMemoryContent(candidate.content))
      unique.set(candidate.content.toLocaleLowerCase(), candidate)
  }
  return [...unique.values()].map(candidate => normalizeMemoryCandidate(candidate, turn))
}

/** Context resolves only an explicit confirmation in the current user turn. */
function addContextConfirmedCandidates(
  candidates: MemoryCandidate[],
  turn: MemoryCapture,
  input: string,
): void {
  if (!/^(?:是的|对(?:的)?|没错|确实|可以这么说|yes|correct|that's right)[。！!.\s]*$/iu.test(input))
    return
  const recentAssistant = [...(turn.context?.recentMessages ?? [])]
    .reverse()
    .find(message => message.role === 'assistant')?.content
  if (!recentAssistant)
    return
  const prompt = normalize(recentAssistant)
  const preference = /(?:所以|也就是说|确认一下)?(?:你|您)(?:是)?(?:喜欢|偏好)\s*([^，。！？,.!?吗]{1,100})(?:吗|对吗|是不是)?[？?]?$/u.exec(prompt)?.[1]
    ?? /(?:do you|you) (?:like|prefer)\s+([^,.!?]{1,100})[?]?$/iu.exec(prompt)?.[1]
  if (!preference)
    return
  const value = cleanValue(preference)
  if (!value || isUnsafe(value))
    return
  addCandidate(candidates, `用户喜好/偏好：${value}`, 'preference', undefined, 'multiple', 0.8, 0.82, {
    extractionChannel: 'context-confirmation',
    extractorVersion: 'local-context-confirmation-v1',
    contextResolved: true,
    contextResolution: 'explicit-user-confirmation',
  })
}

function extractClause(candidates: MemoryCandidate[], clause: string): void {
  if (!clause || shouldIgnoreClause(clause))
    return
  const countBefore = candidates.length

  addMatch(candidates, clause, /(?:我叫|我的(?:名字|姓名)是)\s*([^，。！？,.!?\n]{1,40})/u, 'identity', '用户姓名/名字', 'profile.name', 'single')
  addMatch(candidates, clause, /(?:请)?(?:叫我|称呼我(?:为)?)\s*([^，。！？,.!?\n]{1,40})/u, 'identity', '用户希望的称呼', 'profile.preferred_name', 'single')
  addMatch(candidates, clause, /(?:我的生日是|我生日是)\s*([^。！？.!?\n]{1,80})/u, 'identity', '用户生日', 'profile.birthday', 'single')
  addMatch(candidates, clause, /(?:大家|朋友们?|同事们?|别人)(?:一般|平时|通常)?(?:都)?(?:叫|喊|称呼)我\s*([^，。！？,.!?\n]{1,40})/u, 'identity', '用户希望的称呼', 'profile.preferred_name', 'single')
  addMatch(candidates, clause, /(?:大伙|伙伴们?)(?:一般|平时|平常|通常)?(?:都)?(?:叫|喊|称呼)我\s*([^，。！？,.!?\n]{1,40})/u, 'identity', '用户希望的称呼', 'profile.preferred_name', 'single')
  addReverseMatch(candidates, clause, /([^，。！？,.!?\n]{1,40})是我(?:常用|平时用|习惯用)的?(?:昵称|称呼)/u, 'identity', '用户希望的称呼', 'profile.preferred_name', 'single')
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
  addMatch(candidates, clause, /(?:我的)?(?:常住地|居住地|所在地)(?:是|在)\s*([^，。！？,.!?\n]{1,100})/u, 'identity', '用户所在地', 'profile.location', 'single')
  addMatch(candidates, clause, /(?:我)?搬(?:来|到)\s*([\p{L}]{1,30})(?=(?:已经|有|[，,])).{0,40}(?:现在|目前|如今)(?:仍|还)(?:住|生活)/u, 'identity', '用户所在地', 'profile.location', 'single')
  addRoutineMatch(candidates, clause)
  addWeekendRoutineMatch(candidates, clause)
  addMonthlyRentMatch(candidates, clause)
  addMatch(candidates, clause, /我的职业是\s*([^，。！？,.!?\n]{1,80})/u, 'identity', '用户职业', 'profile.occupation', 'single')
  addMatch(candidates, clause, /职业方面[，,]?(?:我)?(?:是|做|从事)\s*([^，。！？,.!?\n]{1,80})/u, 'identity', '用户职业', 'profile.occupation', 'single')
  addMatch(candidates, clause, /^(?:白天|晚上|目前|现在)?(?:我)?在[^，。！？,.!?\n]{1,30}(?:当|做)\s*([^，。！？,.!?\n]{1,80})/u, 'identity', '用户职业', 'profile.occupation', 'single')
  addMatch(candidates, clause, /我通常\s*([^，。！？,.!?\n]{1,40})(?:工作|办公)/u, 'routine', '用户工作时间偏好')
  addMatch(candidates, clause, /我的车牌(?:号)?是\s*([\p{L}\p{N}-]{4,20})/u, 'identity', '用户车牌', 'profile.vehicle_plate')
  addMatch(candidates, clause, /我的(?:妻子|丈夫|伴侣|爱人)叫\s*([^，。！？,.!?\n]{1,60})/u, 'relationship', '用户伴侣姓名', 'relationship.partner_name', 'single')
  addMatch(candidates, clause, /我(?:今年)?的目标是\s*([^，。！？,.!?\n]{1,160})/u, 'goal', '用户目标', 'goal.current')
  addMatch(candidates, clause, /(?:今年|明年|未来(?:一年)?)(?:的)?(?:打算|计划|目标)(?:是|为)?\s*([^，。！？,.!?\n]{1,160})/u, 'goal', '用户目标', 'goal.current', 'single')
  addMatch(candidates, clause, /我的电脑是\s*([^，。！？,.!?\n]{1,100})/u, 'identity', '用户电脑设备', 'profile.computer')
  addMatch(candidates, clause, /我的(?:手机号|手机号码|电话号码|联系电话)是\s*([^，。！？,.!?\n]{5,40})/u, 'contact', '用户联系电话', 'profile.phone', 'single')
  addMatch(candidates, clause, /我的邮箱(?:地址)?是\s*([^，。！？,!?\n\s]+@[\w.-]+\.[a-z]{2,})/iu, 'contact', '用户邮箱', 'profile.email', 'single')
  addMatch(candidates, clause, /(?:饮料|饮品)(?:里|方面)?(?:我)?(?:通常|一般|平常)?(?:会)?(?:选|选择|喝)\s*([^，。！？,.!?\n]{1,100})/u, 'preference', '用户常喝饮品')
  addMatch(candidates, clause, /(?:我)?(?:通常|一般|平常|经常)(?:会)?(?:喝|选择|选)\s*([^，。！？,.!?\n]{1,100})/u, 'preference', '用户常喝饮品')
  addMatch(candidates, clause, /(?:吃饭|点菜).{0,20}除了\s*([^，。！？,.!?\n]{1,50})\s*以外(?:我)?都可以/u, 'preference', '用户不喜欢')
  addMatch(candidates, clause, /(?:最近|目前|现在)(?:我)?(?:在|正|正在)?(?:筹备|准备|推进)\s*([^，。！？,.!?\n]{1,200})/u, 'project', '用户当前项目', 'project.current', 'single')
  addMatch(candidates, clause, /家里有(?:一)?只[^，。！？,.!?\n]{1,30}[，,]\s*(?:名字)?叫\s*([^，。！？,.!?\n]{1,60})/u, 'relationship', '用户宠物名字', 'relationship.pet_name')
  addMatch(candidates, clause, /我(?:对象|另一半)叫\s*([^，。！？,.!?\n]{1,60})/u, 'relationship', '用户伴侣姓名', 'relationship.partner_name', 'single')
  addAllergySymptomMatch(candidates, clause)
  addMatch(candidates, clause, /(?:回答|回复)(?:请|要|应该|尽量)?(?:控制在|保持在)\s*([^，。！？,.!?\n]{1,80}?)(?:以内|之内)/u, 'preference', '用户回答偏好', 'preference.response_style', 'single')
  addMatch(candidates, clause, /(?:回答|回复)(?:时)?(?:请|要|应该)?先\s*([^，。！？,.!?\n]{1,80})/u, 'preference', '用户回答偏好', 'preference.response_style', 'single')
  addMatch(candidates, clause, /我是\s*(左撇子|右撇子)/u, 'identity', '用户惯用手', 'profile.handedness', 'single')
  addMatch(candidates, clause, /(?:买衣服|选衣服|挑衣服)(?:时)?(?:我)?(?:会)?优先(?:选择|选)\s*([^，。！？,.!?\n]{1,60})/u, 'preference', '用户喜欢的颜色', 'preference.color', 'single')
  addMatch(candidates, clause, /(?:本科|硕士|博士)(?:阶段)?(?:就读|毕业)于\s*([^，。！？,.!?\n]{1,100})/u, 'identity', '用户就读院校', 'profile.education', 'single')
  addMatch(candidates, clause, /(?:日常|平时)(?:写代码|编程)(?:时)?(?:主要)?(?:会)?用\s*([\p{L}\p{N}+#.-]{1,40})/u, 'identity', '用户常用编程语言', 'profile.programming_language', 'single')
  addMatch(candidates, clause, /(?:我)?(?:日常|平时)(?:主要)?用\s*(Rust|Python|TypeScript|JavaScript|Java|C\+\+|C#|Go)(?=[，。！？,.!?\s]|$)/iu, 'identity', '用户常用编程语言', 'profile.programming_language', 'single')

  addMatch(candidates, clause, /\bmy name is\s+([^,.!?\n]{1,60})/i, 'identity', 'User name', 'profile.name', 'single')
  addMatch(candidates, clause, /\bcall me\s+([^,.!?\n]{1,60})/i, 'identity', 'Preferred form of address', 'profile.preferred_name', 'single')
  addMatch(candidates, clause, /\bi (?:prefer|like)\s+([^.!?\n]{1,200})/i, 'preference', 'User preference')
  addMatch(candidates, clause, /\bi (?:dislike|hate)\s+([^.!?\n]{1,200})/i, 'preference', 'User dislikes')
  addMatch(candidates, clause, /\bi (?:am based|live) in\s+([^,.!?\n]{1,100})/i, 'identity', 'User location', 'profile.location', 'single')
  addMatch(candidates, clause, /\bi work as\s+(?:an?\s+)?([^,.!?\n]{1,80})/i, 'identity', 'User occupation', 'profile.occupation', 'single')
  addMatch(candidates, clause, /\bmy (?:dog|cat|pet)(?:'s name)? is\s+([^,.!?\n]{1,60})/i, 'relationship', 'User pet name', 'relationship.pet_name')
  addMatch(candidates, clause, /\bon weekends? i (?:usually|normally|often) (?:go )?([^.!?\n]{1,100})/i, 'routine', 'User weekend routine', 'routine.weekend')
  addReverseMatch(candidates, clause, /([^.!?\n]{1,80}) (?:give|gives) me (?:an? )?(?:serious )?allergic reaction/i, 'health', 'User allergy', 'health.allergy', 'multiple')
  addReverseMatch(candidates, clause, /([^.!?\n]{1,80}) is my usual drink/i, 'preference', 'User usual drink')
  addReverseMatch(candidates, clause, /([^.!?\n]{1,80}) has been home for (?:the )?(?:last|past) [^.!?\n]{1,60}/i, 'identity', 'User location', 'profile.location', 'single')

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

function addWeekendRoutineMatch(candidates: MemoryCandidate[], input: string): void {
  const match = /(?:我)?(周末|周[六日天])(?:早上|上午|下午|晚上)?(?:我)?(?:都会|会|通常)?固定(?:去)?\s*([^，。！？,.!?\n]{1,80})/u.exec(input)
  const period = match?.[1]
  const activity = cleanValue(match?.[2] ?? '')
  if (!period || !activity || isUnsafe(activity))
    return
  addCandidate(candidates, `用户固定安排：${period}${activity}`, 'routine', 'routine.weekend')
}

function addMonthlyRentMatch(candidates: MemoryCandidate[], input: string): void {
  const match = /(?:我)?每个?月\s*([一二三四五六七八九十百〇零两\d]{1,4})\s*(?:日|号)(?:我)?(?:交|付|缴)(?:纳)?房租/u.exec(input)
  const day = cleanValue(match?.[1] ?? '')
  if (!day)
    return
  addCandidate(candidates, `用户缴房租日期：每月${day}号`, 'routine', 'routine.rent_day', 'single')
}

function addAllergySymptomMatch(candidates: MemoryCandidate[], input: string): void {
  const match = /^([^，。！？,.!?\n]{1,50})(?:会|容易)(?:让|使)我.{0,50}(?:过敏|起疹子|呼吸困难|肿胀)/u.exec(input)
  const allergen = cleanValue(match?.[1] ?? '')
  if (!allergen || isUnsafe(allergen))
    return
  addCandidate(candidates, `用户过敏信息：${allergen}`, 'health', 'health.allergy')
}

function addSupportedCorrections(candidates: MemoryCandidate[], input: string): void {
  const correctedName = cleanValue(SUPPORTED_NAME_CORRECTION.exec(input)?.[1] ?? '')
  if (correctedName)
    addCandidate(candidates, `用户姓名/名字：${correctedName}`, 'identity', 'profile.name', 'single', 0.9, 0.95, {
      writeIntent: 'correction',
    })

  const durationLocation = cleanValue(SUPPORTED_LOCATION_DURATION.exec(input)?.[1] ?? '')
  if (durationLocation)
    addCandidate(candidates, `用户所在地：${durationLocation}`, 'identity', 'profile.location', 'single', 0.9, 0.95, {
      writeIntent: 'correction',
    })

  const colloquialOccupation = cleanValue(/职业方面[，,]?(?:我)?(?:是|做|从事)\s*([^，。！？,.!?\n]{1,80})/u.exec(input)?.[1] ?? '')
  if (colloquialOccupation)
    addCandidate(candidates, `用户职业：${colloquialOccupation}`, 'identity', 'profile.occupation', 'single', 0.9, 0.95)

  const location = SUPPORTED_LOCATION_TRANSITION.exec(input)
  const previous = cleanValue(location?.[1] ?? '')
  const current = cleanValue(location?.[2] ?? '')
  if (!previous || !current)
    return
  const changedAt = Date.now()
  addCandidate(candidates, `用户所在地：${previous}`, 'identity', 'profile.location', 'single', 0.8, 0.9, {
    validFrom: 1,
    validTo: changedAt,
    temporalQualifier: 'historical',
    writeIntent: 'historical',
  })
  addCandidate(candidates, `用户所在地：${current}`, 'identity', 'profile.location', 'single', 0.9, 0.95, {
    validFrom: changedAt,
    temporalQualifier: 'current',
    writeIntent: 'correction',
  })
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
  memoryKey?: string,
  cardinality: 'single' | 'multiple' = 'multiple',
): void {
  addMatch(candidates, input, pattern, kind, label, memoryKey, cardinality)
}

function addCandidate(
  candidates: MemoryCandidate[],
  content: string,
  kind: string,
  memoryKey?: string,
  cardinality: 'single' | 'multiple' = 'multiple',
  importance = 0.8,
  confidence = 0.9,
  extraMetadata: Record<string, unknown> = {},
): void {
  const privacy = inferMemoryPrivacy(content)
  candidates.push({
    content,
    metadata: {
      kind,
      importance,
      confidence,
      cardinality,
      extractionChannel: 'rules',
      extractorVersion: 'local-rules-v3',
      ...(memoryKey ? { memoryKey } : {}),
      ...privacy,
      ...extraMetadata,
    },
  })
}

function splitClauses(input: string): string[] {
  return input
    .replace(/[。！？!?;；\n]+/gu, '\n')
    .replace(/[，,](?=\s*(?:我|我的|你|您|请问|请|记住|别忘了|每周|平时|通常|现在|也|而且|同时|I\b|My\b|Call\b|Remember\b))/giu, '\n')
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean)
}

function shouldIgnoreInput(input: string): boolean {
  const supportedCorrection = SUPPORTED_NAME_CORRECTION.test(input) || SUPPORTED_LOCATION_TRANSITION.test(input)
  return META_CONTEXT_PATTERNS.some(pattern => pattern.test(input))
    || REPORTED_SELF_PATTERNS.some(pattern => pattern.test(input))
    || (!supportedCorrection && NON_FACTUAL_CONTEXT_PATTERNS.some(pattern => pattern.test(input)))
    || (!supportedCorrection && NEGATED_IDENTITY_PATTERNS.some(pattern => pattern.test(input)))
    || splitClauses(input).every(clause => /(?:吗|么|呢)\s*[？?]?$/u.test(clause) || /[？?]\s*$/u.test(clause))
}

function shouldIgnoreClause(clause: string): boolean {
  return /^(?:请问|能否|可否|为什么|怎么|怎样)/u.test(clause)
    || NON_FACTUAL_CONTEXT_PATTERNS.some(pattern => pattern.test(clause))
    || TRANSIENT_CLAUSE_PATTERNS.some(pattern => pattern.test(clause))
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
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100_000)
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
