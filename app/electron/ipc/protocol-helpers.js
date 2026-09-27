const path = require('path');

function isTissueLabDeepLink(value) {
  // Windows may pass a registered URL as `tissuelab:\\...` while macOS/Linux
  // normally use `tissuelab://...`. The scheme is what matters here.
  return typeof value === 'string' && /^tissuelab:/i.test(value);
}

function findDeepLink(argv) {
  return Array.isArray(argv) ? argv.find(isTissueLabDeepLink) : undefined;
}

/**
 * Register the tissuelab:// protocol.
 *
 * In development Electron must be registered with the entry script as an
 * extra argument. Without it, Windows treats the deep-link URL as the app
 * path and tries to launch e.g. `C:\\Windows\\System32\\tissuelab:\\...`.
 */
function registerProtocolClient(app, entryScript) {
  if (process.defaultApp || !app.isPackaged) {
    const script = path.resolve(entryScript || process.argv[1]);
    return app.setAsDefaultProtocolClient('tissuelab', process.execPath, [script]);
  }

  return app.setAsDefaultProtocolClient('tissuelab');
}

/**
 * Set up foregrounding and deep-link handling for the Electron app.
 *
 */
function setupProtocolHandlers(app, getMainWindow) {
  let pendingDeepLink = findDeepLink(process.argv);

  const focusMainWindow = () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return false;

    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    pendingDeepLink = undefined;
    return true;
  };

  const handleDeepLink = (deepLink) => {
    if (!isTissueLabDeepLink(deepLink)) return;
    console.log('[Protocol] Open URL:', deepLink);
    pendingDeepLink = deepLink;
    focusMainWindow();
  };

  if (!app.requestSingleInstanceLock()) {
    console.warn('[Protocol] Another TissueLab instance owns the lock', {
      executable: process.execPath,
      userData: app.getPath('userData'),
      argv: process.argv,
    });
    app.quit();
    return { acquiredSingleInstanceLock: false, handleDeepLink };
  }

  console.log('[Protocol] Single-instance lock acquired', {
    executable: process.execPath,
    userData: app.getPath('userData'),
    argv: process.argv,
  });

  // Windows passes the URL in argv when a second instance is launched.
  app.on('second-instance', (event, argv) => {
    handleDeepLink(findDeepLink(argv));
  });

  // macOS sends the URL through open-url.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    try {
      handleDeepLink(url);
    } catch (error) {
      console.error('[Protocol] Failed handling open-url:', error);
    }
  });

  // The first window may not exist when Electron receives the initial argv.
  app.on('browser-window-created', () => {
    if (pendingDeepLink) setImmediate(focusMainWindow);
  });

  return {
    acquiredSingleInstanceLock: true,
    handleDeepLink,
  };
}

module.exports = {
  setupProtocolHandlers,
  registerProtocolClient,
  isTissueLabDeepLink,
  findDeepLink,
};

