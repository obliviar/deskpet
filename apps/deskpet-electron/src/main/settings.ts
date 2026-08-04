/**
 * App settings stored in userData/settings.json.
 * Read/written by the main process, queried by the renderer via IPC.
 */

export interface AppSettings {
  agentName: string | null
  persona?: string
  firstRunAt: number | null
}

const DEFAULT_SETTINGS: AppSettings = {
  agentName: null,
  firstRunAt: null,
}

export function createSettingsManager(persist: ReturnType<typeof import('./persist').createPersistence>) {
  let settings: AppSettings = persist.loadJson<AppSettings>('settings', DEFAULT_SETTINGS)

  function get(): Readonly<AppSettings> {
    return settings
  }

  function getName(): string | null {
    return settings.agentName
  }

  function setName(name: string) {
    settings = { ...settings, agentName: name }
    if (!settings.firstRunAt)
      settings = { ...settings, firstRunAt: Date.now() }
    persist.saveJsonDebounced('settings', settings, 1000)
  }

  function setPersona(persona: string) {
    settings = { ...settings, persona }
    persist.saveJsonDebounced('settings', settings, 1000)
  }

  function isFirstRun(): boolean {
    return settings.agentName === null
  }

  return { get, getName, setName, setPersona, isFirstRun }
}