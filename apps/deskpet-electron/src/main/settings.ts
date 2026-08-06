/**
 * App settings stored in userData/settings.json.
 * Read/written by the main process, queried by the renderer via IPC.
 */

export interface AppSettings {
  agentName: string | null
  firstRunAt: number | null
  theme: string | null
}

const DEFAULT_SETTINGS: AppSettings = {
  agentName: null,
  firstRunAt: null,
  theme: null,
}

export function createSettingsManager(persist: ReturnType<typeof import('./persist').createPersistence>) {
  let settings: AppSettings = persist.loadJson<AppSettings>('settings', DEFAULT_SETTINGS)

  function get(): Readonly<AppSettings> {
    return settings
  }

  function setName(name: string) {
    settings = { ...settings, agentName: name }
    if (!settings.firstRunAt)
      settings = { ...settings, firstRunAt: Date.now() }
    persist.saveJsonDebounced('settings', settings, 1000)
  }

  function setTheme(theme: string) {
    settings = { ...settings, theme }
    persist.saveJsonDebounced('settings', settings, 1000)
  }

  return { get, setName, setTheme }
}