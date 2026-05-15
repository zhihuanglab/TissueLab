const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fssync = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const { downloadFile, extractAndPersist } = require('./ipc/tasknode-helpers');
const { performGoogleOAuth, refreshGoogleToken } = require('./ipc/oauth-helpers');
const { setupProtocolHandlers } = require('./ipc/protocol-helpers');

let mainWindow;
let splashWindow;
let nextjsStandaloneProcess;
let backendServiceProcess;
let backendCheckInterval;
let backendMonitorInterval;

// Track current theme for title bar overlay
let currentTitleBarTheme = 'dark'; // Default theme

// Buffer management for stdout/stderr
const MAX_BUFFER_SIZE = 1000; // Maximum number of lines to keep in buffer
let stdoutBuffer = [];
let stderrBuffer = [];

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Store backend port (detected before starting backend)
let backendPort = 5001;

// Store Next.js port (detected before starting Next.js server)
let nextjsPort = 3000;

// Function to get backend port
function getBackendPort() {
  return backendPort;
}

// Function to get Next.js port
function getNextjsPort() {
  return nextjsPort;
}

// Function to find an available port
function findAvailablePort(startPort = 5001, maxTries = 100) {
  return new Promise((resolve, reject) => {
    let currentPort = startPort;
    let attempts = 0;
    
    const tryPort = () => {
      if (attempts >= maxTries) {
        reject(new Error(`Could not find available port after ${maxTries} attempts starting from ${startPort}`));
        return;
      }
      
      const server = net.createServer();
      server.listen(currentPort, '127.0.0.1', () => {
        server.close(() => {
          if (currentPort !== startPort) {
            console.log(`[ELECTRON] Port ${startPort} is occupied, using port ${currentPort}`);
          }
          resolve(currentPort);
        });
      });
      
      server.on('error', () => {
        attempts++;
        currentPort++;
        tryPort();
      });
    };
    
    tryPort();
  });
}

// Function to check if backend is ready
function checkBackendHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/v1/docs`, { timeout: 2000 }, (res) => {
      resolve(true);
    });
    
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Register custom deep link protocol handlers
setupProtocolHandlers(app, () => mainWindow);

// Buffer management functions
function addToBuffer(buffer, data, maxSize = MAX_BUFFER_SIZE) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, data };
  buffer.push(entry);
  
  // Keep buffer size under limit
  if (buffer.length > maxSize) {
    buffer.shift(); // Remove oldest entry
  }
  
  return buffer;
}

function getBufferContents(buffer, lines = 50) {
  return buffer.slice(-lines); // Get last N lines
}

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
// "Invalid mailbox" / "non-existent mailbox" errors and (in worst cases)
// triggering a black-frame redraw. Disabling CoreAnimation layer overlays
// stops that path without affecting WebGL / 2D canvas acceleration.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-features', 'CALayerOverlays,VideoToolboxVideoDecoder');
}

function createSplashWindow() {
  // Detect screen resolution to determine appropriate splash window size
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  
  // Determine if this is a high-resolution display (2x scaling or higher)
  const isHighRes = primaryDisplay.scaleFactor >= 2;
  
  // Set window dimensions based on resolution and platform
  let windowWidth, windowHeight;
  
  if (isWindows) {
    // Windows: use smaller, more appropriate sizes
    windowWidth = isHighRes ? 2000 : 600;
    windowHeight = isHighRes ? 1200 : 400;
  } else {
    // macOS/Linux: use larger sizes for better visibility
    windowWidth = isHighRes ? 800 : 400;
    windowHeight = isHighRes ? 500 : 300;
  }
  
  console.log(`[ELECTRON] Screen resolution: ${screenWidth}x${screenHeight}, Scale factor: ${primaryDisplay.scaleFactor}`);
  console.log(`[ELECTRON] Using splash window size: ${windowWidth}x${windowHeight} (${isHighRes ? 'high-res' : 'standard'})`);
  
  splashWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: process.platform === 'darwin'
      ? path.join(__dirname, 'assets/icons/icon.icns')
      : path.join(__dirname, 'assets/icons/icon.png')
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  
  // Center the splash window perfectly
  splashWindow.center();
  
  // Ensure it's centered after load
  splashWindow.once('ready-to-show', () => {
    splashWindow.center();
  });
  
  // Remove menu bar
  splashWindow.setMenuBarVisibility(false);
  
  // Handle splash window close
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
  
  return splashWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1800,
    height: 1000,
    resizable: true,
    show: false, // Don't show immediately, wait for splash
    // Use Windows fused title bar overlay similar to Slack
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
        color: '#0B111E',
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
  mainWindow.loadURL(`http://localhost:${getNextjsPort()}`);
  // const GPUFeatureStatus = app.getGPUFeatureStatus()
  // console.log(GPUFeatureStatus)
  
  // Show main window when it's ready and close splash
  mainWindow.once('ready-to-show', () => {
    if (splashWindow) {
      // Send message to splash window to start fade out
      splashWindow.webContents.send('main-window-ready');
      
      // Close splash window after fade animation
      setTimeout(() => {
        if (splashWindow) {
          splashWindow.close();
        }
      }, 500);
    }
    
    // Show main window
    mainWindow.show();
    
    // Focus main window
    if (mainWindow) {
      mainWindow.focus();
    }
  });

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
              mainWindow.loadURL(`http://localhost:${getNextjsPort()}`);
            }
          }
        }
      ]
    }
  ]);

  // Set new application menu
  Menu.setApplicationMenu(customMenuTemplate);

  // Open dev tools for debugging in detached window to avoid docked close issues
  // mainWindow.webContents.openDevTools({ mode: 'detach' });

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


