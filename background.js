/**
 * Background service worker for LinkedIn Connection Manager.
 * ALL LinkedIn API calls happen here - the service worker's fetch cannot be
 * intercepted by LinkedIn's page JavaScript or Service Worker.
 */

importScripts('lib/logger.js');

const BASE_URL = 'https://www.linkedin.com';
const REMOVE_ENDPOINT = BASE_URL + '/voyager/api/relationships/dash/memberRelationships?action=removeFromMyConnections';
const PAGE_SIZE = 40;
const DEFAULT_FETCH_TIMEOUT = 30000; // 30s for page fetches
const REMOVAL_FETCH_TIMEOUT = 15000; // 15s for removal API calls
const TAG = 'BG';

// Endpoint configurations to try
const ENDPOINT_CONFIGS = [
  {
    name: 'dash-v17',
    url: BASE_URL + '/voyager/api/relationships/dash/connections',
    params: {
      decorationId: 'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionList-17',
      count: String(PAGE_SIZE),
      q: 'search',
      sortType: 'RECENTLY_ADDED',
    },
  },
  {
    name: 'dash-v16',
    url: BASE_URL + '/voyager/api/relationships/dash/connections',
    params: {
      decorationId: 'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionList-16',
      count: String(PAGE_SIZE),
      q: 'search',
      sortType: 'RECENTLY_ADDED',
    },
  },
  {
    name: 'dash-v15',
    url: BASE_URL + '/voyager/api/relationships/dash/connections',
    params: {
      decorationId: 'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionList-15',
      count: String(PAGE_SIZE),
      q: 'search',
      sortType: 'RECENTLY_ADDED',
    },
  },
  {
    name: 'dash-no-decoration',
    url: BASE_URL + '/voyager/api/relationships/dash/connections',
    params: {
      count: String(PAGE_SIZE),
      q: 'search',
      sortType: 'RECENTLY_ADDED',
    },
  },
  {
    name: 'legacy',
    url: BASE_URL + '/voyager/api/relationships/connections',
    params: {
      count: String(PAGE_SIZE),
      q: 'search',
      sortType: 'RECENTLY_ADDED',
    },
  },
];

let workingConfig = null;
let workingRemovalStrategy = null; // Cache which removal strategy works

// ---- Rate Limiter State ----
let isPaused = false;
let isCancelled = false;
let pauseResolve = null;

const RATE = {
  minDelay: 2000,
  maxDelay: 5000,
  batchSize: 10,
  batchPauseMin: 15000,
  batchPauseMax: 30000,
  jitter: 0.3,
  backoff: 60000,
};

