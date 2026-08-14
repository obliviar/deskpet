import type { MemoryCapture } from '@deskpet/contracts'
import type { MemoryCandidate } from './memory-extractor'

export const MEMORY_NORMALIZER_VERSION = 'structured-normalizer-v1'

export type NormalizedMemoryPolarity = 'positive' | 'negative' | 'unknown'
export type NormalizedMemoryModality = 'asserted' | 'planned' | 'hypothetical' | 'reported' | 'inferred' | 'unknown'

export interface NormalizedMemoryFields {
  subjectId: string
  predicate: string
  normalizedValue: string
  entityAliases: string[]
  polarity: NormalizedMemoryPolarity
  modality: NormalizedMemoryModality
  condition?: string
  cardinality: 'single' | 'multiple' | 'set'
  validFrom?: number
  validTo?: number
  normalizerVersion: string
}

const PREDICATE_ALIASES: Record<string, string> = {
  name: 'profile.name',
  'user.name': 'profile.name',
  nickname: 'profile.preferred_name',
  location: 'profile.location',
  city: 'profile.location',
  occupation: 'profile.occupation',
  job: 'profile.occupation',
  birthday: 'profile.birthday',
  allergy: 'health.allergy',
  project: 'project.current',
  pet: 'relationship.pet_name',
}

const SINGLE_PREDICATES = new Set([
  'profile.name', 'profile.preferred_name', 'profile.location', 'profile.occupation',
  'profile.birthday', 'profile.handedness', 'profile.email', 'profile.phone',
  'relationship.partner_name', 'project.current', 'preference.response_style',
])

const SET_PREDICATES = new Set([
  'health.allergy', 'health.condition', 'preference.like', 'preference.dislike',
])

const VALUE_PREFIX = /^[^:：]{1,80}[:：]\s*/u

/** Normalize structure without rewriting the user-visible canonical text. */
export function normalizeMemoryCandidate(candidate: MemoryCandidate, turn?: MemoryCapture): MemoryCandidate {
  const predicate = normalizePredicate(candidate)
  const rawValue = metadataString(candidate.metadata.normalizedValue)
    ?? candidate.content.replace(VALUE_PREFIX, '').trim()
  const normalizedValue = normalizeValue(rawValue, predicate)
  const modality = normalizeModality(candidate, turn)
  const polarity = normalizePolarity(candidate)
  const condition = normalizeCondition(candidate, turn)
  const cardinality = normalizeCardinality(candidate.metadata.cardinality, predicate)
  const entityAliases = normalizeAliases(candidate.metadata.entityAliases, rawValue, normalizedValue)
  const validFrom = normalizeTimestamp(candidate.metadata.validFrom)
  const validTo = normalizeTimestamp(candidate.metadata.validTo)
  return {
    // Keep the user-visible canonical text stable; NFKC is used only by indexes.
    content: candidate.content.normalize('NFC').replace(/\s+/gu, ' ').trim(),
    metadata: {
      ...candidate.metadata,
      subjectId: metadataString(candidate.metadata.subjectId) ?? 'owner:self',
      predicate,
      ...(predicate !== 'memory.fact' && metadataString(candidate.metadata.memoryKey) ? { memoryKey: predicate } : {}),
      normalizedValue,
      entityAliases,
      polarity,
      modality,
      ...(condition ? { condition } : {}),
      cardinality,
      ...(validFrom ? { validFrom } : {}),
      ...(validTo ? { validTo } : {}),
      normalizerVersion: MEMORY_NORMALIZER_VERSION,
    },
  }
}

export function normalizedMemoryFields(candidate: MemoryCandidate): NormalizedMemoryFields {
  const normalized = normalizeMemoryCandidate(candidate)
  return {
    subjectId: String(normalized.metadata.subjectId),
    predicate: String(normalized.metadata.predicate),
    normalizedValue: String(normalized.metadata.normalizedValue),
    entityAliases: Array.isArray(normalized.metadata.entityAliases)
      ? normalized.metadata.entityAliases.filter((value): value is string => typeof value === 'string')
      : [],
    polarity: normalized.metadata.polarity as NormalizedMemoryPolarity,
    modality: normalized.metadata.modality as NormalizedMemoryModality,
    ...(typeof normalized.metadata.condition === 'string' ? { condition: normalized.metadata.condition } : {}),
    cardinality: normalized.metadata.cardinality as NormalizedMemoryFields['cardinality'],
    ...(typeof normalized.metadata.validFrom === 'number' ? { validFrom: normalized.metadata.validFrom } : {}),
    ...(typeof normalized.metadata.validTo === 'number' ? { validTo: normalized.metadata.validTo } : {}),
    normalizerVersion: MEMORY_NORMALIZER_VERSION,
  }
}