async function startNextjsStandaloneServer() {
  // Detect available port for Next.js server
  try {
    const detectedPort = await findAvailablePort(3000, 100);
    nextjsPort = detectedPort;
    if (detectedPort !== 3000) {
      console.log(`[ELECTRON] Port 3000 is occupied, using port ${detectedPort} for Next.js server`);
    } else {
      console.log(`[ELECTRON] Using port ${detectedPort} for Next.js server`);
    }
  } catch (error) {
    console.error(`[ELECTRON] Failed to find available port for Next.js server: ${error.message}`);
    console.error('[ELECTRON] Exiting application');
    return false;
  }

  // Determine the path to standalone server
  let standaloneServerPath;
  let standaloneDir;
  
  if (app.isPackaged) {
    // Production: use unpacked path (standalone should be in asarUnpack)
    const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'render', '.next', 'standalone', 'server.js');
    
    if (fssync.existsSync(unpackedPath)) {
      // Standalone is unpacked (from asarUnpack), use directly
      standaloneServerPath = unpackedPath;
      standaloneDir = path.dirname(standaloneServerPath);
      console.log(`[ELECTRON] Using unpacked standalone server: ${standaloneServerPath}`);
    } else {
      // Fallback to asar path (should not happen if asarUnpack is configured correctly)
      const asarPath = path.join(app.getAppPath(), 'render', '.next', 'standalone', 'server.js');
      if (fssync.existsSync(asarPath)) {
        console.warn(`[ELECTRON] Standalone found in asar but not unpacked. Add to asarUnpack for better performance.`);
        standaloneServerPath = asarPath;
        standaloneDir = path.dirname(standaloneServerPath);
        console.log(`[ELECTRON] Using standalone server from asar: ${standaloneServerPath}`);
      } else {
        console.error(`[ELECTRON] Standalone server not found in unpacked or asar`);
        console.error(`[ELECTRON] Checked paths:`);
        console.error(`  - Unpacked: ${unpackedPath}`);
        console.error(`  - Asar: ${asarPath}`);
        console.error('[ELECTRON] Standalone server is required. Please ensure the Next.js standalone build is available.');
        return false;
      }
    }
  } else {
    // Development: standalone is in render directory
    standaloneServerPath = path.join(__dirname, '../render/.next/standalone/server.js');
    standaloneDir = path.dirname(standaloneServerPath);
  }

  // Check if standalone server exists
  if (!fssync.existsSync(standaloneServerPath)) {
    console.error(`[ELECTRON] Standalone server not found at: ${standaloneServerPath}`);
    console.error('[ELECTRON] Standalone server is required. Please ensure the Next.js standalone build is available.');
    return false;
  }

  console.log(`[ELECTRON] Starting Next.js standalone server: ${standaloneServerPath}`);

  // Use standalone directory and server path directly (no need to copy if unpacked)
  const actualStandaloneDir = standaloneDir;
  const actualServerPath = standaloneServerPath;

  // Set up environment variables for Next.js standalone
  process.env.PORT = nextjsPort.toString();
  process.env.HOSTNAME = '127.0.0.1';
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'production';
  }


  // Change to standalone directory and require server.js directly in main process
  const originalCwd = process.cwd();
  try {
    // Change working directory to standalone directory
    process.chdir(actualStandaloneDir);
    console.log(`[ELECTRON] Changed working directory to: ${actualStandaloneDir}`);
    
    // Require server.js directly in main process
    // Next.js server is async and won't block the main process
    console.log(`[ELECTRON] Loading Next.js standalone server from: ${actualServerPath}`);
    require(actualServerPath);
    
    console.log(`[ELECTRON] Next.js standalone server loaded successfully`);
    
    // Restore process title and app name (Next.js may have changed them)
    // On macOS, the menu bar uses process.title, so we need to set both
    process.title = 'TissueLab';
    
    // Mark as started (we don't have a process to track, but server is running)
    nextjsStandaloneProcess = { pid: process.pid }; // Dummy object to indicate server is running
    
    return true;
  } catch (error) {
    console.error(`[ELECTRON] Failed to load Next.js standalone server:`, error);
    // Restore original working directory
    process.chdir(originalCwd);
    return false;
  }
}

