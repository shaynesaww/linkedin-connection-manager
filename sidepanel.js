/**
 * Side panel UI logic for LinkedIn Connection Manager.
 * Handles filtering, selection, confirmation, and removal progress.
 */

(() => {
  // ---- State ----
  let allConnections = [];        // All fetched connections
  let filteredConnections = [];   // Connections matching current filters
  let selectedUrns = new Set();   // URNs of selected connections
  let filterMode = 'exclude';     // 'exclude' = show matches to remove, 'include' = show matches to keep

  // ---- DOM Elements ----
  const $ = (id) => document.getElementById(id);

  const btnFetch = $('btn-fetch');
  const authWarning = $('auth-warning');
  const fetchProgressSection = $('fetch-progress');
  const fetchCount = $('fetch-count');
  const fetchTotal = $('fetch-total');
  const fetchBar = $('fetch-bar');
  const filtersSection = $('filters-section');
  const filterTitle = $('filter-title');
  const filterKeywords = $('filter-keywords');
  const modeExclude = $('mode-exclude');
  const modeInclude = $('mode-include');
  const filterMatchCount = $('filter-match-count');
  const filterTotalCount = $('filter-total-count');
  const selectionSection = $('selection-section');
  const selectedCount = $('selected-count');
  const btnSelectAll = $('btn-select-all');
  const btnDeselectAll = $('btn-deselect-all');
  const connectionList = $('connection-list');
  const emptyState = $('empty-state');
  const actionBar = $('action-bar');
  const btnPreview = $('btn-preview');
  const previewCount = $('preview-count');
  const confirmModal = $('confirm-modal');
  const confirmCount = $('confirm-count');
  const confirmList = $('confirm-list');
  const btnConfirmCancel = $('btn-confirm-cancel');
  const btnConfirmRemove = $('btn-confirm-remove');
  const removalProgress = $('removal-progress');
  const removeCompleted = $('remove-completed');
  const removeTotal = $('remove-total');
  const removeBar = $('remove-bar');
  const removeCurrent = $('remove-current');
  const removeStatus = $('remove-status');
  const btnPause = $('btn-pause');
  const btnResume = $('btn-resume');
  const btnCancelRemoval = $('btn-cancel-removal');
  const removalDone = $('removal-done');
  const removalSummary = $('removal-summary');
  const btnDone = $('btn-done');

  // ---- Helpers ----

  /**
   * Send a message to the background service worker.
   */
  function sendToBackground(action, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * Debounce a function.
   */
  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  /**
   * Create a default avatar SVG as a data URL.
   */
  function defaultAvatar() {
    return `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#e0e0e0"/><text x="20" y="25" text-anchor="middle" fill="#999" font-size="16" font-family="sans-serif">?</text></svg>'
    )}`;
  }

  // ---- Filtering ----

  /**
   * Apply filters and update the UI.
   */
  function applyFilters() {
    const titleQuery = filterTitle.value.trim().toLowerCase();
    const keywordsRaw = filterKeywords.value.trim().toLowerCase();
    const keywords = keywordsRaw
      ? keywordsRaw.split(',').map(k => k.trim()).filter(Boolean)
      : [];

    const hasFilters = titleQuery || keywords.length > 0;

    if (!hasFilters) {
      // No filters: show all connections
      filteredConnections = [...allConnections];
    } else {
      // Filter connections
      const matched = allConnections.filter(conn => {
        const headline = (conn.headline || '').toLowerCase();
        const name = (conn.name || '').toLowerCase();
        const searchText = `${name} ${headline}`;

        let titleMatch = true;
        let keywordMatch = true;

        if (titleQuery) {
          titleMatch = headline.includes(titleQuery);
        }

        if (keywords.length > 0) {
          // ANY keyword must match (OR logic)
          keywordMatch = keywords.some(kw => searchText.includes(kw));
        }

        return titleMatch && keywordMatch;
      });

      if (filterMode === 'exclude') {
        // Show matches (these are the ones user wants to remove)
        filteredConnections = matched;
      } else {
        // Include mode: show NON-matches (user keeps these, removes the rest)
        filteredConnections = allConnections.filter(c => !matched.includes(c));
      }
    }

    filterMatchCount.textContent = filteredConnections.length;
    filterTotalCount.textContent = allConnections.length;

    renderConnectionList();
    updateSelectionUI();
  }

  // ---- Rendering ----

  // Virtual scroll state
  const CARD_HEIGHT = 61; // Approximate height of each card in px
  const RENDER_BUFFER = 20; // Extra cards to render above/below viewport
  let lastRenderRange = { start: -1, end: -1 };

  /**
   * Render the connection list with basic virtual scrolling for performance.
   */
  function renderConnectionList() {
    if (filteredConnections.length === 0) {
      connectionList.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';
    connectionList.style.display = 'block';

    // For lists under 500, just render all (fast enough)
    if (filteredConnections.length <= 500) {
      connectionList.innerHTML = filteredConnections
        .map((conn, idx) => renderCard(conn, idx))
        .join('');
      lastRenderRange = { start: 0, end: filteredConnections.length };
      attachCardListeners();
      return;
    }

    // Virtual scrolling for large lists
    const totalHeight = filteredConnections.length * CARD_HEIGHT;
    connectionList.style.height = `${Math.min(totalHeight, window.innerHeight - 250)}px`;
    connectionList.style.position = 'relative';

    // Initial render of visible area
    renderVisibleCards();

    // Attach scroll handler
    connectionList.onscroll = debounce(renderVisibleCards, 50);
  }

  function renderVisibleCards() {
    const scrollTop = connectionList.scrollTop;
    const viewportHeight = connectionList.clientHeight;

    const startIdx = Math.max(0, Math.floor(scrollTop / CARD_HEIGHT) - RENDER_BUFFER);
    const endIdx = Math.min(
      filteredConnections.length,
      Math.ceil((scrollTop + viewportHeight) / CARD_HEIGHT) + RENDER_BUFFER
    );

    // Skip if range hasn't changed
    if (startIdx === lastRenderRange.start && endIdx === lastRenderRange.end) return;
    lastRenderRange = { start: startIdx, end: endIdx };

    const totalHeight = filteredConnections.length * CARD_HEIGHT;
    const topPadding = startIdx * CARD_HEIGHT;

    let html = `<div style="height:${topPadding}px"></div>`;
    for (let i = startIdx; i < endIdx; i++) {
      html += renderCard(filteredConnections[i], i);
    }
    html += `<div style="height:${totalHeight - endIdx * CARD_HEIGHT}px"></div>`;

    connectionList.innerHTML = html;
    attachCardListeners();
  }

  /**
   * Render a single connection card HTML string.
   */
  function renderCard(conn, index) {
    const isSelected = selectedUrns.has(conn.connectionUrn);
    // Only use profile picture if it's a valid absolute URL; otherwise use default
    const avatarSrc = (conn.profilePicture && conn.profilePicture.startsWith('http'))
      ? conn.profilePicture
      : defaultAvatar();
    const selectedClass = isSelected ? ' connection-card--selected' : '';

    return `
      <div class="connection-card${selectedClass}" data-urn="${conn.connectionUrn}" data-index="${index}">
        <input type="checkbox" class="connection-card__checkbox" ${isSelected ? 'checked' : ''} tabindex="-1">
        <img class="connection-card__avatar" src="${avatarSrc}" alt="" loading="lazy">
        <div class="connection-card__info">
          <div class="connection-card__name">${escapeHtml(conn.name)}</div>
          <div class="connection-card__headline">${escapeHtml(conn.headline || 'No headline')}</div>
        </div>
      </div>
    `;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Attach click listeners to connection cards (event delegation).
   */
  function attachCardListeners() {
    // Using event delegation on the connection list container instead
  }

  // Handle broken avatar images via event delegation (CSP-safe, no inline onerror)
  connectionList.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG' && e.target.classList.contains('connection-card__avatar')) {
      const fallback = defaultAvatar();
      if (e.target.src !== fallback) {
        e.target.src = fallback;
      }
    }
  }, true); // useCapture: true to catch error events which don't bubble

  // Use event delegation for card clicks
  connectionList.addEventListener('click', (e) => {
    const card = e.target.closest('.connection-card');
    if (!card) return;

    const urn = card.dataset.urn;
    if (selectedUrns.has(urn)) {
      selectedUrns.delete(urn);
      card.classList.remove('connection-card--selected');
      card.querySelector('.connection-card__checkbox').checked = false;
    } else {
      selectedUrns.add(urn);
      card.classList.add('connection-card--selected');
      card.querySelector('.connection-card__checkbox').checked = true;
    }

    updateSelectionUI();
  });

  /**
   * Update selection count and action bar visibility.
   */
  function updateSelectionUI() {
    const count = selectedUrns.size;
    selectedCount.textContent = count;
    previewCount.textContent = count;

    actionBar.style.display = count > 0 ? 'block' : 'none';
    btnPreview.disabled = count === 0;
  }

  // ---- Event Handlers ----

  // Fetch connections
  btnFetch.addEventListener('click', async () => {
    btnFetch.disabled = true;
    btnFetch.textContent = 'Fetching...';
    authWarning.style.display = 'none';
    fetchProgressSection.style.display = 'block';

    try {
      // First check auth
      const authResult = await sendToBackground('checkAuth');
      if (!authResult.authenticated) {
        authWarning.style.display = 'block';
        fetchProgressSection.style.display = 'none';
        btnFetch.disabled = false;
        btnFetch.textContent = 'Fetch Connections';
        return;
      }

      // Fetch all connections
      const result = await sendToBackground('fetchAllConnections');
      allConnections = result.connections || [];

      // Show filters and list
      fetchProgressSection.style.display = 'none';
      filtersSection.style.display = 'block';
      selectionSection.style.display = 'flex';
      connectionList.style.display = 'block';

      if (allConnections.length === 0) {
        authWarning.textContent =
          'Fetched 0 connections. LinkedIn may have changed their API format. ' +
          'Open DevTools (F12) → Console tab and look for [LCM] messages for diagnostic details. ' +
          'Share those log messages so we can fix the parsing.';
        authWarning.style.display = 'block';
      }

      btnFetch.textContent = `Refresh (${allConnections.length})`;
      btnFetch.disabled = false;

      applyFilters();
    } catch (err) {
      fetchProgressSection.style.display = 'none';
      authWarning.textContent = `Error: ${err.message}. Open DevTools (F12) → Console for [LCM] diagnostic logs.`;
      authWarning.style.display = 'block';
      btnFetch.disabled = false;
      btnFetch.textContent = 'Fetch Connections';
    }
  });

  // Listen for fetch progress updates from background/content script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'fetchProgress') {
      const { fetched, total } = message.payload;
      fetchCount.textContent = fetched;
      fetchTotal.textContent = total > 0 ? total : '...';
      // If total is unknown (0), show an animated indeterminate-style bar
      fetchBar.style.width = total > 0 ? `${(fetched / total) * 100}%` : '60%';
    }

    if (message.action === 'removeProgress') {
      const { completed, total, currentItem, status } = message.payload;
      removeCompleted.textContent = completed;
      removeTotal.textContent = total;
      removeBar.style.width = total > 0 ? `${(completed / total) * 100}%` : '0%';

      if (currentItem) {
        removeCurrent.textContent = `Removing: ${currentItem}`;
      }

      // Update status text
      removeStatus.className = 'removal-status';
      switch (status) {
        case 'rate_limited':
          removeStatus.textContent = 'Rate limited - waiting 60s...';
          removeStatus.classList.add('removal-status--rate-limited');
          break;
        case 'batch_pause':
          removeStatus.textContent = 'Batch pause...';
          break;
        case 'failed':
          removeStatus.textContent = `Failed to remove ${currentItem}`;
          break;
        default:
          removeStatus.textContent = '';
      }
    }
  });

  // Filter inputs
  const debouncedFilter = debounce(applyFilters, 200);
  filterTitle.addEventListener('input', debouncedFilter);
  filterKeywords.addEventListener('input', debouncedFilter);

  // Filter mode toggle
  modeExclude.addEventListener('click', () => {
    filterMode = 'exclude';
    modeExclude.classList.add('toggle-btn--active');
    modeInclude.classList.remove('toggle-btn--active');
    applyFilters();
  });

  modeInclude.addEventListener('click', () => {
    filterMode = 'include';
    modeInclude.classList.add('toggle-btn--active');
    modeExclude.classList.remove('toggle-btn--active');
    applyFilters();
  });

  // Select all / Deselect all
  btnSelectAll.addEventListener('click', () => {
    filteredConnections.forEach(c => selectedUrns.add(c.connectionUrn));
    renderConnectionList();
    updateSelectionUI();
  });

  btnDeselectAll.addEventListener('click', () => {
    selectedUrns.clear();
    renderConnectionList();
    updateSelectionUI();
  });

  // Preview removal
  btnPreview.addEventListener('click', () => {
    const selected = getSelectedConnections();
    confirmCount.textContent = selected.length;

    // Show up to 20 names in the confirmation list
    const sampleNames = selected.slice(0, 20).map(c =>
      `${escapeHtml(c.name)} - ${escapeHtml(c.headline || 'No headline')}`
    );
    let listHtml = sampleNames.join('<br>');
    if (selected.length > 20) {
      listHtml += `<br><em>...and ${selected.length - 20} more</em>`;
    }
    confirmList.innerHTML = listHtml;

    confirmModal.style.display = 'flex';
  });

  // Cancel confirmation
  btnConfirmCancel.addEventListener('click', () => {
    confirmModal.style.display = 'none';
  });

  // Confirm and remove
  btnConfirmRemove.addEventListener('click', async () => {
    confirmModal.style.display = 'none';
    const selected = getSelectedConnections();

    // Hide main UI, show removal progress
    filtersSection.style.display = 'none';
    selectionSection.style.display = 'none';
    connectionList.style.display = 'none';
    actionBar.style.display = 'none';
    emptyState.style.display = 'none';
    btnFetch.style.display = 'none';

    removalProgress.style.display = 'block';
    removeCompleted.textContent = '0';
    removeTotal.textContent = selected.length;
    removeBar.style.width = '0%';
    removeCurrent.textContent = 'Starting...';
    removeStatus.textContent = '';
    btnPause.style.display = 'inline-flex';
    btnResume.style.display = 'none';

    try {
      const result = await sendToBackground('bulkRemoveConnections', {
        connections: selected,
      });

      // Show completion
      removalProgress.style.display = 'none';
      removalDone.style.display = 'block';

      let summary = `Successfully removed ${result.completed} connection${result.completed !== 1 ? 's' : ''}.`;
      if (result.failed?.length > 0) {
        summary += ` ${result.failed.length} failed.`;
      }
      if (result.cancelled) {
        summary += ' (Cancelled by user)';
      }
      removalSummary.textContent = summary;

      // Remove the deleted connections from local state
      const removedUrns = new Set(selected.map(c => c.connectionUrn));
      allConnections = allConnections.filter(c => !removedUrns.has(c.connectionUrn));
      selectedUrns.clear();

    } catch (err) {
      removalProgress.style.display = 'none';
      removalDone.style.display = 'block';
      removalSummary.textContent = `Error during removal: ${err.message}`;
    }
  });

  // Pause / Resume / Cancel removal
  btnPause.addEventListener('click', async () => {
    await sendToBackground('pauseRemoval');
    btnPause.style.display = 'none';
    btnResume.style.display = 'inline-flex';
    removeStatus.textContent = 'Paused';
    removeStatus.className = 'removal-status removal-status--paused';
  });

  btnResume.addEventListener('click', async () => {
    await sendToBackground('resumeRemoval');
    btnResume.style.display = 'none';
    btnPause.style.display = 'inline-flex';
    removeStatus.textContent = '';
    removeStatus.className = 'removal-status';
  });

  btnCancelRemoval.addEventListener('click', async () => {
    await sendToBackground('cancelRemoval');
    removeCurrent.textContent = 'Cancelling...';
  });

  // Done button - return to main view
  btnDone.addEventListener('click', () => {
    removalDone.style.display = 'none';
    btnFetch.style.display = 'inline-flex';
    filtersSection.style.display = 'block';
    selectionSection.style.display = 'flex';
    connectionList.style.display = 'block';

    btnFetch.textContent = `Refresh (${allConnections.length})`;
    applyFilters();
  });

  // ---- Helpers ----

  /**
   * Get the full connection objects for all selected URNs.
   */
  function getSelectedConnections() {
    return allConnections.filter(c => selectedUrns.has(c.connectionUrn));
  }
})();
