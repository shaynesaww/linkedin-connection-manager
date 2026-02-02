/**
 * Rate limiter for LinkedIn API calls.
 * Uses randomized delays and batch pauses to mimic human-like timing.
 * Supports pause, resume, and cancel controls.
 */

const RateLimiter = (() => {
  // Configuration
  const CONFIG = {
    minDelayMs: 2000,       // Min delay between individual removals
    maxDelayMs: 5000,       // Max delay between individual removals
    batchSize: 10,          // Number of removals before a batch pause
    batchPauseMinMs: 15000, // Min pause between batches
    batchPauseMaxMs: 30000, // Max pause between batches
    jitterFactor: 0.3,      // 30% jitter on all timings
    rateLimitBackoffMs: 60000, // Backoff duration when rate-limited (429)
  };

  // State
  let isPaused = false;
  let isCancelled = false;
  let pauseResolve = null; // Resolve function for the pause promise

  /**
   * Add jitter to a base value.
   * @param {number} base - The base millisecond value
   * @returns {number} - Jittered value
   */
  function addJitter(base) {
    const jitter = base * CONFIG.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  /**
   * Get a random delay between min and max, with jitter.
   */
  function getItemDelay() {
    const base = CONFIG.minDelayMs + Math.random() * (CONFIG.maxDelayMs - CONFIG.minDelayMs);
    return addJitter(base);
  }

  /**
   * Get the batch pause duration with jitter.
   */
  function getBatchPauseDelay() {
    const base = CONFIG.batchPauseMinMs + Math.random() * (CONFIG.batchPauseMaxMs - CONFIG.batchPauseMinMs);
    return addJitter(base);
  }

  /**
   * Sleep for a given duration, but can be interrupted by cancel.
   * @param {number} ms - Duration in milliseconds
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // If cancelled during sleep, resolve immediately
      const checkCancel = setInterval(() => {
        if (isCancelled) {
          clearTimeout(timer);
          clearInterval(checkCancel);
          resolve();
        }
      }, 100);
      // Clean up the interval when the timer completes
      setTimeout(() => clearInterval(checkCancel), ms + 50);
    });
  }

  /**
   * Wait while paused. Returns immediately if not paused.
   * @returns {Promise<void>}
   */
  function waitWhilePaused() {
    if (!isPaused) return Promise.resolve();
    return new Promise((resolve) => {
      pauseResolve = resolve;
    });
  }

  /**
   * Execute a batch of removal operations with rate limiting.
   * @param {Array} items - Array of items to process
   * @param {function} operation - Async function that processes one item. Should throw 'RATE_LIMITED' on 429.
   * @param {function} onProgress - Callback(completed, total, currentItem, status)
   * @returns {Promise<{completed: number, failed: Array, cancelled: boolean}>}
   */
  async function executeBatch(items, operation, onProgress) {
    isPaused = false;
    isCancelled = false;

    let completed = 0;
    const failed = [];

    for (let i = 0; i < items.length; i++) {
      // Check for cancellation
      if (isCancelled) {
        onProgress?.(completed, items.length, null, 'cancelled');
        return { completed, failed, cancelled: true };
      }

      // Wait if paused
      await waitWhilePaused();
      if (isCancelled) {
        onProgress?.(completed, items.length, null, 'cancelled');
        return { completed, failed, cancelled: true };
      }

      const item = items[i];
      onProgress?.(completed, items.length, item, 'removing');

      try {
        await operation(item);
        completed++;
        onProgress?.(completed, items.length, item, 'removed');
      } catch (err) {
        if (err.message === 'RATE_LIMITED') {
          // Back off and retry
          onProgress?.(completed, items.length, item, 'rate_limited');
          await sleep(CONFIG.rateLimitBackoffMs);

          // Retry once after backoff
          if (!isCancelled) {
            try {
              await operation(item);
              completed++;
              onProgress?.(completed, items.length, item, 'removed');
            } catch (retryErr) {
              failed.push({ item, error: retryErr.message });
              onProgress?.(completed, items.length, item, 'failed');
            }
          }
        } else {
          failed.push({ item, error: err.message });
          onProgress?.(completed, items.length, item, 'failed');
        }
      }

      // Delay before next item
      if (i < items.length - 1 && !isCancelled) {
        // Batch pause every N items
        if ((i + 1) % CONFIG.batchSize === 0) {
          onProgress?.(completed, items.length, null, 'batch_pause');
          await sleep(getBatchPauseDelay());
        } else {
          await sleep(getItemDelay());
        }
      }
    }

    onProgress?.(completed, items.length, null, 'done');
    return { completed, failed, cancelled: false };
  }

  /**
   * Pause the current batch operation.
   */
  function pause() {
    isPaused = true;
  }

  /**
   * Resume a paused batch operation.
   */
  function resume() {
    isPaused = false;
    if (pauseResolve) {
      pauseResolve();
      pauseResolve = null;
    }
  }

  /**
   * Cancel the current batch operation.
   */
  function cancel() {
    isCancelled = true;
    // Also resume in case we're paused, so the loop can exit
    resume();
  }

  /**
   * Reset state for a new batch.
   */
  function reset() {
    isPaused = false;
    isCancelled = false;
    pauseResolve = null;
  }

  return {
    executeBatch,
    pause,
    resume,
    cancel,
    reset,
    CONFIG,
  };
})();