function checkNextjsServerReady(url, callback, maxAttempts = 30) {
  let attempts = 0;
  let callbackInvoked = false; // Prevent multiple callback invocations
  const parsed = new URL(url);
  const host = parsed.hostname || '127.0.0.1';
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  
  const check = () => {
    if (callbackInvoked) {
      return;
    }

    attempts++;
    console.log(`[ELECTRON] Checking Next.js server... (attempt ${attempts}/${maxAttempts})`);
    
    let retryScheduled = false; // Prevent multiple retries from being scheduled for the same request

    const socket = net.createConnection({ host, port });
    socket.setTimeout(2000);

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
        // Retry after a short delay
        setTimeout(check, 1000);
      }
    };

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

    socket.on('error', scheduleRetry);
    socket.on('timeout', scheduleRetry);
  };
  
  // Start checking after a short delay to allow server to start
  setTimeout(check, 2000);
}

// ipcMain.on('set-project', (event, loadData) => {
//   console.log('set-project:', loadData);
//   currentProject = loadData;
//   singleImageFlag = false;
//   projectRecorder = new ProjectBehaviorRecording(currentProject.projectName, currentProject);
// });

// Global variable to track active downloads
let activeDownloads = new Map();

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

ipcMain.handle('save-file-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog({
    ...options
  });
  return result;
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

// Get backend stdout buffer
ipcMain.handle('get-backend-stdout', (event, lines = 50) => {
  return getBufferContents(stdoutBuffer, lines);
});

// Get backend stderr buffer
ipcMain.handle('get-backend-stderr', (event, lines = 50) => {
  return getBufferContents(stderrBuffer, lines);
});

// Get backend port
ipcMain.handle('get-backend-port', () => {
  return getBackendPort();
});

