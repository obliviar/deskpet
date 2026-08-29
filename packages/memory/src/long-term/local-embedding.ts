/** Privacy-preserving local embedding used by default by the desktop app. */
export const LOCAL_EMBEDDING_MODEL = 'local-hash-v3'
export const LEGACY_LOCAL_EMBEDDING_MODELS = new Set(['local-hash-v1', 'local-hash-v2'])

const DEFAULT_DIMENSIONS = 384
const CONCEPT_WEIGHT = 5

const SEMANTIC_CONCEPT_PATTERNS: Array<[string, RegExp]> = [
  ['preference.any', /偏好|喜欢|偏爱|爱听|爱看|不喜欢|讨厌|常喝|常吃|prefer|preference|like|dislike|favorite|favourite/i],
  ['profile.name', /姓名|名字|称呼|叫(?:我|你)|\bname\b|\bcall\b/i],
  ['profile.location', /所在地|住在|居住|常住|定居|落脚|哪座城市|哪里住|何处生活|(?:哪|什么|哪个).{0,4}城市.{0,6}(?:生活|居住|住过|待过)|based\s+in|live\s+in|has\s+been\s+home/i],
  ['profile.native-language', /母语|方言|家乡话|从小讲|native\s+language|dialect/i],
  ['profile.shoe-size', /鞋码|几码.{0,4}鞋|鞋.{0,6}(?:尺码|号码|大小)|shoe\s+size/i],
  ['relationship.pet', /宠物|毛孩子|猫咪|猫|狗狗|狗|兔子|兔|\bdog\b|\bcat\b|\bpet\b|\brabbit\b/i],
  ['relationship.sibling', /哥哥|姐姐|弟弟|妹妹|兄弟姐妹|手足|sibling|brother|sister/i],
  ['preference.music', /音乐|歌曲|爵士|爱听|耳机|\bmusic\b|\bsong\b|\bjazz\b/i],
  ['health.allergy', /过敏|必须避开|食材.{0,10}避开|药.{0,10}(?:不能用|禁用|避开)|(?:不能用|禁用).{0,10}药|allerg|(?:food|medicine|drug).{0,20}(?:avoid|cannot\s+use)|must\s+avoid/i],
  ['project.current', /当前项目|项目|开发|手头.{0,12}(?:忙|软件|准备|筹备|做)|正在.{0,12}(?:做|准备|开发).{0,8}(?:产品|软件)?|做的产品|哪个软件|\bproject\b|develop|working\s+on/i],
  ['routine.exercise', /固定安排|每周|锻炼|运动|徒步|游泳|瑜伽|\broutine\b|\bweekly\b|\bexercise\b/i],
  ['profile.operating-system', /电脑系统|操作系统|运行.{0,8}平台|windows|macos|linux|operating\s+system/i],
  ['preference.response-style', /回答偏好|回复|回答|篇幅|简洁|详细|\bresponse\b|\breply\b|\bconcise\b/i],
  ['profile.programming-language', /编程语言|哪门语言|写程序|写代码|技术栈|python|typescript|javascript|rust|c\+\+|programming\s+language|tech\s+stack/i],
  ['preference.drink', /饮品|喝什么|泡什么|乌龙茶|咖啡|饮料|\bdrink\b|\bbeverage\b|\btea\b|\bcoffee\b/i],
  ['routine.work-time', /工作习惯|工作时间|(?:什么时候|何时).{0,6}工作|平时.{0,8}工作|夜间|晚上工作|时段.{0,8}效率|效率最高|白天.{0,8}夜|办公|work.{0,12}(?:night|day)/i],
  ['profile.birthday', /生日|出生日期|生日祝福|庆生|\bbirthday\b|celebrate.{0,8}birthday/i],
  ['relationship.friend', /好友|朋友|那位朋友|\bfriend\b/i],
  ['preference.food', /不喜欢.{0,12}(?:食物|吃)|不要(?:放|加)|吃饭|点菜|口味.{0,8}(?:禁忌|避讳)|忌口|不能吃|香菜|\bdislike\b|\bhate\b|cilantro|food.{0,12}(?:preference|restriction)/i],
  ['preference.interface-theme', /界面.{0,8}(?:主题|模式)|深色主题|黑色主题|dark\s+mode|interface\s+theme/i],
  ['plan.travel', /旅行|目的地|去哪里玩|下一趟|京都|\btravel\b|\btrip\b|\bdestination\b/i],
  ['preference.book', /喜欢的书|喜欢.{0,4}(?:哪|什么|哪一)(?:本|部)书|哪(?:一)?本书|什么书|小说|哪部.{0,8}心头好|三体|\bbook\b|\bnovel\b/i],
  ['profile.education', /毕业院校|高校毕业|大学|本科|硕士|博士|就读|在哪.{0,8}读|\buniversity\b|\bcollege\b|education/i],
  ['preference.color', /颜色|什么色|色系|衣服.{0,8}色|藏青|墨绿|\bcolor\b|\bcolour\b/i],
  ['routine.rent', /房租|房东.{0,12}收钱|每月.{0,6}号|\brent\b/i],
  ['profile.occupation', /职业|做什么工作|靠什么.{0,8}(?:工作|谋生)|谋生|任职|教师|occupation|work\s+as|make.{0,8}living|\bjob\b/i],
  ['relationship.partner', /妻子|丈夫|伴侣|爱人|对象|另一半|spouse|wife|husband|partner/i],
  ['goal.current', /目标|挑战|马拉松|\bgoal\b/i],
  ['profile.device', /电脑是|笔记本|thinkpad|\bdevice\b|\blaptop\b/i],
]
const SEMANTIC_CONCEPT_PATTERN_MAP = new Map(SEMANTIC_CONCEPT_PATTERNS)

