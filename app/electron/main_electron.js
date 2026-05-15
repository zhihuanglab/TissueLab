const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fssync = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const { performGoogleOAuth, refreshGoogleToken } = require('./ipc/oauth-helpers');
const { setupProtocolHandlers } = require('./ipc/protocol-helpers');
// const ProjectBehaviorRecording = require('./services/recording/projectBehaviorRecording');

let mainWindow;

let currentTitleBarTheme = 'dark';

let activeDownloads = new Map();

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Store backend port (default to 5001)
let backendPort = 5001;
const NEXTJS_URL = 'http://localhost:3000';

// Function to get backend port
function getBackendPort() {
  return backendPort;
}

function checkNextjsServerReady(url, callback, maxAttempts = 120, retryIntervalMs = 200, initialDelayMs = 0) {
  let attempts = 0;
  let callbackInvoked = false;
  const parsed = new URL(url);
  const host = parsed.hostname || '127.0.0.1';
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);

  const check = () => {
    if (callbackInvoked) {
      return;
    }

    attempts++;
    console.log(`[ELECTRON] Checking Next.js server... (attempt ${attempts}/${maxAttempts})`);

    const socket = net.createConnection({ host, port });
    socket.setTimeout(800);
    let retryScheduled = false;

    socket.on('connect', () => {
      socket.destroy();

      // Verify the server is actually serving HTTP responses.
      const req = http.get(url, { timeout: 2000 }, (res) => {
        res.resume();
        if (callbackInvoked || retryScheduled) {
          return;
        }

        const statusCode = res.statusCode || 0;
        if (statusCode >= 200 && statusCode < 500) {
          console.log(`[ELECTRON] Next.js server is ready on ${host}:${port} (HTTP ${statusCode})`);
          callbackInvoked = true;
          callback(true);
        } else {
          scheduleRetry();
        }
      });

      req.on('error', scheduleRetry);
      req.on('timeout', () => {
        req.destroy();
        scheduleRetry();
      });
    });

    const scheduleRetry = () => {
      if (callbackInvoked || retryScheduled) {
        return;
      }
      retryScheduled = true;
      socket.destroy();
      if (attempts >= maxAttempts) {
        console.error(`[ELECTRON] Next.js server failed to start after ${maxAttempts} attempts`);
        callbackInvoked = true;
        callback(false);
      } else {
        setTimeout(check, retryIntervalMs);
      }
    };

    socket.on('error', scheduleRetry);
    socket.on('timeout', scheduleRetry);
  };

  if (initialDelayMs > 0) {
    setTimeout(check, initialDelayMs);
  } else {
    check();
  }
}

// Register custom deep link protocol handlers
setupProtocolHandlers(app, () => mainWindow);

// Configure GPU features for best compatibility and performance:
// - Enable WebGL (required for image viewer)
// - Allow WebGL even if GPU is blacklisted
// - Enable 2D canvas acceleration for better performance
app.commandLine.appendSwitch('enable-webgl'); // Keep WebGL enabled
app.commandLine.appendSwitch('ignore-gpu-blacklist'); // Allow WebGL even if GPU is blacklisted
app.commandLine.appendSwitch('enable-accelerated-2d-canvas'); // Enable 2D canvas acceleration

// Disable GPU features that may cause rendering artifacts when window is resized/scaled:
// - Disable GPU rasterization to prevent known artifacts
// - Enable software rasterizer as fallback (won't affect WebGL)
// app.commandLine.appendSwitch('disable-gpu-rasterization'); // Disable GPU rasterization
app.commandLine.appendSwitch('enable-software-rasterizer'); // Enable software rasterizer as fallback

