/**
 * Structured logger for LinkedIn Connection Manager.
 * Persists logs to chrome.storage.local with a ring buffer.
 * Works in both service worker (background.js) and page contexts (sidepanel.js).
 */

// eslint-disable-next-line no-unused-vars
const Logger = (() => {
  const STORAGE_KEY = 'lcm_logs';
  const LEVEL_KEY = 'lcm_log_level';
  const MAX_ENTRIES = 2000;
  const FLUSH_DELAY_MS = 500;
  const MAX_MSG_LEN = 200;
  const MAX_DATA_LEN = 500;

  const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

  let buffer = [];
  let flushTimer = null;
  let currentLevel = LEVELS.INFO;

  // ---- Internal ----

  function truncate(str, max) {
    if (typeof str !== 'string') return str;
    return str.length > max ? str.substring(0, max) + '...' : str;
  }

  function serializeData(data) {
    if (data === undefined || data === null) return undefined;
    try {
      const str = typeof data === 'string' ? data : JSON.stringify(data);
      return truncate(str, MAX_DATA_LEN);
    } catch {
      return '[unserializable]';
    }
  }

  function log(level, tag, msg, data) {
    if (level < currentLevel) return;

    const levelName = Object.keys(LEVELS).find(k => LEVELS[k] === level) || 'INFO';

    const entry = {
      ts: Date.now(),
      level: levelName,
      tag: tag,
      msg: truncate(String(msg), MAX_MSG_LEN),
    };

    const serialized = serializeData(data);
    if (serialized !== undefined) {
      entry.data = serialized;
    }

    // Mirror to console
    const consoleFn = level >= LEVELS.ERROR ? console.error
      : level >= LEVELS.WARN ? console.warn : console.log;
    consoleFn(`[LCM-${tag}]`, msg, data !== undefined ? data : '');

    buffer.push(entry);

    // Immediate flush for errors
    if (level >= LEVELS.ERROR) {
      flush();
      return;
    }

    // Debounced flush for other levels
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, FLUSH_DELAY_MS);
    }
  }

  // ---- Storage ----

  async function flush() {
    if (buffer.length === 0) return;

    const toFlush = buffer.splice(0);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      let logs = result[STORAGE_KEY] || [];
      logs.push(...toFlush);

      if (logs.length > MAX_ENTRIES) {
        logs = logs.slice(logs.length - MAX_ENTRIES);
      }

      await chrome.storage.local.set({ [STORAGE_KEY]: logs });
    } catch (err) {
      console.error('[LCM-Logger] Failed to flush logs:', err);
    }
  }

  async function getLogs(filter = {}) {
    // Flush any pending entries first
    await flush();

    const result = await chrome.storage.local.get(STORAGE_KEY);
    let logs = result[STORAGE_KEY] || [];

    if (filter.level) {
      const minLevel = LEVELS[filter.level] || 0;
      logs = logs.filter(e => LEVELS[e.level] >= minLevel);
    }
    if (filter.tag) {
      logs = logs.filter(e => e.tag === filter.tag);
    }
    if (filter.since) {
      logs = logs.filter(e => e.ts >= filter.since);
    }

    return logs;
  }

  async function clearLogs() {
    buffer = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  async function setLevel(levelName) {
    const upper = String(levelName).toUpperCase();
    if (LEVELS[upper] !== undefined) {
      currentLevel = LEVELS[upper];
      await chrome.storage.local.set({ [LEVEL_KEY]: upper });
    }
  }

  async function init() {
    try {
      const result = await chrome.storage.local.get(LEVEL_KEY);
      const saved = result[LEVEL_KEY];
      if (saved && LEVELS[saved] !== undefined) {
        currentLevel = LEVELS[saved];
      }
    } catch {
      // Default level is fine
    }
  }

  // ---- Public API ----

  return {
    debug: (tag, msg, data) => log(LEVELS.DEBUG, tag, msg, data),
    info: (tag, msg, data) => log(LEVELS.INFO, tag, msg, data),
    warn: (tag, msg, data) => log(LEVELS.WARN, tag, msg, data),
    error: (tag, msg, data) => log(LEVELS.ERROR, tag, msg, data),
    flush,
    getLogs,
    clearLogs,
    setLevel,
    init,
    LEVELS,
  };
})();
