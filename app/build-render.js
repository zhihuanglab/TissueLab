#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('\x1b[32m%s\x1b[0m', 'Building TissueLab in standalone mode...');

const renderDir = path.join(__dirname, 'render');
const standaloneDir = path.join(renderDir, '.next', 'standalone');
const staticPath = path.join(renderDir, '.next', 'static');
const publicPath = path.join(renderDir, 'public');
const serverJsPath = path.join(standaloneDir, 'server.js');

// Resolve symlinks to actual files
function resolveSymlink(filePath, visited = new Set()) {
  try {
    if (visited.has(filePath)) {
      console.warn(`Cycle detected in symlinks: ${filePath}`);
      return filePath;
    }
    visited.add(filePath);

    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      const resolved = fs.readlinkSync(filePath);
      const absolutePath = path.isAbsolute(resolved) 
        ? resolved 
        : path.resolve(path.dirname(filePath), resolved);
      return resolveSymlink(absolutePath, visited);
    }
    return filePath;
  } catch (e) {
    return filePath;
  }
}

// Copy files recursively with symlink resolution
function copyRecursive(src, dest, options = {}) {
  const { ignore = [] } = options;
  
  if (!fs.existsSync(src)) {
    if (options.optional) {
      return;
    }
    throw new Error(`Source path does not exist: ${src}`);
  }

  const stat = fs.lstatSync(src); // Use lstat to detect symlinks
  
  if (stat.isSymbolicLink()) {
    // Resolve symlink and copy the actual file
    const resolvedPath = resolveSymlink(src);
    if (fs.existsSync(resolvedPath)) {
      const resolvedStat = fs.statSync(resolvedPath);
      if (resolvedStat.isDirectory()) {
        // If symlink points to directory, copy the directory
        copyRecursive(resolvedPath, dest, options);
      } else {
        // If symlink points to file, copy the file
        fs.copyFileSync(resolvedPath, dest);
      }
    } else {
      console.warn(`Warning: Symlink target not found: ${src} -> ${resolvedPath}`);
    }
    return;
  }
  
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    
    const files = fs.readdirSync(src);
    for (const file of files) {
      // Skip ignored files/patterns
      if (ignore.some(pattern => {
        if (typeof pattern === 'string') {
          return file === pattern || file.includes(pattern);
        }
        if (pattern instanceof RegExp) {
          return pattern.test(file);
        }
        return false;
      })) {
        continue;
      }
      
      const srcPath = path.join(src, file);
      const destPath = path.join(dest, file);
      copyRecursive(srcPath, destPath, options);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Step 0: Clean the .next folder
console.log('\x1b[33m%s\x1b[0m', 'Step 0: Cleaning .next folder...');
try {
  const nextDir = path.join(renderDir, '.next');
  if (fs.existsSync(nextDir)) {
    fs.rmSync(nextDir, { recursive: true, force: true });
    console.log('\x1b[32m%s\x1b[0m', '✓ .next folder cleaned');
  } else {
    console.log('\x1b[33m%s\x1b[0m', '.next folder does not exist, skipping cleaning step');
  }
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', '✗ Error cleaning .next folder:', error.message);
  process.exit(1);
}

// Step 1: Build the Next.js app
console.log('\x1b[33m%s\x1b[0m', 'Step 1: Building Next.js app in standalone mode...');
try {
  execSync('npm run build', { 
    cwd: renderDir, 
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' }
  });
  console.log('\x1b[32m%s\x1b[0m', '✓ Next.js build completed');
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', '✗ Error building Next.js app:', error.message);
  process.exit(1);
}

// Step 2: Verify standalone directory exists
console.log('\x1b[33m%s\x1b[0m', 'Step 2: Verifying standalone build...');
if (!fs.existsSync(standaloneDir)) {
  console.error('\x1b[31m%s\x1b[0m', `✗ Standalone directory not found at: ${standaloneDir}`);
  console.error('\x1b[31m%s\x1b[0m', 'Make sure next.config.js has output: "standalone"');
  process.exit(1);
}

if (!fs.existsSync(serverJsPath)) {
  console.error('\x1b[31m%s\x1b[0m', `✗ server.js not found at: ${serverJsPath}`);
  console.error('\x1b[31m%s\x1b[0m', 'Standalone build may have failed');
  process.exit(1);
}
console.log('\x1b[32m%s\x1b[0m', '✓ Standalone directory verified');

// Step 3: Resolve symlinks in standalone directory
console.log('\x1b[33m%s\x1b[0m', 'Step 3: Resolving symlinks in standalone directory...');
try {
  function resolveSymlinksInDir(dir) {
    if (!fs.existsSync(dir)) {
      return;
    }
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isSymbolicLink()) {
        try {
          const target = fs.readlinkSync(fullPath);
          const absoluteTarget = path.isAbsolute(target) 
            ? target 
            : path.resolve(path.dirname(fullPath), target);
          
          // Remove symlink and copy actual file/directory
          fs.unlinkSync(fullPath);
          
          if (fs.existsSync(absoluteTarget)) {
            const targetStat = fs.statSync(absoluteTarget);
            if (targetStat.isDirectory()) {
              // Copy directory recursively
              fs.mkdirSync(fullPath, { recursive: true });
              copyRecursive(absoluteTarget, fullPath);
            } else {
              // Copy file
              fs.copyFileSync(absoluteTarget, fullPath);
            }
            console.log(`  ✓ Resolved symlink: ${entry.name}`);
          } else {
            console.warn(`  ⚠ Symlink target not found: ${entry.name} -> ${target}`);
          }
        } catch (e) {
          console.warn(`  ⚠ Failed to resolve symlink ${entry.name}: ${e.message}`);
        }
      } else if (entry.isDirectory()) {
        // Recursively process subdirectories
        resolveSymlinksInDir(fullPath);
      }
    }
  }
  
  // Resolve symlinks in node_modules (most common location)
  const nodeModulesPath = path.join(standaloneDir, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    console.log('  Resolving symlinks in node_modules...');
    resolveSymlinksInDir(nodeModulesPath);
    console.log('\x1b[32m%s\x1b[0m', '  ✓ Symlinks resolved');
  } else {
    console.log('\x1b[33m%s\x1b[0m', '  ⚠ node_modules not found, skipping symlink resolution');
  }
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', '✗ Error resolving symlinks:', error.message);
  // Don't exit, as this is not critical for all builds
}