// ================================================================
// Fetch Timeout Wrapper
// ================================================================

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`FETCH_TIMEOUT: Request timed out after ${timeoutMs}ms - ${url.substring(0, 120)}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ================================================================
// Cookie & Auth Helpers
// ================================================================

async function getLinkedInCookies() {
  const cookies = await chrome.cookies.getAll({ url: BASE_URL });
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function getCsrfToken() {
  const cookie = await chrome.cookies.get({ url: BASE_URL, name: 'JSESSIONID' });
  if (!cookie) {
    throw new Error('No JSESSIONID cookie found. Make sure you are logged into LinkedIn.');
  }
  // LinkedIn wraps the value in quotes sometimes
  return cookie.value.replace(/^"|"$/g, '');
}

async function getHeaders() {
  const csrf = await getCsrfToken();
  const cookieHeader = await getLinkedInCookies();
  return {
    'csrf-token': csrf,
    'Cookie': cookieHeader,
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'x-li-page-instance': 'urn:li:page:d_flagship3_people_connections;',
  };
}

// ================================================================
// Response Parsing
// ================================================================

function parseConnectionsResponse(json) {
  const included = json.included || [];
  const elements = json.data?.elements || json.elements || json.data?.['*elements'] || [];

  Logger.debug(TAG, `${included.length} included entities, ${elements.length} elements`);

  const types = new Set();
  for (const entity of included) {
    if (entity['$recipeType']) types.add('recipe:' + entity['$recipeType']);
    if (entity['$type']) types.add('type:' + entity['$type']);
  }
  Logger.debug(TAG, 'Entity types', [...types]);

  let connections = tryParseMiniProfiles(included);
  if (connections.length > 0) return connections;

  connections = tryParseByNameFields(included);
  if (connections.length > 0) return connections;

  connections = tryParseElements(elements, included);
  if (connections.length > 0) return connections;

  // Diagnostic dump
  Logger.warn(TAG, 'All parse strategies failed');
  for (let i = 0; i < Math.min(3, included.length); i++) {
    Logger.warn(TAG, `Entity ${i}`, JSON.stringify(included[i]).substring(0, 1000));
  }
  return [];
}

function tryParseMiniProfiles(included) {
  const profiles = [];
  const connectionEntities = [];

  for (const entity of included) {
    const type = (entity['$recipeType'] || entity['$type'] || '').toLowerCase();

    if (type.includes('miniprofile') || type.includes('profile')) {
      if (entity.firstName || entity.lastName) {
        profiles.push({
          firstName: entity.firstName || '',
          lastName: entity.lastName || '',
          name: `${entity.firstName || ''} ${entity.lastName || ''}`.trim(),
          headline: entity.occupation || entity.headline || '',
          publicIdentifier: entity.publicIdentifier || '',
          profileUrl: entity.publicIdentifier
            ? `https://www.linkedin.com/in/${entity.publicIdentifier}/`
            : '',
          entityUrn: entity.entityUrn || '',
          profilePicture: extractProfilePicture(entity),
        });
      }
    }

    if (type.includes('connection') || entity.connectedMember || entity.connectedMemberResolutionResult) {
      connectionEntities.push(entity);
    }
  }

  Logger.debug(TAG, `MiniProfile strategy: ${profiles.length} profiles, ${connectionEntities.length} connection entities`);

  for (const connEntity of connectionEntities) {
    const memberUrn = extractMemberUrn(connEntity);
    if (!memberUrn) continue;
    const profile = profiles.find(p => p.entityUrn === memberUrn);
    if (profile) {
      profile.connectionUrn = connEntity.entityUrn || '';
      profile.connectedAt = connEntity.createdAt || null;
    }
  }

  const matched = profiles.filter(p => p.connectionUrn);
  if (matched.length === 0 && profiles.length > 0) {
    Logger.info(TAG, 'No connectionUrn matches, using entityUrns as fallback');
    return profiles.map(p => ({ ...p, connectionUrn: p.connectionUrn || p.entityUrn }));
  }
  return matched;
}

function tryParseByNameFields(included) {
  const connections = [];
  const seen = new Set();
  for (const entity of included) {
    if (!entity.firstName && !entity.lastName) continue;
    if (!entity.entityUrn || seen.has(entity.entityUrn)) continue;
    seen.add(entity.entityUrn);
    connections.push({
      firstName: entity.firstName || '',
      lastName: entity.lastName || '',
      name: `${entity.firstName || ''} ${entity.lastName || ''}`.trim(),
      headline: entity.occupation || entity.headline || entity.title || '',
      publicIdentifier: entity.publicIdentifier || '',
      profileUrl: entity.publicIdentifier ? `https://www.linkedin.com/in/${entity.publicIdentifier}/` : '',
      entityUrn: entity.entityUrn,
      connectionUrn: entity.entityUrn,
      connectedAt: entity.createdAt || null,
      profilePicture: extractProfilePicture(entity),
    });
  }
  return connections;
}