// macOS Metal compositor occasionally tries to ProduceOverlay against a stale
// SharedImage mailbox after window resize / focus change, spamming
// "Invalid mailbox" / "non-existent mailbox" errors. Disabling CoreAnimation
// layer overlays stops that path without affecting WebGL / 2D canvas.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-features', 'CALayerOverlays,VideoToolboxVideoDecoder');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1800,
    height: 1000,
    resizable: true,
    ...(isWindows ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#F9FAFB',
        symbolColor: '#000000',
        height: 40
      }
    } : {}),
    backgroundColor: '#F9FAFB',
    // For Mac, use hidden title bar like Slack for modern look
    ...(isMac ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#0f172a',
        symbolColor: '#e2e8f0',
        height: 22
      }
    } : {}),
    // trafficLightPosition: { x: 20, y: 20 }, // Position the traffic lights
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: true,
      webgl: true
    },
    icon: process.platform === 'darwin'
      ? path.join(__dirname, 'assets/icons/icon.icns')  // macOS icon
      : path.join(__dirname, 'assets/icons/icon.png')   // Windows/Linux icon
  });

  // Track the main window as soon as it's created
  // trackWindow(mainWindow);

  // Graphics Feature Status
  // mainWindow.loadURL('chrome://gpu');
  mainWindow.loadURL(NEXTJS_URL);
  // const GPUFeatureStatus = app.getGPUFeatureStatus()
  // console.log(GPUFeatureStatus)

  const defaultMenu = Menu.getApplicationMenu().items;

  // For Debug use
  const customMenuTemplate = Menu.buildFromTemplate([
    ...defaultMenu,  // Keep the default menu items
    {
      label: 'Reload Dash',
      submenu: [
        {
          label: 'Reload',
          click: () => {
            if (mainWindow) {
              mainWindow.loadURL(NEXTJS_URL);
            }
          }
        }
      ]
    }
  ]);

  // Set new application menu
  Menu.setApplicationMenu(customMenuTemplate);

  // Open dev tools for debugging in detached window to avoid docked close issues
  mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Handle window close event
  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  // Handle window close button click - for Mac, this should quit the app
  mainWindow.on('close', function (event) {
    // On Mac, if the user clicks the red close button, quit the app
    if (process.platform === 'darwin') {
      app.quit();
    }
  });
}

// Handle IPC messages from renderer
// These handlers are registered once outside createWindow() to prevent duplicate listeners

ipcMain.on('show-application-menu', (event, position) => {
  // Get the menu and show it at the button position
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const menu = Menu.getApplicationMenu();
  if (menu) {
    if (position && position.x !== undefined && position.y !== undefined) {
      // Use the position sent from renderer
      menu.popup({
        window: mainWindow,
        x: position.x,
        y: position.y
      });
    } else {
      // Fallback to default position
      menu.popup({
        window: mainWindow,
        x: 10,
        y: 30
      });
    }
  }
});

// Handle theme change to update title bar overlay colors
ipcMain.on('update-titlebar-theme', (event, theme) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  currentTitleBarTheme = theme || 'dark';

  // Define colors for light and dark themes
  const themeColors = {
    light: {
      color: '#F9FAFB',        // Light gray background (slate-50)
      symbolColor: '#000000'   // Black symbols (buttons)
    },
    dark: {
      color: '#0B111E',        // Dark background
      symbolColor: '#E2E8F0'   // Light gray symbols on hover (slate-200)
    }
  };

  const colors = themeColors[currentTitleBarTheme] || themeColors.dark;

  // Update window background color
  try {
    const bgColor = colors.color;
    mainWindow.setBackgroundColor(bgColor);
    console.log(`[ELECTRON] Updated window background color for ${currentTitleBarTheme} theme: ${bgColor}`);
  } catch (error) {
    console.error('[ELECTRON] Failed to update window background color:', error);
  }

  // Update title bar overlay for Windows
  if (isWindows && mainWindow.setTitleBarOverlay) {
    try {
      mainWindow.setTitleBarOverlay({
        color: colors.color,
        symbolColor: colors.symbolColor,
        height: 40
      });
      console.log(`[ELECTRON] Updated Windows title bar overlay for ${currentTitleBarTheme} theme`);
    } catch (error) {
      console.error('[ELECTRON] Failed to update title bar overlay:', error);
    }
  }

  // Update title bar overlay for macOS
  if (isMac && mainWindow.setTitleBarOverlay) {
    try {
      mainWindow.setTitleBarOverlay({
        color: colors.color,
        symbolColor: colors.symbolColor,
        height: 22
      });
      console.log(`[ELECTRON] Updated macOS title bar overlay for ${currentTitleBarTheme} theme`);
    } catch (error) {
      console.error('[ELECTRON] Failed to update title bar overlay:', error);
    }
  }
});