// Step 4: Copy static files to standalone directory
console.log('\x1b[33m%s\x1b[0m', 'Step 4: Copying static files...');

const standaloneNextDir = path.join(standaloneDir, '.next');

try {
  // Ensure .next directory exists in standalone
  if (!fs.existsSync(standaloneNextDir)) {
    fs.mkdirSync(standaloneNextDir, { recursive: true });
  }

  // Copy Next.js static files (.next/static -> standalone/.next/static)
  if (fs.existsSync(staticPath)) {
    const staticDest = path.join(standaloneNextDir, 'static');
    console.log(`  Copying ${staticPath} -> ${staticDest}`);
    copyRecursive(staticPath, staticDest, {
      ignore: ['.cache']
    });
    console.log('\x1b[32m%s\x1b[0m', '  ✓ Static files copied');
  } else {
    console.log('\x1b[33m%s\x1b[0m', '  ⚠ Static files directory not found (this may be normal for some builds)');
  }

  // Copy public directory files (public -> standalone/public)
  if (fs.existsSync(publicPath)) {
    const publicDest = path.join(standaloneDir, 'public');
    console.log(`  Copying ${publicPath} -> ${publicDest}`);
    copyRecursive(publicPath, publicDest);
    console.log('\x1b[32m%s\x1b[0m', '  ✓ Public files copied');
  } else {
    console.log('\x1b[33m%s\x1b[0m', '  ⚠ Public directory not found');
  }

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', '✗ Error copying files:', error.message);
  console.error(error.stack);
  process.exit(1);
}

// Step 5: Verify final structure
console.log('\x1b[33m%s\x1b[0m', 'Step 5: Verifying build structure...');

const requiredFiles = [
  { path: serverJsPath, name: 'server.js' },
  { path: path.join(standaloneDir, 'package.json'), name: 'package.json' },
  { path: path.join(standaloneDir, 'node_modules'), name: 'node_modules', isDir: true }
];

let allFilesExist = true;
for (const file of requiredFiles) {
  const exists = fs.existsSync(file.path);
  if (exists) {
    const stat = fs.statSync(file.path);
    if (file.isDir && !stat.isDirectory()) {
      console.error(`\x1b[31m%s\x1b[0m`, `✗ ${file.name} exists but is not a directory`);
      allFilesExist = false;
    } else {
      console.log(`\x1b[32m%s\x1b[0m`, `  ✓ ${file.name} found`);
    }
  } else {
    console.error(`\x1b[31m%s\x1b[0m`, `✗ ${file.name} not found at: ${file.path}`);
    allFilesExist = false;
  }
}

// Verify that critical modules exist in node_modules
if (allFilesExist) {
  const nodeModulesPath = path.join(standaloneDir, 'node_modules');
  const nextModulePath = path.join(nodeModulesPath, 'next');
  if (!fs.existsSync(nextModulePath)) {
    console.error(`\x1b[31m%s\x1b[0m`, `✗ Critical module 'next' not found in node_modules`);
    console.error(`\x1b[31m%s\x1b[0m`, `  Expected at: ${nextModulePath}`);
    console.error(`\x1b[31m%s\x1b[0m`, `  This indicates the standalone build is incomplete.`);
    console.error(`\x1b[31m%s\x1b[0m`, `  Please ensure Next.js build completed successfully.`);
    allFilesExist = false;
  } else {
    console.log(`\x1b[32m%s\x1b[0m`, `  ✓ Critical module 'next' found`);
  }
}

if (!allFilesExist) {
  console.error('\x1b[31m%s\x1b[0m', '✗ Build verification failed');
  process.exit(1);
}

console.log('\x1b[32m%s\x1b[0m', '\n✓ Build completed successfully!');
console.log('\x1b[36m%s\x1b[0m', `Standalone build ready at: ${standaloneDir}`);