const { app, BrowserWindow, net, protocol, session } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

protocol.registerSchemesAsPrivileged([{
  scheme: 'plotline',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

app.setName('Plot Digitizer')

app.whenReady().then(() => {
  const root = path.join(app.getAppPath(), 'dist')
  protocol.handle('plotline', (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 })
    const relative = decodeURIComponent(url.pathname).replace(/^[/\\]+/, '') || 'index.html'
    const file = path.resolve(root, relative)
    const withinRoot = path.relative(root, file)
    if (withinRoot.startsWith('..') || path.isAbsolute(withinRoot)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).href)
  })

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const scheme = new URL(details.url).protocol
    callback({ cancel: !['plotline:', 'file:', 'data:', 'blob:', 'devtools:'].includes(scheme) })
  })

  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'Plot Digitizer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('plotline://app/')) event.preventDefault()
  })
  void window.loadURL('plotline://app/index.html')
})

app.on('window-all-closed', () => app.quit())
