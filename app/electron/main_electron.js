const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const express = require('express');
const fs = require('fs').promises;
const fssync = require('fs');
const os = require('os');
// const ProjectBehaviorRecording = require('./services/recording/projectBehaviorRecording');

let mainWindow;
let expressApp;
let expressServer;

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Enable GPU acceleration and monitor rendering
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-vsync');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1800,
    height: 1000,
    resizable: true,
    ...(isWindows ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#0f172a',
        symbolColor: '#e2e8f0',
        height: 56
      }
    } : {}),
    backgroundColor: '#0f172a',
    // For Mac, use hidden title bar like Slack for modern look
    ...(isMac ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#0f172a',
        symbolColor: '#e2e8f0',
        height: 28
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
  mainWindow.loadURL('http://localhost:3000');
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
              mainWindow.loadURL('http://localhost:3000');
            }
          }
        }
      ]
    }
  ]);

  // Set new application menu
  Menu.setApplicationMenu(customMenuTemplate);

  // Handle IPC messages from renderer
  const { ipcMain } = require('electron');
  
  ipcMain.on('show-application-menu', (event, position) => {
    // Get the menu and show it at the button position
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

function startExpressServer() {
  expressApp = express();
  const frontEndPath = path.join(__dirname, '../render/out');
  expressApp.use(express.static(frontEndPath));

  expressServer = expressApp.listen(3000, () => {
    console.log('Express server running on http://localhost:3000');
  });
}

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

// Download a remote URL via Chromium and prompt user to save in the current window
ipcMain.handle('download-signed-url', async (event, payload) => {
  try {
    const { url, filename } = payload || {};
    if (!url) return { ok: false, error: 'Missing URL' };
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const suggestion = filename && typeof filename === 'string' ? filename : 'download.bin';
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: suggestion });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    
    const userDir = require('path').dirname(filePath);
    const userBaseName = require('path').basename(filePath, require('path').extname(filePath));

    // Force the correct extension based on suggested filename
    let correctedPath = filePath;
    if (filename && filename.includes('.')) {
      const suggestedExt = filename.substring(filename.lastIndexOf('.'));
      const userExt = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '';
      
      if (!userExt || userExt !== suggestedExt) {
        const basePath = userExt ? filePath.substring(0, filePath.lastIndexOf('.')) : filePath;
        correctedPath = basePath + suggestedExt;
      }
    }

    const session = win.webContents.session;
    const willDownload = (_evt, item) => {
      session.removeListener('will-download', willDownload);
      
      console.log('🔍 [Main Process] Download Debug:');
      console.log('- URL:', url);
      console.log('- User selected path:', filePath);
      console.log('- Suggested filename:', filename);
      console.log('- Corrected path:', correctedPath);
      
      // Use the pre-corrected path
      try {
        item.setSavePath(correctedPath);
        console.log('Set save path to:', correctedPath);
      } catch (e) {
        console.error('Failed to set save path:', e.message);
        // Fallback to original path
        try {
          item.setSavePath(filePath);
          console.log('🔄 Fallback to original path:', filePath);
        } catch (e2) {
          console.error('Fallback also failed:', e2.message);
        }
      }
      
      item.on('updated', (_e, state) => {
        if (state === 'progressing' && !item.isPaused()) {
          const receivedBytes = item.getReceivedBytes();
          const totalBytes = item.getTotalBytes();
          win.webContents.send('download-progress', { url, state, receivedBytes, totalBytes });
        }
      });
      item.once('done', (_e, state) => {
        const actualPath = item.getSavePath();
        console.log('- Download completed, actual save path:', actualPath);
        win.webContents.send('download-progress', { url, state: state === 'completed' ? 'completed' : state, filePath: actualPath });
      });
    };
    session.once('will-download', willDownload);
    win.webContents.downloadURL(url);
    return { ok: true, started: true, target: filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
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

// Launch Django service
app.on('ready', () => {

  // start express server
  // startExpressServer();
  createWindow();
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
    createWindow();
  }
});

// close express server
app.on('before-quit', () => {
  if (expressServer) {
    expressServer.close(() => {
      console.log('Express server has been closed.');
    });
  }
  // clearInterval(saveCoordinatesInterval);
});

// Handle quitting the app
app.on('quit', () => {
});
