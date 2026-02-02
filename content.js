/**
 * Content script for LinkedIn Connection Manager.
 * Minimal - all API calls now happen in the background service worker.
 * This script is kept for potential future DOM interaction needs.
 */

(() => {
  // Guard: detect orphaned content scripts from a previous extension reload.
  try {
    if (!chrome.runtime?.id) return;
  } catch {
    return;
  }

  console.log('[LCM] Content script loaded.');
})();