function tryParseElements(elements, included) {
  const connections = [];
  const entityMap = new Map();
  for (const entity of included) {
    if (entity.entityUrn) entityMap.set(entity.entityUrn, entity);
  }

  for (const elem of elements) {
    if (typeof elem === 'string') {
      const entity = entityMap.get(elem);
      if (entity && (entity.firstName || entity.lastName)) {
        connections.push({
          firstName: entity.firstName || '',
          lastName: entity.lastName || '',
          name: `${entity.firstName || ''} ${entity.lastName || ''}`.trim(),
          headline: entity.occupation || entity.headline || '',
          publicIdentifier: entity.publicIdentifier || '',
          profileUrl: entity.publicIdentifier ? `https://www.linkedin.com/in/${entity.publicIdentifier}/` : '',
          entityUrn: entity.entityUrn,
          connectionUrn: entity.entityUrn,
          profilePicture: extractProfilePicture(entity),
        });
      }
      continue;
    }

    if (typeof elem === 'object' && elem !== null) {
      const memberRef = elem.connectedMember || elem.connectedMemberResolutionResult
        || elem['*connectedMember'] || elem.member || elem['*member'];
      if (memberRef) {
        const memberUrn = typeof memberRef === 'string' ? memberRef : memberRef.entityUrn;
        const profile = entityMap.get(memberUrn);
        if (profile) {
          connections.push({
            firstName: profile.firstName || '',
            lastName: profile.lastName || '',
            name: `${profile.firstName || ''} ${profile.lastName || ''}`.trim(),
            headline: profile.occupation || profile.headline || '',
            publicIdentifier: profile.publicIdentifier || '',
            profileUrl: profile.publicIdentifier ? `https://www.linkedin.com/in/${profile.publicIdentifier}/` : '',
            entityUrn: profile.entityUrn || '',
            connectionUrn: elem.entityUrn || profile.entityUrn || '',
            connectedAt: elem.createdAt || null,
            profilePicture: extractProfilePicture(profile),
          });
        }
      }
      if (elem.firstName || elem.lastName) {
        connections.push({
          firstName: elem.firstName || '',
          lastName: elem.lastName || '',
          name: `${elem.firstName || ''} ${elem.lastName || ''}`.trim(),
          headline: elem.occupation || elem.headline || '',
          publicIdentifier: elem.publicIdentifier || '',
          profileUrl: elem.publicIdentifier ? `https://www.linkedin.com/in/${elem.publicIdentifier}/` : '',
          entityUrn: elem.entityUrn || '',
          connectionUrn: elem.entityUrn || '',
          profilePicture: extractProfilePicture(elem),
        });
      }
    }
  }
  return connections;
}

function extractMemberUrn(entity) {
  for (const field of ['connectedMember', 'connectedMemberResolutionResult', '*connectedMember', 'member', '*member', 'miniProfile', '*miniProfile']) {
    const val = entity[field];
    if (!val) continue;
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && val.entityUrn) return val.entityUrn;
  }
  return null;
}

function extractProfilePicture(entity) {
  try {
    const pictures = entity.picture || entity.profilePicture || entity.image;
    if (!pictures) return '';
    const vectorImage = pictures['com.linkedin.common.VectorImage'] || pictures;
    const artifacts = vectorImage?.artifacts || [];
    const rootUrl = vectorImage?.rootUrl || '';
    if (artifacts.length > 0 && rootUrl) {
      return rootUrl + (artifacts[0].fileIdentifyingUrlPathSegment || '');
    }
    if (typeof pictures === 'string') return pictures;
    return '';
  } catch (err) {
    Logger.debug(TAG, 'Failed to extract profile picture', { error: err.message });
    return '';
  }
}

// ================================================================
// API Fetching
// ================================================================

async function tryFetchWithConfig(config, start) {
  const params = new URLSearchParams({ ...config.params, start: String(start) });
  const url = `${config.url}?${params.toString()}`;
  const headers = await getHeaders();

  Logger.info(TAG, `API request: ${config.name}`, { url, start });

  const response = await fetchWithTimeout(url, { method: 'GET', headers });

  if (!response.ok) {
    Logger.warn(TAG, `${config.name} returned ${response.status}`, { start });
    if (response.status === 429) throw new Error('RATE_LIMITED');
    return null;
  }

  const json = await response.json();
  Logger.debug(TAG, `${config.name} response keys`, Object.keys(json));
  if (json.included) Logger.debug(TAG, `${json.included.length} included entities`);

  // Extract total connection count from paging metadata.
  // IMPORTANT: paging.count is the PAGE SIZE, not the total. Only use paging.total.
  const paging = json.data?.paging || json.paging || {};
  const total = paging.total || 0;

  Logger.debug(TAG, 'Paging info', { total, count: paging.count, start: paging.start });

  const connections = parseConnectionsResponse(json);

  return { connections, total, json };
}

async function discoverEndpoint() {
  for (const config of ENDPOINT_CONFIGS) {
    try {
      const result = await tryFetchWithConfig(config, 0);
      if (result && (result.connections.length > 0 || result.total > 0)) {
        Logger.info(TAG, `Working endpoint found: ${config.name}`, { connections: result.connections.length, total: result.total });
        workingConfig = config;
        return result;
      }
      if (result) {
        Logger.info(TAG, `${config.name}: valid response but 0 connections`);
        Logger.debug(TAG, 'Raw response (truncated)', JSON.stringify(result.json).substring(0, 2000));
      }
    } catch (err) {
      if (err.message === 'RATE_LIMITED') throw err;
      Logger.warn(TAG, `${config.name} failed`, { error: err.message });
    }
  }
  throw new Error('No working LinkedIn API endpoint found. Open the Logs panel for details.');
}