/** Return stable semantic field tokens shared by common paraphrases. */
export function localSemanticConcepts(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  return SEMANTIC_CONCEPT_PATTERNS
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([concept]) => concept)
}

/** Check only the query concepts instead of evaluating every concept rule. */
export function sharesLocalSemanticConcept(text: string, concepts: ReadonlySet<string>): boolean {
  if (concepts.size === 0)
    return false
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  for (const concept of concepts) {
    if (SEMANTIC_CONCEPT_PATTERN_MAP.get(concept)?.test(normalized))
      return true
  }
  return false
}

/**
 * Produce a deterministic feature-hashed vector from Latin words, Chinese
 * unigrams/bigrams and weighted semantic field aliases. Version 3 improves
 * paraphrase recall without sending personal text to a remote service.
 */
export function createLocalEmbedding(text: string, dimensions = DEFAULT_DIMENSIONS): number[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  const tokens: string[] = []

  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) {
    tokens.push(`w:${word}`)
    if (word.length >= 4) {
      for (let i = 0; i <= word.length - 3; i++)
        tokens.push(`g:${word.slice(i, i + 3)}`)
    }
  }

  const han = normalized.match(/[\u3400-\u9fff]/g) ?? []
  for (let i = 0; i < han.length; i++) {
    tokens.push(`c:${han[i]}`)
    if (i + 1 < han.length)
      tokens.push(`b:${han[i]}${han[i + 1]}`)
  }

  for (const concept of localSemanticConcepts(normalized)) {
    for (let weight = 0; weight < CONCEPT_WEIGHT; weight++)
      tokens.push(`s:${concept}`)
  }

  const vector = Array.from<number>({ length: dimensions }).fill(0)
  for (const token of tokens) {
    const hash = fnv1a(token)
    const index = hash % dimensions
    const sign = (hash & 0x80000000) === 0 ? 1 : -1
    vector[index] = (vector[index] ?? 0) + sign
  }

  let norm = 0
  for (const value of vector)
    norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++)
      vector[i] = (vector[i] ?? 0) / norm
  }
  return vector
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
