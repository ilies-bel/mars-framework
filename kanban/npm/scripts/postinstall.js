#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

// Read version from package.json
const packageJson = require('../package.json');
const VERSION = packageJson.version;

const GITHUB_REPO = 'AvivK5498/beads-kanban-ui';
const BASE_URL = `https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}`;

// Map platform and arch to binary name
function getBinaryName() {
  const platform = process.platform;
  const arch = process.arch;

  const platformMap = {
    'darwin-arm64': 'beads-server-darwin-arm64',
    'darwin-x64': 'beads-server-darwin-x64',
    'linux-x64': 'beads-server-linux-x64',
    'win32-x64': 'beads-server-win32-x64.exe'
  };

  const key = `${platform}-${arch}`;
  const binaryName = platformMap[key];

  if (!binaryName) {
    console.error(`Unsupported platform/architecture: ${platform}/${arch}`);
    console.error('Supported combinations:');
    console.error('  - macOS arm64 (Apple Silicon)');
    console.error('  - macOS x64 (Intel)');
    console.error('  - Linux x64');
    console.error('  - Windows x64');
    process.exit(1);
  }

  return binaryName;
}

// Get the output filename (without platform suffix)
function getOutputName() {
  return process.platform === 'win32' ? 'beads-server.exe' : 'beads-server';
}

// Follow redirects and download file
function downloadFile(url, destPath, callback) {
  const file = fs.createWriteStream(destPath);

  const request = https.get(url, (response) => {
    // Handle redirects (GitHub releases use 302 redirects)
    if (response.statusCode === 301 || response.statusCode === 302) {
      const redirectUrl = response.headers.location;
      if (!redirectUrl) {
        callback(new Error('Redirect without location header'));
        return;
      }
      file.close();
      fs.unlinkSync(destPath);
      downloadFile(redirectUrl, destPath, callback);
      return;
    }

    if (response.statusCode !== 200) {
      callback(new Error(`Failed to download: HTTP ${response.statusCode}`));
      return;
    }

    response.pipe(file);

    file.on('finish', () => {
      file.close(() => callback(null));
    });
  });

  request.on('error', (error) => {
    fs.unlink(destPath, () => {}); // Delete partial file
    callback(error);
  });

  file.on('error', (error) => {
    fs.unlink(destPath, () => {}); // Delete partial file
    callback(error);
  });
}

// Make file executable on Unix systems
function makeExecutable(filePath) {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o755);
    } catch (error) {
      console.warn(`Warning: Could not make binary executable: ${error.message}`);
    }
  }
}

function main() {
  const binaryName = getBinaryName();
  const outputName = getOutputName();
  const downloadUrl = `${BASE_URL}/${binaryName}`;

  const binDir = path.join(__dirname, '..', 'bin');
  const destPath = path.join(binDir, outputName);

  // Ensure bin directory exists
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  console.log(`Downloading Beads server for ${process.platform}/${process.arch}...`);
  console.log(`  From: ${downloadUrl}`);

  downloadFile(downloadUrl, destPath, (error) => {
    if (error) {
      console.error(`\nError downloading binary: ${error.message}`);
      console.error('\nTroubleshooting:');
      console.error(`  1. Check if release v${VERSION} exists at:`);
      console.error(`     https://github.com/${GITHUB_REPO}/releases/tag/v${VERSION}`);
      console.error('  2. Check your internet connection');
      console.error('  3. Try reinstalling: npm install -g beads-ui');
      process.exit(1);
    }

    makeExecutable(destPath);
    console.log(`\nSuccessfully installed Beads server to: ${destPath}`);
    console.log('Run "bead-kanban" to start the Kanban board.');
  });
}

main();
