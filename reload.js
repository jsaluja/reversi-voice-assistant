// Extension Auto-Reload Script for Development
// Add this as a keyboard shortcut: Ctrl+Shift+R (or Cmd+Shift+R on Mac)

// Method 1: Add to popup for manual reload
function reloadExtension() {
  chrome.runtime.reload();
}

// Method 2: File watcher simulation (checks every 2 seconds)
let lastModified = Date.now();

function checkForUpdates() {
  // This is a simple approach - in a real file watcher you'd check actual file timestamps
  const now = Date.now();
  if (now - lastModified > 2000) { // 2 seconds
    console.log('Checking for file changes...');
    // You can add actual file checking logic here if needed
  }
}

// Auto-check every 2 seconds (only in development)
if (chrome.runtime.getManifest().version_name === 'dev') {
  setInterval(checkForUpdates, 2000);
}

// Export for use in other scripts
if (typeof module !== 'undefined') {
  module.exports = { reloadExtension };
}
