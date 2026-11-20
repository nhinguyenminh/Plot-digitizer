const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('plotlineDesktop', true)