// Clear buffers
ipcMain.handle('clear-backend-buffers', () => {
  stdoutBuffer = [];
  stderrBuffer = [];
  return true;
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
    const { filePath, data } = options;
    
    // Convert array back to buffer
    const buffer = Buffer.from(data);
    
    // Write the file
    await fs.writeFile(filePath, buffer);
    
    return true;
  } catch (error) {
    console.error(`Failed to write file to ${options.filePath}: ${error.message}`);
    return false;
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

// Handle download cancellation
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

// Handle application menu display (registered once at module level)
ipcMain.on('show-application-menu', (event, position) => {
  // Get the menu and show it at the button position
  const menu = Menu.getApplicationMenu();
  if (menu && mainWindow && !mainWindow.isDestroyed()) {
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

// Handle theme change to update title bar overlay colors (registered once at module level)
ipcMain.on('update-titlebar-theme', (event, theme) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  // Save current theme
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

  // Use provided theme or fall back to saved current theme
  const theme = currentTheme || currentTitleBarTheme;

  // Define base colors for light and dark themes
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

  // When modal is open, darken the title bar overlay to match the modal backdrop
  // Frontend uses bg-black/80 (rgba(0, 0, 0, 0.8)) which is 80% opacity black overlay
  // Calculate the actual visual effect: bg-black/80 on light background #F9FAFB
  // rgb(249, 250, 251) * 0.2 + rgb(0, 0, 0) * 0.8 = rgb(49.8, 50, 50.2) ≈ #323232
  let colors;
  if (isModalOpen) {
    // Match the visual effect of bg-black/80 overlay
    if (theme === 'light') {
      // bg-black/80 on #F9FAFB (light background) = ~#323232
      // Use the same background color as light mode theme, but darkened by bg-black/80 overlay effect
      const lightBg = themeColors.light.color; // #F9FAFB
      // Calculate blended color: rgba(0,0,0,0.8) on #F9FAFB ≈ #323232
      colors = {
        color: '#323232',        // Matches bg-black/80 visual effect on #F9FAFB
        symbolColor: '#E5E7EB'   // slate-200, bright enough for visibility on dark overlay
      };
    } else {
      // bg-black/80 on #0B111E ≈ pure black (very dark)
      colors = {
        color: '#000000',        // Pure black (enhanced dark)
        symbolColor: '#6B7280'   // More muted symbols
      };
    }
  } else {
    // Restore original theme colors
    colors = themeColors[theme] || themeColors.dark;
  }

  const overlaySignature = `${isModalOpen}|${theme}|${colors.color}|${colors.symbolColor}`;
  if (overlaySignature === lastTitlebarOverlaySignature) {
    return;
  }
  lastTitlebarOverlaySignature = overlaySignature;

  // Update window background color
  try {
    const bgColor = colors.color;
    mainWindow.setBackgroundColor(bgColor);
    console.log(`[ELECTRON] Updated window background color for modal overlay (${isModalOpen ? 'open' : 'closed'}): ${bgColor}`);
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
      console.log(`[ELECTRON] Updated Windows title bar overlay for modal overlay (${isModalOpen ? 'open' : 'closed'})`);
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
      console.log(`[ELECTRON] Updated macOS title bar overlay for modal overlay (${isModalOpen ? 'open' : 'closed'})`);
    } catch (error) {
      console.error('[ELECTRON] Failed to update title bar overlay:', error);
    }
  }
});

// Function to start monitoring backend service availability
function startBackendMonitoring() {
  console.log('[ELECTRON] Starting backend service monitoring...');
  const port = getBackendPort();
  
  backendMonitorInterval = setInterval(async () => {
    const isReady = await checkBackendHealth(port);
    if (isReady) {
      console.log(`[ELECTRON] Backend service detected on port ${port}! Opening main window...`);
      
      if (backendMonitorInterval) {
        clearInterval(backendMonitorInterval);
        backendMonitorInterval = null;
      }
      
      createWindow();
    }
  }, 5000);
}

function checkBackendReady(port, callback, maxAttempts = 60) {
  let attempts = 0;
  
  const check = async () => {
    attempts++;
    const isReady = await checkBackendHealth(port);
    
    if (isReady) {
      console.log(`[ELECTRON] Backend service is ready on port ${port}!`);
      if (backendCheckInterval) {
        clearInterval(backendCheckInterval);
        backendCheckInterval = null;
      }
      callback(true);
      return;
    }
    
    if (attempts < maxAttempts) {
      console.log(`[ELECTRON] Backend service not ready yet on port ${port}... (attempt ${attempts}/${maxAttempts})`);
    } else {
      console.error(`[ELECTRON] Backend service failed to start after ${maxAttempts} attempts`);
      if (backendCheckInterval) {
        clearInterval(backendCheckInterval);
        backendCheckInterval = null;
      }
      console.error('[ELECTRON] Exiting application due to backend startup failure');
      app.quit();
      callback(false);
    }
  };
  
  check();
  backendCheckInterval = setInterval(check, 1000);
}

async function spawnBackendService() {
  try {
    // Only detect port in packaged app, use fixed port 5001 in development
    let detectedPort = 5001;
    if (app.isPackaged) {
      // In packaged app, detect available port
      try {
        detectedPort = await findAvailablePort(5001, 100);
        console.log(`[ELECTRON] Packaged app: detected port ${detectedPort}`);
      } catch (error) {
        console.error(`[ELECTRON] Failed to find available port: ${error.message}`);
        console.error('[ELECTRON] Exiting application');
        app.quit();
        return false;
      }
    } else {
      // Development mode: use fixed port 5001
      console.log(`[ELECTRON] Development mode: using fixed port 5001`);
    }
    backendPort = detectedPort;
    
    // Determine the correct executable name based on platform
    const executableName = isWindows ? 'TissueLab_AI.exe' : 'TissueLab_AI';
    
    // Use the executable in the assets directory
    let backendServicePath;
    if (app.isPackaged) {
      // Try multiple possible locations for packaged app
      const possiblePaths = [
        path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'assets', 'TissueLab_AI', executableName),
        path.join(process.resourcesPath, 'electron', 'assets', 'TissueLab_AI', executableName),
        path.join(process.resourcesPath, 'assets', 'TissueLab_AI', executableName),
        path.join(__dirname, 'assets', 'TissueLab_AI', executableName)
      ];
      
      console.log(`[ELECTRON] Looking for backend executable in packaged app...`);
      console.log(`[ELECTRON] process.resourcesPath: ${process.resourcesPath}`);
      console.log(`[ELECTRON] __dirname: ${__dirname}`);
      
      for (const possiblePath of possiblePaths) {
        console.log(`[ELECTRON] Checking: ${possiblePath}`);
        if (fssync.existsSync(possiblePath)) {
          backendServicePath = possiblePath;
          console.log(`[ELECTRON] Found backend executable at: ${backendServicePath}`);
          break;
        }
      }
      
      if (!backendServicePath) {
        console.error(`[ELECTRON] Backend Service not found. Tried paths:`);
        possiblePaths.forEach(p => {
          const exists = fssync.existsSync(p);
          console.error(`  - ${p} ${exists ? '(exists)' : '(not found)'}`);
        });
        
        // Try to list directory contents for debugging
        try {
          const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked');
          if (fssync.existsSync(unpackedDir)) {
            console.log(`[ELECTRON] Contents of app.asar.unpacked:`);
            const contents = fssync.readdirSync(unpackedDir);
            contents.forEach(item => {
              const itemPath = path.join(unpackedDir, item);
              const isDir = fssync.statSync(itemPath).isDirectory();
              console.log(`  - ${item} ${isDir ? '(dir)' : '(file)'}`);
            });
            
            // Check electron subdirectory
            const electronDir = path.join(unpackedDir, 'electron');
            if (fssync.existsSync(electronDir)) {
              console.log(`[ELECTRON] Contents of electron:`);
              const electronContents = fssync.readdirSync(electronDir);
              electronContents.forEach(item => {
                const itemPath = path.join(electronDir, item);
                const isDir = fssync.statSync(itemPath).isDirectory();
                console.log(`  - ${item} ${isDir ? '(dir)' : '(file)'}`);
              });
              
              // Check assets subdirectory
              const assetsDir = path.join(electronDir, 'assets');
              if (fssync.existsSync(assetsDir)) {
                console.log(`[ELECTRON] Contents of assets:`);
                const assetsContents = fssync.readdirSync(assetsDir);
                assetsContents.forEach(item => {
                  const itemPath = path.join(assetsDir, item);
                  const isDir = fssync.statSync(itemPath).isDirectory();
                  console.log(`  - ${item} ${isDir ? '(dir)' : '(file)'}`);
                });
              }
            }
          } else {
            console.error(`[ELECTRON] app.asar.unpacked directory does not exist at: ${unpackedDir}`);
          }
        } catch (e) {
          console.error(`[ELECTRON] Could not list directory: ${e.message}`);
        }
        
        return false;
      }
    } else {
      // Development mode
      backendServicePath = path.join(__dirname, 'assets', 'TissueLab_AI', executableName);
      
      if (!fssync.existsSync(backendServicePath)) {
        console.error(`[ELECTRON] Backend Service not found at: ${backendServicePath}`);
        return false;
      }
    }
    
    // Check if file is executable (on Unix systems)
    if (!isWindows) {
      try {
        fssync.accessSync(backendServicePath, fssync.constants.X_OK);
      } catch (e) {
        console.warn(`[ELECTRON] Backend executable may not have execute permissions: ${backendServicePath}`);
        // Try to make it executable
        try {
          const { execSync } = require('child_process');
          execSync(`chmod +x "${backendServicePath}"`);
          console.log(`[ELECTRON] Made backend executable executable`);
        } catch (chmodError) {
          console.error(`[ELECTRON] Failed to make executable: ${chmodError.message}`);
        }
      }
    }
    
    console.log(`[ELECTRON] Using backend executable: ${backendServicePath}`);
    
    console.log(`[ELECTRON] Launching Backend Service: ${backendServicePath} on port ${detectedPort}`);

  // Enhanced spawn options to fix PyInstaller + Electron issues
    // Create environment object without PORT (to let backend use default port 5001)
  // PORT=3000 is set for Next.js frontend, but backend should use 5001
  const { PORT, ...envWithoutPort } = process.env;
  const spawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
      shell: false,
      cwd: path.dirname(backendServicePath),
      env: {
        ...envWithoutPort,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        _MEIPASS: path.dirname(backendServicePath),
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
        // TL_SERVICE_ROOT will be read from .env.prod file (don't override here)
        // Fix home directory path issue
        HOME: os.homedir()
      }
    };

  // Add timeout and retry mechanism for PyInstaller initialization
  let spawnAttempts = 0;
  const maxSpawnAttempts = 3;
  const spawnTimeout = 30000; // 30 seconds timeout for first startup

    const attemptSpawn = () => {
      spawnAttempts++;
      console.log(`[ELECTRON] Attempting to spawn backend service on port ${detectedPort} (attempt ${spawnAttempts}/${maxSpawnAttempts})`);
      
      // Only pass --port argument in packaged app (development uses default port 5001)
      const spawnArgs = app.isPackaged ? ['--port', detectedPort.toString()] : [];
      backendServiceProcess = spawn(backendServicePath, spawnArgs, spawnOptions);
      
      // Set up timeout for first startup (PyInstaller can be slow)
      let startupTimeout;
      if (spawnAttempts === 1) {
        startupTimeout = setTimeout(() => {
          if (backendServiceProcess && !backendServiceProcess.killed) {
            console.log('[ELECTRON] Backend service startup timeout, but process is still running...');
          }
        }, spawnTimeout);
      }

      backendServiceProcess.on('spawn', () => {
        console.log(`[ELECTRON] Backend service spawned successfully (PID: ${backendServiceProcess.pid})`);
        if (startupTimeout) {
          clearTimeout(startupTimeout);
        }
      });
      
      backendServiceProcess.on('error', (error) => {
        console.error(`[ELECTRON] Backend Service process error (attempt ${spawnAttempts}):`, error);
        
        if (spawnAttempts < maxSpawnAttempts) {
          console.log(`[ELECTRON] Retrying backend service spawn in 2 seconds...`);
          setTimeout(() => {
            if (backendServiceProcess) {
              backendServiceProcess.removeAllListeners();
              backendServiceProcess.kill();
              backendServiceProcess = null;
            }
            attemptSpawn();
          }, 2000);
        } else {
          console.error('[ELECTRON] Max spawn attempts reached, giving up');
        }
      });
      
      // Handle stdout data from backend service
      backendServiceProcess.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          addToBuffer(stdoutBuffer, output);
          console.log(`[BACKEND STDOUT] ${output}`);
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('backend-stdout', output);
          }
        }
      });

      // Handle stderr data from backend service
      backendServiceProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          addToBuffer(stderrBuffer, output);
          console.error(`[BACKEND STDERR] ${output}`);
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('backend-stderr', output);
          }
        }
      });

      backendServiceProcess.on('exit', (code, signal) => {
        console.log(`[ELECTRON] Backend Service process exited with code ${code}, signal: ${signal}`);
        
        if (spawnAttempts < maxSpawnAttempts && (code !== 0 || signal)) {
          console.log(`[ELECTRON] Backend service exited unexpectedly, retrying in 3 seconds...`);
          setTimeout(() => {
            if (backendServiceProcess) {
              backendServiceProcess.removeAllListeners();
              backendServiceProcess.kill();
              backendServiceProcess = null;
            }
            attemptSpawn();
          }, 3000);
        } else {
          backendServiceProcess = null;
        }
      });
    };

    attemptSpawn();
    
    setTimeout(() => {
      if (backendServiceProcess && backendServiceProcess.pid) {
        console.log(`[ELECTRON] Backend Service running with PID: ${backendServiceProcess.pid}`);
      }
    }, 1000);
    
    return true;
  } catch (error) {
    console.error('[ELECTRON] Error in spawnBackendService:', error);
    return false;
  }
}