async function fetchAllConnections(sendProgress) {
  Logger.info(TAG, 'Starting connection fetch');

  const firstPage = await discoverEndpoint();
  const allConnections = [...firstPage.connections];
  // Use reported total if available, otherwise estimate high and paginate until empty
  let total = firstPage.total > 0 ? firstPage.total : 10000;

  Logger.info(TAG, 'First page loaded', { connections: firstPage.connections.length, reportedTotal: firstPage.total, usingTotal: total });
  sendProgress(allConnections.length, total);

  // If the first page returned fewer results than requested, there might only be one page
  // But don't trust this if total is reported > PAGE_SIZE
  if (firstPage.connections.length === 0) {
    return allConnections;
  }

  let start = PAGE_SIZE;
  let consecutiveEmpty = 0;

  while (start < total) {
    try {
      const result = await tryFetchWithConfig(workingConfig, start);
      if (!result) {
        Logger.warn(TAG, 'Null result, stopping pagination', { start });
        break;
      }

      const pageCount = result.connections.length;
      allConnections.push(...result.connections);
      start += PAGE_SIZE;

      // Update total if the API now reports a real number
      if (result.total > 0 && result.total > total) {
        total = result.total;
      }
      // If we got a real total, use it; the "10000" estimate can be replaced
      if (result.total > 0 && total === 10000) {
        total = result.total;
      }

      // If total is still the 10000 estimate, show fetched count as the "total" for now
      sendProgress(allConnections.length, total >= 10000 ? 0 : total);

      // Stop if we got an empty page
      if (pageCount === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) {
          Logger.info(TAG, 'Two consecutive empty pages, stopping', { start });
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }

      Logger.debug(TAG, `Page fetched`, { start: start - PAGE_SIZE, pageCount, totalSoFar: allConnections.length });

      await sleep(300 + Math.random() * 200);
    } catch (err) {
      if (err.message === 'RATE_LIMITED') {
        Logger.warn(TAG, 'Rate limited during fetch, waiting 30s', { start });
        await sleep(30000);
        continue;
      }
      if (err.message.startsWith('FETCH_TIMEOUT')) {
        Logger.error(TAG, 'Fetch timed out', { start, error: err.message });
        await sleep(5000);
        continue;
      }
      Logger.error(TAG, 'Error during fetch page', { start, error: err.message });
      break;
    }
  }

  Logger.info(TAG, 'Fetch complete', { total: allConnections.length });
  return allConnections;
}

async function tryRemovalStrategy(strategyNum, connection, headers) {
  const connectionUrn = connection.connectionUrn || '';
  const publicId = connection.publicIdentifier || '';

  switch (strategyNum) {
    case 1: {
      // profileActions disconnect endpoint (from linkedin-api Python library)
      // POST /voyager/api/identity/profiles/{publicId}/profileActions?action=disconnect
      if (!publicId) return null;
      const url = `${BASE_URL}/voyager/api/identity/profiles/${encodeURIComponent(publicId)}/profileActions?action=disconnect`;
      Logger.debug(TAG, `Strategy 1: POST profileActions/disconnect`, { publicId });
      return fetchWithTimeout(url, { method: 'POST', headers }, REMOVAL_FETCH_TIMEOUT);
    }
    case 2: {
      // memberRelationships with connectionUrn field + decorationId (from Unipile docs)
      // POST /voyager/api/relationships/dash/memberRelationships?action=removeFromMyConnections&decorationId=...
      if (!connectionUrn) return null;
      const url = `${REMOVE_ENDPOINT}&decorationId=com.linkedin.voyager.dash.deco.relationships.MemberRelationship-34`;
      Logger.debug(TAG, `Strategy 2: POST memberRelationships+decorationId`, { connectionUrn });
      return fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify({ connectionUrn }) }, REMOVAL_FETCH_TIMEOUT);
    }
    case 3: {
      // memberRelationships with connectionUrn field (no decorationId)
      if (!connectionUrn) return null;
      Logger.debug(TAG, `Strategy 3: POST memberRelationships`, { connectionUrn });
      return fetchWithTimeout(REMOVE_ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ connectionUrn }) }, REMOVAL_FETCH_TIMEOUT);
    }
    case 4: {
      // POST action on the connection resource directly
      if (!connectionUrn || !connectionUrn.includes('fsd_connection')) return null;
      const encodedUrn = encodeURIComponent(connectionUrn);
      const url = `${BASE_URL}/voyager/api/relationships/dash/connections/${encodedUrn}?action=removeConnection`;
      Logger.debug(TAG, `Strategy 4: POST connections/removeConnection`, { connectionUrn });
      return fetchWithTimeout(url, { method: 'POST', headers, body: '{}' }, REMOVAL_FETCH_TIMEOUT);
    }
    case 5: {
      // DELETE on the connection resource
      if (!connectionUrn) return null;
      const encodedUrn = encodeURIComponent(connectionUrn);
      const url = `${BASE_URL}/voyager/api/relationships/dash/connections/${encodedUrn}`;
      Logger.debug(TAG, `Strategy 5: DELETE connection`, { connectionUrn });
      const deleteHeaders = { ...headers };
      delete deleteHeaders['content-type'];
      return fetchWithTimeout(url, { method: 'DELETE', headers: deleteHeaders }, REMOVAL_FETCH_TIMEOUT);
    }
    default:
      return null;
  }
}