// Last applied modal titlebar state — skip duplicate IPC when nothing changed
let lastTitlebarOverlaySignature = '';

// Handle modal overlay state to update title bar overlay (for visual consistency)
ipcMain.on('update-titlebar-overlay', (event, { isModalOpen, currentTheme }) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const theme = currentTheme || currentTitleBarTheme;

  const themeColors = {
    light: {
      color: '#F9FAFB',
      symbolColor: '#000000'
    },
    dark: {
      color: '#0B111E',
      symbolColor: '#E2E8F0'
    }
  };

  let colors;
  if (isModalOpen) {
    if (theme === 'light') {
      colors = {
        color: '#323232',
        symbolColor: '#E5E7EB'
      };
    } else {
      colors = {
        color: '#000000',
        symbolColor: '#6B7280'
      };
    }
  } else {
    colors = themeColors[theme] || themeColors.dark;
  }

  const overlaySignature = `${isModalOpen}|${theme}|${colors.color}|${colors.symbolColor}`;
  if (overlaySignature === lastTitlebarOverlaySignature) {
    return;
  }
  lastTitlebarOverlaySignature = overlaySignature;

  try {
    const bgColor = colors.color;
    mainWindow.setBackgroundColor(bgColor);
    console.log(`[ELECTRON] Updated window background color for modal overlay (${isModalOpen ? 'open' : 'closed'}): ${bgColor}`);
  } catch (error) {
    console.error('[ELECTRON] Failed to update window background color:', error);
  }

  if (isWindows && mainWindow.setTitleBarOverlay) {
    try {
      mainWindow.setTitleBarOverlay({
        color: colors.color,
        symbolColor: colors.symbolColor,
        height: 40
      });
      console.log(`[ELECTRON] Updated Windows title bar overlay for modal overlay (${isModalOpen ? 'open' : 'closed'})`);
    } catch (error) {
      console.error('[ELECTRON] Failed to update title bar overlay:', error);
    }
  }

  if (isMac && mainWindow.setTitleBarOverlay) {
    try {
      mainWindow.setTitleBarOverlay({
        color: colors.color,
        symbolColor: colors.symbolColor,
        height: 22
      });
      console.log(`[ELECTRON] Updated macOS title bar overlay for modal overlay (${isModalOpen ? 'open' : 'closed'})`);
    } catch (error) {
      console.error('[ELECTRON] Failed to update title bar overlay:', error);
    }
  }
});

ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  return result;
});

ipcMain.handle('open-file-dialog', async (event, options) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    ...options
  });
  return result;
});

// save file dialog
ipcMain.handle('save-file-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog({
    ...options
  });
  return result;
});

const { downloadFile, extractAndPersist } = require('./ipc/tasknode-helpers');

// Download a remote URL via Chromium
ipcMain.handle('download-signed-url', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  return downloadFile({
    url: payload?.url,
    filename: payload?.filename,
    showSaveDialog: payload?.showSaveDialog !== false,
    window: win,
    activeDownloads
  });
});

// Extract ZIP and persist to registry
ipcMain.handle('extract-zip-and-persist', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  return extractAndPersist({
    zipPath: payload?.zipPath,
    modelName: payload?.modelName,
    factory: payload?.factory,
    window: win,
    url: payload?.url
  });
});

ipcMain.handle('cancel-download', async (event, downloadUrl) => {
  const downloadItem = activeDownloads.get(downloadUrl);

  if (downloadItem && !downloadItem.isDone()) {
    downloadItem.cancel();
    activeDownloads.delete(downloadUrl);
    console.log('Download cancelled by user');
    return { ok: true, cancelled: true };
  }

  return { ok: false, error: 'No active download found' };
});