// Ensure only one instance of the application is running
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[ELECTRON] Another instance is already running, exiting...');
  app.quit();
} else {
  // Handle second instance - focus the main window (like Discord)
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('[ELECTRON] Second instance detected, focusing main window...');
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    } else if (splashWindow) {
      // If main window doesn't exist yet, focus splash window
      if (splashWindow.isMinimized()) {
        splashWindow.restore();
      }
      if (!splashWindow.isVisible()) {
        splashWindow.show();
      }
      splashWindow.focus();
    }
  });
}

// Launch Django service
let appReadyInitialized = false; // Prevent multiple initializations

app.whenReady().then(() => {
  // Skip initialization if another instance is running
  if (!gotTheLock) {
    return;
  }
  
  // Prevent multiple initializations (Electron 33+ may call this multiple times)
  if (appReadyInitialized) {
    console.log('[ELECTRON] App ready handler already executed, skipping...');
    return;
  }
  appReadyInitialized = true;
  
  // Check for forced production mode via environment variable
  const forceProduction = process.env.FORCE_PRODUCTION === 'true' || process.env.FORCE_PRODUCTION === '1';
  const isDevMode = forceProduction ? false : !app.isPackaged;
  console.log(`[ELECTRON] Application ready - starting in ${isDevMode ? 'development' : 'production'} mode${forceProduction ? ' (forced via FORCE_PRODUCTION)' : ''}`);
  
  // Register as default protocol handler (tissuelab://)
  try {
    const registered = app.setAsDefaultProtocolClient('tissuelab');
    console.log('[Protocol] setAsDefaultProtocolClient(tissuelab):', registered);
  } catch (e) {
    console.warn('[Protocol] Failed to register protocol handler:', e.message);
  }

  // Create splash window first
  createSplashWindow();
  
  // Start frontend server (standalone only)
  // Both dev and production modes use standalone server
  console.log(`[ELECTRON] ${isDevMode ? 'Development' : 'Production'} mode - attempting to start Next.js standalone server...`);
  startNextjsStandaloneServer().then((standaloneStarted) => {
    if (!standaloneStarted) {
      // Standalone server is required, show error and exit
      console.error('[ELECTRON] Failed to start Next.js standalone server. Application cannot continue.');
      dialog.showErrorBox(
        'Startup Error',
        'Failed to start the frontend server. Please ensure the Next.js standalone build is available.\n\nThe application will now exit.'
      );
      app.quit();
      return;
    }
    
    // Wait for Next.js standalone server to be ready
    checkNextjsServerReady(`http://127.0.0.1:${getNextjsPort()}`, (isReady) => {
      if (isReady) {
        console.log('[ELECTRON] Next.js standalone server is ready');
        // Ensure app name and process title are correct when server is ready (Next.js may have changed them)
        process.title = 'TissueLab';
        app.setName('TissueLab');
        startBackendServiceAndWindow();
      } else {
        console.error('[ELECTRON] Next.js standalone server failed to start');
        dialog.showErrorBox(
          'Startup Error',
          'The Next.js standalone server failed to start after multiple attempts.\n\nThe application will now exit.'
        );
        app.quit();
      }
    });
  }).catch((error) => {
    console.error('[ELECTRON] Error starting Next.js standalone server:', error);
    dialog.showErrorBox(
      'Startup Error',
      `Failed to start the frontend server: ${error.message}\n\nThe application will now exit.`
    );
    app.quit();
  });
  
  let windowCreated = false; // Prevent multiple window creation
  
  async function startBackendServiceAndWindow() {
    // Prevent multiple calls
    if (windowCreated) {
      console.log('[ELECTRON] Window creation already in progress or completed, skipping...');
      return;
    }
    
    // In development mode, skip backend service and create window directly
    if (isDevMode) {
      console.log('[ELECTRON] Development mode: skipping backend service, creating window directly...');
      windowCreated = true;
      createWindow();
      return;
    }
    
    windowCreated = true;
    
    // In packaged mode, start backend service
    console.log('[ELECTRON] Starting backend service...');
    try {
      const success = await spawnBackendService();
      if (success) {
        // Wait for backend to be ready before creating window
        checkBackendReady(getBackendPort(), (isReady) => {
          if (isReady) {
            console.log('[ELECTRON] Backend service is ready - creating main window...');
            createWindow();
          } else {
            console.error('[ELECTRON] Backend service failed to start - keeping splash window and monitoring...');
            // Keep splash window open and start monitoring for backend service
            startBackendMonitoring();
          }
        });
      } else {
        console.log('[ELECTRON] Backend service not available - keeping splash window and monitoring...');
        // Keep splash window open and start monitoring for backend service
        startBackendMonitoring();
      }
    } catch (error) {
      console.error('[ELECTRON] Error starting backend service:', error);
      // Keep splash window open and start monitoring for backend service
      startBackendMonitoring();
    }
  }
  
  // registerReduxSyncHandlers();
}).catch((error) => {
  console.error('[ELECTRON] Error in app ready handler:', error);
});