async function removeConnection(connection) {
  const headers = await getHeaders();
  headers['content-type'] = 'application/json';

  const connectionUrn = connection.connectionUrn || '';
  const profileUrn = connection.entityUrn || '';

  Logger.info(TAG, `Attempting removal: ${connection.name || 'unknown'}`, { connectionUrn, profileUrn, publicId: connection.publicIdentifier || 'N/A' });

  // Order strategies: try cached working strategy first, then the rest
  const allStrategies = [1, 2, 3, 4, 5];
  const strategies = workingRemovalStrategy
    ? [workingRemovalStrategy, ...allStrategies.filter(s => s !== workingRemovalStrategy)]
    : allStrategies;

  for (const stratNum of strategies) {
    try {
      const resp = await tryRemovalStrategy(stratNum, connection, headers);
      if (!resp) continue; // strategy not applicable

      if (resp.ok || resp.status === 200 || resp.status === 204) {
        Logger.info(TAG, `Removal succeeded via strategy ${stratNum}`, { name: connection.name, status: resp.status });
        workingRemovalStrategy = stratNum;
        return true;
      }
      if (resp.status === 429) throw new Error('RATE_LIMITED');
      const body = await resp.text().catch(() => '');
      Logger.warn(TAG, `Strategy ${stratNum} failed`, { status: resp.status, body: body.substring(0, 500) });
    } catch (err) {
      if (err.message === 'RATE_LIMITED') throw err;
      Logger.warn(TAG, `Strategy ${stratNum} error`, { error: err.message });
    }
  }

  throw new Error(`All removal strategies failed for ${connection.name || connectionUrn}`);
}

// ================================================================
// Rate Limiter
// ================================================================

function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    const check = setInterval(() => {
      if (isCancelled) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 100);
    setTimeout(() => clearInterval(check), ms + 50);
  });
}

function waitWhilePaused() {
  if (!isPaused) return Promise.resolve();
  return new Promise(resolve => { pauseResolve = resolve; });
}

function addJitter(base) {
  return Math.max(0, Math.round(base + base * RATE.jitter * (Math.random() * 2 - 1)));
}

function getItemDelay() {
  return addJitter(RATE.minDelay + Math.random() * (RATE.maxDelay - RATE.minDelay));
}

function getBatchPause() {
  return addJitter(RATE.batchPauseMin + Math.random() * (RATE.batchPauseMax - RATE.batchPauseMin));
}

