const fs = require('fs');
const path = require('path');

// Setup standalone assets
function setupStandaloneAssets() {
  const sourceStaticDir = path.join(__dirname, '.next/static');
  const targetStaticDir = path.join(__dirname, '.next/standalone/.next/static');
  
  const sourcePublicDir = path.join(__dirname, 'public');
  const targetPublicDir = path.join(__dirname, '.next/standalone/public');
  
  console.log('Setting up standalone assets...');
  
  // Ensure target directories exist
  if (!fs.existsSync(targetStaticDir)) {
    fs.mkdirSync(targetStaticDir, { recursive: true });
  }
  
  if (!fs.existsSync(targetPublicDir)) {
    fs.mkdirSync(targetPublicDir, { recursive: true });
  }
  
  // Copy static resources
  if (fs.existsSync(sourceStaticDir)) {
    copyDir(sourceStaticDir, targetStaticDir);
    console.log('Static assets copied to standalone directory');
  } else {
    console.log('Static directory not found, skipping...');
  }
  
  // Copy public resources
  if (fs.existsSync(sourcePublicDir)) {
    copyDir(sourcePublicDir, targetPublicDir);
    console.log('Public assets copied to standalone directory');
  } else {
    console.log('Public directory not found, skipping...');
  }
  
  console.log('Standalone setup completed!');
}

function copyDir(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Run setup
setupStandaloneAssets();
