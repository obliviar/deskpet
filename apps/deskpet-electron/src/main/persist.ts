import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export function createPersistence(root: string) {
  if (!existsSync(root))
    mkdirSync(root, { recursive: true })

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, unknown>()

  function filePath(slot: string) {
    return join(root, `${slot}.json`)
  }

  function loadJson<T>(slot: string, fallback: T): T {
    const fp = filePath(slot)
    if (!existsSync(fp))
      return fallback
    try {
      return JSON.parse(readFileSync(fp, 'utf-8'))
    }
    catch {
      return fallback
    }
  }

  function saveJson(slot: string, data: unknown) {
    const fp = filePath(slot)
    if (!existsSync(dirname(fp)))
      mkdirSync(dirname(fp), { recursive: true })
    writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8')
  }

  function saveJsonDebounced(slot: string, data: unknown, delayMs = 5000) {
    pending.set(slot, data)
    const existing = timers.get(slot)
    if (existing)
      clearTimeout(existing)
    timers.set(slot, setTimeout(() => {
      const d = pending.get(slot)
      if (d !== undefined) {
        saveJson(slot, d)
        pending.delete(slot)
      }
      timers.delete(slot)
    }, delayMs))
  }

  function saveAllImmediately() {
    for (const [slot, timer] of timers) {
      clearTimeout(timer)
      const d = pending.get(slot)
      if (d !== undefined) {
        saveJson(slot, d)
        pending.delete(slot)
      }
      timers.delete(slot)
    }
  }

  return { loadJson, saveJson, saveJsonDebounced, saveAllImmediately }
}