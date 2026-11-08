const path = require('path');
const fs = require('fs');

/**
 * True when `target` is `dir` itself or lies inside it (after resolving `..`).
 */
function isInsideDir(dir, target) {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  // '..' or '../x' leaves dir; a name that merely starts with dots ("..foo.zip") does not.
  const leaves = rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../');
  return rel === '' || (!leaves && !path.isAbsolute(rel));
}

/**
 * Quote a value as a single-quoted PowerShell literal, so `$` and backticks
 * are not expanded. PowerShell also treats the typographic single quotes as
 * quote characters, so they are doubled as well.
 */
function psq(s) {
  return `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
}

// Node names become a directory under storage/nodes and a registry key, so the
// name must be one folder name every OS can create: no separators, no
// characters Windows forbids (< > : " / \ | ? *), no control characters.
// Anything else ("Lab's model, v2 & co") is fine: extraction passes the path as
// a spawn argument or a psq-quoted PowerShell literal, never through a shell.
// isInsideDir is the containment check.
const MODEL_NAME_FORBIDDEN_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
function isSafeModelName(name) {
  return typeof name === 'string'
    && name.length > 0
    && !MODEL_NAME_FORBIDDEN_RE.test(name)
    && name.trim() === name
    && name !== '.' && name !== '..'
    && !/\.$/.test(name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name);
}

// Pending will-download listeners per session (url -> listener), and the
// DownloadItems already bound to a request.
const pendingBySession = new WeakMap();
const claimedItems = new WeakSet();

function sameUrl(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/** The URLs a DownloadItem reports: its redirect chain plus its final URL. */
function downloadItemUrls(item) {
  const urls = [];
  try {
    if (typeof item.getURLChain === 'function') urls.push(...(item.getURLChain() || []));
  } catch {}
  try {
    if (typeof item.getURL === 'function') urls.push(item.getURL());
  } catch {}
  return urls.filter((u) => typeof u === 'string' && u);
}

/**
 * Download a file via Chromium download manager
 * @param {Object} params
 * @param {string} params.url - Download URL
 * @param {string} params.filename - Suggested filename
 * @param {boolean} params.showSaveDialog - Whether to show save dialog
 * @param {Electron.BrowserWindow} params.window - Browser window instance
 * @param {Map} params.activeDownloads - Active downloads map
 * @returns {Promise<{ok: boolean, started?: boolean, target?: string, cancelled?: boolean, error?: string}>}
 */
async function downloadFile({ url, filename, showSaveDialog, window, activeDownloads, serviceRoot }) {
  try {
    if (!url) return { ok: false, error: 'Missing URL' };
    
    const { dialog } = require('electron');
    const os = require('os');
    const suggestion = filename && typeof filename === 'string' ? filename : 'download.bin';

    let finalPath;
    
    if (showSaveDialog) {
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        defaultPath: path.join(os.homedir(), 'Downloads', suggestion),
        filters: [{ name: 'All Files', extensions: ['*'] }]
      });

      if (canceled || !filePath) {
        return { ok: false, cancelled: true };
      }

      finalPath = filePath;
    } else {
      const storagePath = path.join(serviceRoot || path.join(__dirname, '..', '..', 'service'), 'storage', 'tasknodes');
      fs.mkdirSync(storagePath, { recursive: true });

      // The filename comes from the server: keep only its last segment (either
      // separator style) so `../` cannot place the file outside storage/tasknodes.
      let safeName = path.basename(String(suggestion).replace(/\\/g, '/'));
      if (!safeName || safeName === '.' || safeName === '..') safeName = 'download.bin';

      finalPath = path.join(storagePath, safeName);
      let counter = 1;
      while (fs.existsSync(finalPath)) {
        const ext = path.extname(safeName);
        const baseName = path.basename(safeName, ext);
        finalPath = path.join(storagePath, `${baseName}-${counter}${ext}`);
        counter++;
      }
      if (!isInsideDir(storagePath, finalPath) || path.resolve(finalPath) === path.resolve(storagePath)) {
        throw new Error(`Refusing to save outside ${storagePath}: ${suggestion}`);
      }
    }

    const session = window.webContents.session;
    // One listener per pending URL, and it only takes the DownloadItem whose
    // URL (or redirect chain) is this download's, so concurrent installs each
    // get their own item. A newer request for the same URL replaces the older
    // listener so a stale one cannot take the retry's item.
    let pending = pendingBySession.get(session);
    if (!pending) {
      pending = new Map();
      pendingBySession.set(session, pending);
    }
    const previous = pending.get(url);
    if (previous) session.removeListener('will-download', previous);

    const willDownload = (_evt, item) => {
      if (claimedItems.has(item)) return;
      const itemUrls = downloadItemUrls(item);
      // Real DownloadItems always report their URL; only take an item that
      // reports none when nothing better is known (it cannot be matched).
      if (itemUrls.length && !itemUrls.some((u) => sameUrl(u, url))) return;
      claimedItems.add(item);
      session.removeListener('will-download', willDownload);
      if (pending.get(url) === willDownload) pending.delete(url);
      activeDownloads.set(url, item);

      try {
        item.setSavePath(finalPath);
      } catch (e) {
        console.error('Failed to set save path:', e.message);
      }

      item.on('updated', (_e, state) => {
        if (state === 'progressing' && !item.isPaused()) {
          const receivedBytes = item.getReceivedBytes();
          const totalBytes = item.getTotalBytes();
          window.webContents.send('download-progress', {
            url,
            state,
            receivedBytes,
            totalBytes,
            canCancel: url.includes('tasknodes')
          });
        }
      });

      item.once('done', (_e, state) => {
        activeDownloads.delete(url);
        const actualPath = item.getSavePath();
        window.webContents.send('download-progress', {
          url,
          state: state === 'completed' ? 'completed' : state,
          filePath: actualPath
        });
      });
    };

    pending.set(url, willDownload);
    session.on('will-download', willDownload);
    window.webContents.downloadURL(url);
    return { ok: true, started: true, target: finalPath };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * Extract ZIP file to storage and persist to registry (async with progress)
 * @param {Object} params
 * @param {string} params.zipPath - Path to ZIP file
 * @param {string} params.modelName - Model name
 * @param {string} params.factory - Factory category
 * @param {Electron.BrowserWindow} params.window - Browser window for progress events
 * @param {string} params.url - Download URL for event matching
 * @returns {Promise<{success: boolean, extractedPath?: string, error?: string}>}
 */
async function extractAndPersist({ zipPath, modelName, factory, window, url, serviceRoot }) {
  try {
    if (!zipPath || !modelName) {
      return { success: false, error: 'Missing zipPath or modelName' };
    }
    if (!isSafeModelName(modelName)) {
      return { success: false, error: `Invalid model name: ${modelName}` };
    }

    const { spawn } = require('child_process');

    // Extract to storage path
    const root = serviceRoot || path.join(__dirname, '..', '..', 'service');
    const nodesRoot = path.join(root, 'storage', 'nodes');
    const nodesDir = path.join(nodesRoot, modelName);
    if (!isInsideDir(nodesRoot, nodesDir) || path.resolve(nodesDir) === path.resolve(nodesRoot)) {
      return { success: false, error: `Invalid model name: ${modelName}` };
    }
    fs.mkdirSync(nodesDir, { recursive: true });

    // Emit extraction start event (use download-progress for DownloadArea compatibility)
    if (window && url) {
      window.webContents.send('download-progress', {
        url,
        state: 'extracting',
      });
    }

    // Use OS-native extraction (async)
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    const extractAsync = (command, args) => {
      return new Promise((resolve, reject) => {
        const proc = spawn(command, args);
        let stderr = '';
        
        proc.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        
        proc.on('close', (code) => {
          resolve({ success: code === 0, stderr });
        });
        
        proc.on('error', (err) => {
          reject(err);
        });
      });
    };

    let extractOk = false;
    let extractErr = '';

    try {
      if (isMac) {
        const res = await extractAsync('ditto', ['-x', '-k', zipPath, nodesDir]);
        extractOk = res.success;
        extractErr = res.stderr || '';
        if (!extractOk) {
          const res2 = await extractAsync('unzip', ['-q', zipPath, '-d', nodesDir]);
          extractOk = res2.success;
          extractErr = res2.stderr || extractErr;
        }
      } else if (isWin) {
        // Expand-Archive reports a corrupt archive as a *non-terminating* error,
        // which leaves powershell's exit code at 0; escalate it so the failure
        // is reported as one (and the tar fallback gets its turn).
        // Single-quoted PowerShell literals: a double-quoted "${path}" would
        // expand `$` and backticks, and both paths carry user-controlled text
        // (the Windows user name via userData, the bundle file name).
        const psCmd = `try { Expand-Archive -LiteralPath ${psq(zipPath)} -DestinationPath ${psq(nodesDir)} -Force -ErrorAction Stop } catch { Write-Error $_; exit 1 }`;
        const res = await extractAsync('powershell.exe', ['-NoProfile', '-Command', psCmd]);
        extractOk = res.success;
        extractErr = res.stderr || '';
        if (!extractOk) {
          const res2 = await extractAsync('tar', ['-xf', zipPath, '-C', nodesDir]);
          extractOk = res2.success;
          extractErr = res2.stderr || extractErr;
        }
      } else {
        const res = await extractAsync('unzip', ['-q', zipPath, '-d', nodesDir]);
        extractOk = res.success;
        extractErr = res.stderr || '';
        if (!extractOk) {
          const res2 = await extractAsync('bsdtar', ['-xf', zipPath, '-C', nodesDir]);
          extractOk = res2.success;
          extractErr = res2.stderr || extractErr;
        }
      }
    } catch (err) {
      extractOk = false;
      extractErr = err.message;
    }

    if (!extractOk) {
      // Emit extraction failed event
      if (window && url) {
        window.webContents.send('download-progress', {
          url,
          state: 'failed',
          error: extractErr || 'Unknown error'
        });
      }
      return { success: false, error: `Extraction failed: ${extractErr || 'Unknown error'}` };
    }

    // Find entry point (executable or main.py)
    let entryPoint = null;
    
    try {
      // Recursively search for entry point in extracted directory
      const findEntryPoint = (dir, depth = 0, maxDepth = 3) => {
        if (depth > maxDepth) return null;
        
        const items = fs.readdirSync(dir);
        
        // Look for Python entry points first (main.py, service.py, app.py)
        const pyEntry = items.find(item => ['main.py', 'service.py', 'app.py'].includes(item));
        if (pyEntry) {
          return path.join(dir, pyEntry);
        }
        
        // Look for any executable file (binaries)
        for (const item of items) {
          const fullPath = path.join(dir, item);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) {
              // Check if file is executable
              try {
                fs.accessSync(fullPath, fs.constants.X_OK);
                // Skip hidden files and common non-executable extensions
                if (!item.startsWith('.') && !item.match(/\.(txt|md|json|yaml|yml|log)$/i)) {
                  return fullPath;
                }
              } catch {}
            }
          } catch {}
        }
        
        // Search subdirectories
        for (const item of items) {
          const fullPath = path.join(dir, item);
          try {
            if (fs.statSync(fullPath).isDirectory() && !item.startsWith('.') && item !== '_internal') {
              const found = findEntryPoint(fullPath, depth + 1, maxDepth);
              if (found) return found;
            }
          } catch {}
        }
        
        return null;
      };
      
      entryPoint = findEntryPoint(nodesDir);
      
      if (!entryPoint) {
        return { success: false, error: 'Could not find entry point (executable or main.py)' };
      }
    } catch (e) {
      return { success: false, error: `Entry point detection failed: ${e.message}` };
    }
    
    // Save entry point to registry
    try {
      const registryPath = path.join(root, 'storage', 'model_registry.json');
      let registry = { category_map: {}, nodes: {}, category_display_names: {} };
      
      if (fs.existsSync(registryPath)) {
        try {
          const raw = fs.readFileSync(registryPath, 'utf8');
          registry = JSON.parse(raw) || registry;
        } catch {}
      }
      
      if (!registry.nodes) registry.nodes = {};
      
      registry.nodes[modelName] = {
        ...(registry.nodes[modelName] || {}),
        factory: factory || registry.nodes[modelName]?.factory,
        runtime: {
          ...(registry.nodes[modelName]?.runtime || {}),
          service_path: entryPoint,
        }
      };
      
      const tmpPath = registryPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf8');
      fs.renameSync(tmpPath, registryPath);
    } catch (e) {
      return { success: false, error: `Registry update failed: ${e.message}` };
    }

    // Cleanup downloaded zip
    try { fs.unlinkSync(zipPath); } catch {}

    // Emit extraction success event
    if (window && url) {
      window.webContents.send('download-progress', {
        url,
        state: 'completed',
        filePath: nodesDir
      });
    }

    return { success: true, extractedPath: nodesDir };
  } catch (error) {
    console.error('[ELECTRON] Extract error:', error);
    
    // Emit extraction failed event
    if (window && url) {
      window.webContents.send('download-progress', {
        url,
        state: 'failed',
        error: error.message
      });
    }
    
    return { success: false, error: error.message };
  }
}

module.exports = {
  downloadFile,
  extractAndPersist,
  psq,
  isSafeModelName
};