// list files in directory
ipcMain.handle('list-local-files', async (event, dirPath) => {
  // Default to Desktop if dirPath is empty
  const absPath = dirPath && dirPath.length > 0 ? dirPath : path.join(os.homedir(), 'Desktop');
  const files = await fs.readdir(absPath, { withFileTypes: true });
  const result = [];
  for (const file of files) {
    // Skip hidden files (those starting with a dot)
    if (file.name.startsWith('.')) continue;
    const filePath = path.join(absPath, file.name);
    try {
      const stat = await fs.stat(filePath);
      result.push({
        name: file.name,
        path: filePath,
        is_dir: file.isDirectory(),
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs / 1000),
      });
    } catch (err) {
      // Skip files/directories that cannot be accessed
      continue;
    }
  }
  return result;
});

// create folder
ipcMain.handle('create-local-folder', async (event, folderPath) => {
  await fs.mkdir(folderPath, { recursive: true });
  return true;
});

// rename file
ipcMain.handle('rename-local-file', async (event, oldPath, newPath) => {
  await fs.rename(oldPath, newPath);
  return true;
});

// Reveal file or folder in Explorer / Finder / file manager
ipcMain.handle('show-item-in-folder', async (event, fullPath) => {
  if (!fullPath || typeof fullPath !== 'string') {
    throw new Error('Invalid path');
  }
  shell.showItemInFolder(fullPath);
  return true;
});

// delete files
ipcMain.handle('delete-local-files', async (event, paths) => {
  for (const p of paths) {
    if (fssync.lstatSync(p).isDirectory()) {
      await fs.rm(p, { recursive: true, force: true });
    } else {
      await fs.unlink(p);
    }
  }
  return true;
});

// move files
ipcMain.handle('move-local-files', async (event, paths, destDir) => {
  for (const p of paths) {
    const base = path.basename(p);
    await fs.rename(p, path.join(destDir, base));
  }
  return true;
});

// upload files
ipcMain.handle('upload-local-files', async (event, destDir, files) => {
  for (const file of files) {
    const base = path.basename(file);
    await fs.copyFile(file, path.join(destDir, base));
  }
  return true;
});

// path join
ipcMain.handle('path-join', (event, ...pathsToJoin) => {
  return path.join(...pathsToJoin);
});

// read file content
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const fileBuffer = await fs.readFile(filePath);
    return fileBuffer;
  } catch (error) {
    throw new Error(`Failed to read file: ${error.message}`);
  }
});

// write file content
ipcMain.handle('write-file', async (event, options) => {
  try {
    const { filePath, content } = options;
    
    // Ensure directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    
    // Write file
    await fs.writeFile(filePath, content, 'utf8');
    return { success: true };
  } catch (error) {
    throw new Error(`Failed to write file: ${error.message}`);
  }
});

// Google OAuth - PKCE-based browser authentication
// Desktop client "secret" is bundled with the app — not truly confidential per Google's OAuth spec
ipcMain.handle('google-oauth', async (event, { clientId, clientSecret }) => {
  return await performGoogleOAuth({
    clientId,
    clientSecret,
    openExternal: shell.openExternal.bind(shell)
  });
});

// Refresh Google OAuth token using refresh_token
ipcMain.handle('google-refresh-token', async (event, { refreshToken, clientId, clientSecret }) => {
  return await refreshGoogleToken({
    refreshToken,
    clientId,
    clientSecret
  });
});

// Save refresh token securely using Electron's safeStorage
ipcMain.handle('save-refresh-token', async (event, { token }) => {
  try {
    if (!token) {
      throw new Error('Token is required');
    }
    
    // Use safeStorage to encrypt the token
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(token);
      const tokenPath = path.join(app.getPath('userData'), 'refresh_token.enc');
      await fs.writeFile(tokenPath, encrypted);
      console.log('[Auth] Refresh token saved securely');
      return { success: true };
    } else {
      console.warn('[Auth] Encryption not available, storing token in plain text (not recommended)');
      const tokenPath = path.join(app.getPath('userData'), 'refresh_token.txt');
      await fs.writeFile(tokenPath, token, 'utf8');
      
      // Set restrictive file permissions on Unix-like systems
      if (process.platform !== 'win32') {
        await fs.chmod(tokenPath, 0o600);
        console.log('[Auth] Set file permissions to 0600 (owner read/write only)');
      }
      
      return { success: true, warning: 'Stored in plain text' };
    }
  } catch (error) {
    console.error('[Auth] Failed to save refresh token:', error);
    return { success: false, error: error.message };
  }
});

