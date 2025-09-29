#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('\x1b[32m%s\x1b[0m', 'Building TissueLab in standalone mode...');

// Step 1: Build the Next.js app
console.log('\x1b[33m%s\x1b[0m', 'Step 1: Building Next.js app...');
try {
  execSync('npm run build', { 
    cwd: path.join(__dirname, 'render'), 
    stdio: 'inherit' 
  });
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Error building Next.js app:', error.message);
  process.exit(1);
}

// Step 2: Copy static files to standalone directory
console.log('\x1b[33m%s\x1b[0m', 'Step 2: Copying static files...');

const renderDir = path.join(__dirname, 'render');
const staticPath = path.join(renderDir, '.next', 'static');
const standalonePath = path.join(renderDir, '.next', 'standalone', '.next');

if (!fs.existsSync(staticPath)) {
  console.error('\x1b[31m%s\x1b[0m', 'Error: Static files not found!');
  process.exit(1);
}

if (!fs.existsSync(standalonePath)) {
  console.error('\x1b[31m%s\x1b[0m', 'Error: Standalone directory not found!');
  process.exit(1);
}

// Copy static files recursively
function copyRecursive(src, dest) {
  if (fs.statSync(src).isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const files = fs.readdirSync(src);
    files.forEach(file => {
      copyRecursive(path.join(src, file), path.join(dest, file));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

try {
  // Copy Next.js static files
  copyRecursive(staticPath, path.join(standalonePath, 'static'));
  console.log('\x1b[32m%s\x1b[0m', 'Next.js static files copied successfully!');
  
  // Copy public directory files
  const publicPath = path.join(renderDir, 'public');
  const publicDestPath = path.join(renderDir, '.next', 'standalone');
  
  if (fs.existsSync(publicPath)) {
    copyRecursive(publicPath, path.join(publicDestPath, 'public'));
    console.log('\x1b[32m%s\x1b[0m', 'Public files copied successfully!');
  } else {
    console.log('\x1b[33m%s\x1b[0m', 'Warning: Public directory not found');
  }
  
  console.log('\x1b[32m%s\x1b[0m', 'All static files copied successfully!');
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Error copying static files:', error.message);
  process.exit(1);
}

console.log('\x1b[32m%s\x1b[0m', 'Build completed successfully!');
console.log('\x1b[36m%s\x1b[0m', 'You can now run: npm run start-standalone'); 