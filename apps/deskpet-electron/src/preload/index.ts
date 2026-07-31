import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('deskpet', {
  sendMessage: (message: string, sessionId: string) =>
    ipcRenderer.invoke('chat:send', message, sessionId),
  onToken: (callback: (token: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, token: string) => callback(token)
    ipcRenderer.on('chat:token', handler)
    return () => ipcRenderer.removeListener('chat:token', handler)
  },
})