// Handle macOS dock icon click - reopen window when clicked
app.on('activate', () => {
  if (mainWindow === null) {
    createSplashWindow();
    createWindow();
  }
});

// Function to cleanup all processes
function cleanupProcesses() {
  console.log('[ELECTRON] Starting cleanup process...');
  
  // Close splash window if it exists
  if (splashWindow) {
    splashWindow.close();
    splashWindow = null;
    console.log('[ELECTRON] Splash window closed');
  }
  
  // Clear buffers
  stdoutBuffer = [];
  stderrBuffer = [];
  console.log('[ELECTRON] Backend output buffers cleared');
  
  // Clear backend check interval first
  if (backendCheckInterval) {
    clearInterval(backendCheckInterval);
    backendCheckInterval = null;
    console.log('[ELECTRON] Backend check interval cleared');
  }
  
  // Clear backend monitor interval
  if (backendMonitorInterval) {
    clearInterval(backendMonitorInterval);
    backendMonitorInterval = null;
    console.log('[ELECTRON] Backend monitor interval cleared');
  }
  
  // Kill backend service process and all its children (including tasknode processes)
  if (backendServiceProcess) {
    console.log(`[ELECTRON] Killing backend service process tree (PID: ${backendServiceProcess.pid})...`);
    // Platform-specific process tree killing
    let killCommand;
    if (isWindows) {
      // Windows: use taskkill to kill process tree
      killCommand = `chcp 65001 >nul && taskkill /f /t /pid ${backendServiceProcess.pid}`;
      console.log(`[ELECTRON] Executing Windows taskkill command...`);
    } else if (isMac) {
      // macOS: Try to kill children first, then parent
      console.log(`[ELECTRON] Executing macOS process termination...`);
      
      // First try to kill children (may not exist)
      try {
        execSync(`pkill -TERM -P ${backendServiceProcess.pid}`, { 
          encoding: 'utf8', 
          timeout: 2000,
          stdio: 'pipe' 
        });
        console.log(`[ELECTRON] Children processes terminated`);
      } catch (e) {
        console.log(`[ELECTRON] No children processes found or already terminated`);
      }
      
      // Then kill parent process
      try {
        execSync(`kill -TERM ${backendServiceProcess.pid}`, { 
          encoding: 'utf8', 
          timeout: 2000,
          stdio: 'pipe' 
        });
        console.log(`[ELECTRON] Parent process terminated`);
      } catch (e) {
        console.log(`[ELECTRON] Parent process already terminated or not found`);
      }
    } else {
      // Linux: use pkill to kill process tree
      killCommand = `pkill -TERM -P ${backendServiceProcess.pid} && kill -TERM ${backendServiceProcess.pid}`;
      console.log(`[ELECTRON] Executing Linux pkill command...`);
    }
    
    if (killCommand) {
      try {
        const result = execSync(killCommand, { 
          encoding: 'utf8',
          timeout: 5000 
        });
        if (result.trim()) {
          console.log(`[ELECTRON] Process tree kill result: ${result.trim()}`);
        } else {
          console.log(`[ELECTRON] Process tree kill completed successfully (no output)`);
        }
      } catch (killError) {
        console.error(`[ELECTRON] Process tree kill failed: ${killError.message}`);
      }
    }
    
    // Monitor process exit
    backendServiceProcess.once('exit', (code, signal) => {
      console.log(`[ELECTRON] Backend service process terminated (code: ${code}, signal: ${signal})`);
    });
  }
  
  // Next.js standalone server runs in main process, no need to kill
  // The server will be cleaned up when the app quits
  if (nextjsStandaloneProcess) {
    console.log('[ELECTRON] Next.js standalone server is running in main process');
    nextjsStandaloneProcess = null;
  }
}

// close backend processes
app.on('before-quit', (event) => {
  console.log('[ELECTRON] Application is quitting...');
  cleanupProcesses();
});

// Handle window close - ensure cleanup happens
app.on('window-all-closed', () => {
  console.log('[ELECTRON] All windows closed');
  // On macOS, keep the app running even when all windows are closed
  // The app will quit when the user explicitly quits via Cmd+Q or the menu
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle unexpected exits
process.on('SIGINT', () => {
  console.log('[ELECTRON] Received SIGINT, cleaning up...');
  cleanupProcesses();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[ELECTRON] Received SIGTERM, cleaning up...');
  cleanupProcesses();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[ELECTRON] Uncaught Exception:', error);
  cleanupProcesses();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ELECTRON] Unhandled Rejection at:', promise, 'reason:', reason);
  cleanupProcesses();
  process.exit(1);
});

// Handle quitting the app
app.on('quit', () => {
});