function normalizePredicate(candidate: MemoryCandidate): string {
  const incoming = (metadataString(candidate.metadata.memoryKey)
    ?? metadataString(candidate.metadata.predicate)
    ?? metadataString(candidate.metadata.kind)
    ?? 'memory.fact').toLocaleLowerCase()
  return PREDICATE_ALIASES[incoming] ?? incoming
}

function normalizeCardinality(value: unknown, predicate: string): NormalizedMemoryFields['cardinality'] {
  if (SINGLE_PREDICATES.has(predicate))
    return 'single'
  if (SET_PREDICATES.has(predicate))
    return 'set'
  return value === 'single' || value === 'set' ? value : 'multiple'
}

function normalizeValue(value: string, predicate: string): string {
  let result = value.normalize('NFKC')
    .replace(/^[“”"'‘’]+|[“”"'‘’]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (predicate === 'profile.location')
    result = result.replace(/(?:市|城区)$/u, '')
  if (predicate === 'profile.programming_language') {
    const aliases: Record<string, string> = {
      ts: 'TypeScript', js: 'JavaScript', py: 'Python', golang: 'Go', 'c sharp': 'C#',
    }
    result = aliases[result.toLocaleLowerCase()] ?? result
  }
  return result.toLocaleLowerCase().replace(/[，。！？,.!?]+$/gu, '').trim()
}

function normalizePolarity(candidate: MemoryCandidate): NormalizedMemoryPolarity {
  const explicit = candidate.metadata.polarity
  if (explicit === 'positive' || explicit === 'negative' || explicit === 'unknown')
    return explicit
  if (/(?:不喜欢|讨厌|不能吃|避免|过敏|\bdislike\b|\bhate\b)/iu.test(candidate.content))
    return 'negative'
  if (/(?:喜欢|偏爱|偏好|最爱|\bprefer\b|\blike\b)/iu.test(candidate.content))
    return 'positive'
  return 'unknown'
}

function normalizeModality(candidate: MemoryCandidate, turn?: MemoryCapture): NormalizedMemoryModality {
  const explicit = candidate.metadata.modality
  if (explicit === 'asserted' || explicit === 'planned' || explicit === 'hypothetical'
    || explicit === 'reported' || explicit === 'inferred' || explicit === 'unknown')
    return explicit
  const source = turn?.userMessage ?? candidate.content
  if (/^(?:如果|假如|假设|要是)|\b(?:if|suppose|assuming)\b/iu.test(source))
    return 'hypothetical'
  if (/(?:他说|她说|朋友说|同事说)|\b(?:he|she|they) said\b/iu.test(source))
    return 'reported'
  if (/(?:计划|打算|目标|准备)|\b(?:plan|intend|goal)\b/iu.test(candidate.content))
    return 'planned'
  return 'asserted'
}

function normalizeCondition(candidate: MemoryCandidate, turn?: MemoryCapture): string | undefined {
  const explicit = metadataString(candidate.metadata.condition)
  if (explicit)
    return explicit.slice(0, 200)
  const source = turn?.userMessage ?? ''
  const match = /(?:当|每当)([^，。！？,.!?]{1,80})(?:时|的时候)|([^，。！？,.!?]{1,80}时)(?:我)?/u.exec(source)
  return (match?.[1] ?? match?.[2])?.trim()
}

function normalizeAliases(value: unknown, rawValue: string, normalizedValue: string): string[] {
  const incoming = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return [...new Set([rawValue, normalizedValue, ...incoming]
    .map(item => item.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase())
    .filter(Boolean))]
}

function metadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return value
  if (typeof value !== 'string' || !value.trim())
    return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined
}