// Get refresh token from secure storage
ipcMain.handle('get-refresh-token', async () => {
  try {
    const encryptedPath = path.join(app.getPath('userData'), 'refresh_token.enc');
    const plainPath = path.join(app.getPath('userData'), 'refresh_token.txt');
    
    // Try encrypted file first
    try {
      const encrypted = await fs.readFile(encryptedPath);
      if (safeStorage.isEncryptionAvailable()) {
        const token = safeStorage.decryptString(encrypted);
        console.log('[Auth] Retrieved encrypted refresh token');
        return { success: true, token };
      } else {
        console.error('[Auth] Cannot decrypt token - encryption not available');
        return { success: false, error: 'Encryption not available' };
      }
    } catch (encryptedError) {
      // Encrypted file doesn't exist or can't be read, try plain text
      if (encryptedError.code !== 'ENOENT') {
        // Real error, not just file missing
        throw encryptedError;
      }
    }
    
    // Try plain text file
    try {
      const token = await fs.readFile(plainPath, 'utf8');
      console.log('[Auth] Retrieved plain text refresh token');
      return { success: true, token };
    } catch (plainError) {
      if (plainError.code === 'ENOENT') {
        // No token found
        return { success: false, error: 'No refresh token found' };
      }
      throw plainError;
    }
  } catch (error) {
    console.error('[Auth] Failed to get refresh token:', error);
    return { success: false, error: error.message };
  }
});

// Delete refresh token from storage
ipcMain.handle('delete-refresh-token', async () => {
  try {
    const encryptedPath = path.join(app.getPath('userData'), 'refresh_token.enc');
    const plainPath = path.join(app.getPath('userData'), 'refresh_token.txt');
    
    // Try to delete both files (ignore ENOENT errors if they don't exist)
    try {
      await fs.unlink(encryptedPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error; // Re-throw if it's not a "file not found" error
      }
    }
    
    try {
      await fs.unlink(plainPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error; // Re-throw if it's not a "file not found" error
      }
    }
    
    console.log('[Auth] Refresh token deleted');
    return { success: true };
  } catch (error) {
    console.error('[Auth] Failed to delete refresh token:', error);
    return { success: false, error: error.message };
  }
});

// Get backend port
ipcMain.handle('get-backend-port', () => {
  return getBackendPort();
});


// Launch Django service
app.whenReady().then(() => {

  // Register as default protocol handler (tissuelab://)
  try {
    const registered = app.setAsDefaultProtocolClient('tissuelab');
    console.log('[Protocol] setAsDefaultProtocolClient(tissuelab):', registered);
  } catch (e) {
    console.warn('[Protocol] Failed to register protocol handler:', e.message);
  }

  checkNextjsServerReady(NEXTJS_URL, (isReady) => {
    if (isReady) {
      createWindow();
      return;
    }

    console.error('[ELECTRON] Next.js server failed to start after multiple attempts. Exiting application.');
    app.quit();
  });
  // registerReduxSyncHandlers();
});

// Handle app close
app.on('window-all-closed', () => {
  // On macOS, keep the app running even when all windows are closed
  // The app will quit when the user explicitly quits via Cmd+Q or the menu
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle macOS dock icon click - reopen window when clicked
app.on('activate', () => {
  if (mainWindow === null) {
    checkNextjsServerReady(NEXTJS_URL, (isReady) => {
      if (isReady) {
        createWindow();
      } else {
        console.error('[ELECTRON] Next.js server is not ready yet, skip window creation on activate.');
      }
    }, 30);
  }
});

// Handle quitting the app
app.on('quit', () => {
});
