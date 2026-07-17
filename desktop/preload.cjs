const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vibeseqDesktop', {
  stableAudio: {
    status: () => ipcRenderer.invoke('stable-audio:status'),
    install: (accepted) => ipcRenderer.invoke('stable-audio:install', { accepted: accepted === true }),
    cancel: () => ipcRenderer.invoke('stable-audio:cancel'),
    onProgress: (listener) => {
      const handler = (_event, progress) => listener(progress)
      ipcRenderer.on('stable-audio:progress', handler)
      return () => ipcRenderer.removeListener('stable-audio:progress', handler)
    },
  },
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
})
