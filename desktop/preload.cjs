const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vibeseqDesktop', {
  startup: {
    status: () => ipcRenderer.invoke('desktop:startup-state'),
    onProgress: (listener) => {
      const handler = (_event, progress) => listener(progress)
      ipcRenderer.on('desktop:startup-progress', handler)
      return () => ipcRenderer.removeListener('desktop:startup-progress', handler)
    },
  },
  studio: {
    ready: () => ipcRenderer.send('desktop:studio-ready'),
  },
  stableAudio: {
    status: (modelId) => ipcRenderer.invoke('stable-audio:status', { modelId }),
    install: ({ accepted, modelId }) => ipcRenderer.invoke('stable-audio:install', {
      accepted: accepted === true,
      modelId,
    }),
    cancel: () => ipcRenderer.invoke('stable-audio:cancel'),
    onProgress: (listener) => {
      const handler = (_event, progress) => listener(progress)
      ipcRenderer.on('stable-audio:progress', handler)
      return () => ipcRenderer.removeListener('stable-audio:progress', handler)
    },
  },
  muscriptor: {
    verifyCache: () => ipcRenderer.invoke('muscriptor:verify-cache'),
    openCacheFolder: () => ipcRenderer.invoke('muscriptor:open-cache'),
  },
  modelCache: {
    open: () => ipcRenderer.invoke('desktop:open-model-cache'),
  },
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
})
