import { createHash } from 'node:crypto'

export const BLIND_PACK_SCHEMA_VERSION = 1 as const

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value)
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

export function fingerprintJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf-8').digest('hex')
}

export function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Blind pack ${label} must be a non-empty string`)
}

export function requireTimestamp(value: unknown, label: string): asserts value is string {
  requireText(value, label)
  if (!Number.isFinite(Date.parse(value)))
    throw new Error(`Blind pack ${label} must be an ISO timestamp`)
}

export function requireCommit(value: unknown, label = 'implementationCommit'): asserts value is string {
  requireText(value, label)
  if (!/^[a-f0-9]{7,64}$/iu.test(value))
    throw new Error(`Blind pack ${label} must be a Git commit id`)
}

export function requireOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key))
  if (extras.length > 0)
    throw new Error(`Blind pack ${label} contains unsupported fields: ${extras.join(', ')}`)
}

export function requireStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim()))
    throw new Error(`Blind pack ${label} must be an array of non-empty strings`)
}
