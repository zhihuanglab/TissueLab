/**
 * Custom protocol handler setup for tissuelab:// deep links
 * Handles bringing the app to foreground when opened via custom protocol
 * 
 * @param {Electron.App} app - Electron app instance
 * @param {Function} getMainWindow - Function that returns the main BrowserWindow instance
 */
function setupProtocolHandlers(app, getMainWindow) {
  // Register custom deep link protocol to bring the app to foreground from browser (e.g., tissuelab://)
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', (event, argv) => {
      // Windows: deep link URL is in argv
      const deepLinkArg = argv.find((arg) => typeof arg === 'string' && arg.startsWith('tissuelab://'));
      const mainWindow = getMainWindow();
      if (deepLinkArg && mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }

  // macOS: handle tissuelab:// URLs
  app.on('open-url', (event, url) => {
    event.preventDefault();
    try {
      console.log('[Protocol] Open URL:', url);
      const mainWindow = getMainWindow();
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (e) {
      console.error('[Protocol] Failed handling open-url:', e);
    }
  });
}

module.exports = {
  setupProtocolHandlers
};

