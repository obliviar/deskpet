import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("deskpet", {
  sendMessage: (message, sessionId) => ipcRenderer.invoke("chat:send", message, sessionId),
  onToken: (callback) => {
    const handler = (_event, token) => callback(token);
    ipcRenderer.on("chat:token", handler);
    return () => ipcRenderer.removeListener("chat:token", handler);
  }
});