async function bulkRemove(connections, sendProgress) {
  isPaused = false;
  isCancelled = false;
  let completed = 0;
  const failed = [];

  Logger.info(TAG, 'Starting bulk removal', { count: connections.length });

  for (let i = 0; i < connections.length; i++) {
    if (isCancelled) {
      sendProgress(completed, connections.length, null, 'cancelled');
      Logger.info(TAG, 'Bulk removal cancelled', { completed, failed: failed.length });
      return { completed, failed, cancelled: true };
    }

    await waitWhilePaused();
    if (isCancelled) {
      sendProgress(completed, connections.length, null, 'cancelled');
      Logger.info(TAG, 'Bulk removal cancelled', { completed, failed: failed.length });
      return { completed, failed, cancelled: true };
    }

    const conn = connections[i];
    sendProgress(completed, connections.length, conn.name, 'removing');

    try {
      await removeConnection(conn);
      completed++;
      sendProgress(completed, connections.length, conn.name, 'removed');
    } catch (err) {
      if (err.message === 'RATE_LIMITED') {
        sendProgress(completed, connections.length, conn.name, 'rate_limited');
        Logger.warn(TAG, 'Rate limited during removal, backing off', { completed, name: conn.name });
        await sleep(RATE.backoff);
        if (!isCancelled) {
          try {
            await removeConnection(conn);
            completed++;
            sendProgress(completed, connections.length, conn.name, 'removed');
          } catch (retryErr) {
            failed.push({ item: conn, error: retryErr.message });
            sendProgress(completed, connections.length, conn.name, 'failed');
            Logger.error(TAG, 'Removal failed after retry', { name: conn.name, error: retryErr.message });
          }
        }
      } else {
        failed.push({ item: conn, error: err.message });
        sendProgress(completed, connections.length, conn.name, 'failed');
        Logger.error(TAG, 'Removal failed', { name: conn.name, error: err.message });
      }
    }

    if (i < connections.length - 1 && !isCancelled) {
      if ((i + 1) % RATE.batchSize === 0) {
        sendProgress(completed, connections.length, null, 'batch_pause');
        await sleep(getBatchPause());
      } else {
        await sleep(getItemDelay());
      }
    }
  }

  sendProgress(completed, connections.length, null, 'done');
  Logger.info(TAG, 'Bulk removal complete', { completed, failed: failed.length });
  return { completed, failed, cancelled: false };
}

// ================================================================
// Message Handling
// ================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, payload } = message;

  switch (action) {
    case 'checkAuth':
      getCsrfToken()
        .then(() => sendResponse({ authenticated: true }))
        .catch(err => {
          Logger.info(TAG, 'Auth check failed', { error: err.message });
          sendResponse({ authenticated: false });
        });
      return true;

    case 'fetchAllConnections':
      fetchAllConnections((fetched, total) => {
        chrome.runtime.sendMessage({
          action: 'fetchProgress',
          payload: { fetched, total },
        }).catch(err => Logger.debug(TAG, 'Progress message not delivered', { error: err.message }));
      })
        .then(connections => sendResponse({ connections }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'bulkRemoveConnections':
      bulkRemove(payload.connections, (completed, total, currentItem, status) => {
        chrome.runtime.sendMessage({
          action: 'removeProgress',
          payload: { completed, total, currentItem, status },
        }).catch(err => Logger.debug(TAG, 'Remove progress not delivered', { error: err.message }));
      })
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'pauseRemoval':
      isPaused = true;
      Logger.info(TAG, 'Removal paused');
      sendResponse({ success: true });
      return false;

    case 'resumeRemoval':
      isPaused = false;
      if (pauseResolve) { pauseResolve(); pauseResolve = null; }
      Logger.info(TAG, 'Removal resumed');
      sendResponse({ success: true });
      return false;

    case 'cancelRemoval':
      isCancelled = true;
      isPaused = false;
      if (pauseResolve) { pauseResolve(); pauseResolve = null; }
      Logger.info(TAG, 'Removal cancelled by user');
      sendResponse({ success: true });
      return false;

    case 'getLogs':
      Logger.getLogs(payload || {})
        .then(logs => sendResponse({ logs }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'clearLogs':
      Logger.clearLogs()
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'setLogLevel':
      Logger.setLevel(payload.level)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    default:
      return false;
  }
});

// ================================================================
// Side Panel & Extension Icon
// ================================================================

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && tab.url.includes('linkedin.com')) {
    await chrome.sidePanel.open({ tabId: tab.id });
  } else {
    await chrome.tabs.create({ url: 'https://www.linkedin.com/mynetwork/' });
  }
});

chrome.sidePanel.setOptions({ enabled: true });

Logger.init().then(() => {
  Logger.info(TAG, 'Service worker loaded');
});
