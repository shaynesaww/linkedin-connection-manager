/**
 * Background service worker for LinkedIn Connection Manager.
 * ALL LinkedIn API calls happen here - the service worker's fetch cannot be
 * intercepted by LinkedIn's page JavaScript or Service Worker.
 */

const BASE_URL = 'https://www.linkedin.com';
const REMOVE_ENDPOINT = BASE_URL + '/voyager/api/relationships/dash/memberRelationships?action=removeFromMyConnections';
const PAGE_SIZE = 40;
const LOG = '[LCM-BG]';

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

  console.log(`${LOG} ${included.length} included entities, ${elements.length} elements`);

  const types = new Set();
  for (const entity of included) {
    if (entity['$recipeType']) types.add('recipe:' + entity['$recipeType']);
    if (entity['$type']) types.add('type:' + entity['$type']);
  }
  console.log(`${LOG} Entity types:`, [...types]);

  let connections = tryParseMiniProfiles(included);
  if (connections.length > 0) return connections;

  connections = tryParseByNameFields(included);
  if (connections.length > 0) return connections;

  connections = tryParseElements(elements, included);
  if (connections.length > 0) return connections;

  // Diagnostic dump
  console.log(`${LOG} All parse strategies failed. First 3 entities:`);
  for (let i = 0; i < Math.min(3, included.length); i++) {
    console.log(`${LOG} Entity ${i}:`, JSON.stringify(included[i]).substring(0, 1000));
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

  console.log(`${LOG} MiniProfile strategy: ${profiles.length} profiles, ${connectionEntities.length} connection entities`);

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
    console.log(`${LOG} No connectionUrn matches, using entityUrns as fallback`);
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
  } catch { return ''; }
}

// ================================================================
// API Fetching
// ================================================================

async function tryFetchWithConfig(config, start) {
  const params = new URLSearchParams({ ...config.params, start: String(start) });
  const url = `${config.url}?${params.toString()}`;
  const headers = await getHeaders();

  console.log(`${LOG} Trying ${config.name}: ${url}`);

  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    console.log(`${LOG} ${config.name} returned ${response.status}`);
    if (response.status === 429) throw new Error('RATE_LIMITED');
    return null;
  }

  const json = await response.json();
  console.log(`${LOG} ${config.name} response keys:`, Object.keys(json));
  if (json.included) console.log(`${LOG} ${json.included.length} included entities`);
  if (json.data?.paging) console.log(`${LOG} paging:`, json.data.paging);
  if (json.paging) console.log(`${LOG} paging:`, json.paging);

  // Extract total connection count from paging metadata.
  // IMPORTANT: paging.count is the PAGE SIZE, not the total. Only use paging.total.
  const paging = json.data?.paging || json.paging || {};
  const total = paging.total || 0;

  console.log(`${LOG} Paging object:`, JSON.stringify(paging));
  console.log(`${LOG} Reported total: ${total} (0 means not reported)`);

  const connections = parseConnectionsResponse(json);

  return { connections, total, json };
}

async function discoverEndpoint() {
  for (const config of ENDPOINT_CONFIGS) {
    try {
      const result = await tryFetchWithConfig(config, 0);
      if (result && (result.connections.length > 0 || result.total > 0)) {
        console.log(`${LOG} Found working endpoint: ${config.name} (${result.connections.length} connections, total: ${result.total})`);
        workingConfig = config;
        return result;
      }
      if (result) {
        console.log(`${LOG} ${config.name}: valid response but 0 connections`);
        console.log(`${LOG} Raw (first 2000):`, JSON.stringify(result.json).substring(0, 2000));
      }
    } catch (err) {
      if (err.message === 'RATE_LIMITED') throw err;
      console.log(`${LOG} ${config.name} failed:`, err.message);
    }
  }
  throw new Error('No working LinkedIn API endpoint found. Check the background service worker console for [LCM-BG] logs.');
}

async function fetchAllConnections(sendProgress) {
  console.log(`${LOG} Starting connection fetch...`);

  const firstPage = await discoverEndpoint();
  const allConnections = [...firstPage.connections];
  // Use reported total if available, otherwise estimate high and paginate until empty
  let total = firstPage.total > 0 ? firstPage.total : 10000;

  console.log(`${LOG} First page: ${firstPage.connections.length} connections, reported total: ${firstPage.total}, using total: ${total}`);
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
        console.log(`${LOG} Null result at start=${start}, stopping`);
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
          console.log(`${LOG} Two consecutive empty pages at start=${start}, stopping`);
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }

      console.log(`${LOG} Page at start=${start - PAGE_SIZE}: parsed ${pageCount} connections, total so far: ${allConnections.length}`);

      await sleep(300 + Math.random() * 200);
    } catch (err) {
      if (err.message === 'RATE_LIMITED') {
        console.log(`${LOG} Rate limited at start=${start}, waiting 30s`);
        await sleep(30000);
        continue;
      }
      console.error(`${LOG} Error at start=${start}:`, err);
      break;
    }
  }

  console.log(`${LOG} Fetch complete: ${allConnections.length} connections`);
  return allConnections;
}

async function tryRemovalStrategy(strategyNum, connection, headers) {
  const connectionUrn = connection.connectionUrn || '';
  const profileUrn = connection.entityUrn || '';
  const publicId = connection.publicIdentifier || '';

  switch (strategyNum) {
    case 1: {
      // profileActions disconnect endpoint (from linkedin-api Python library)
      // POST /voyager/api/identity/profiles/{publicId}/profileActions?action=disconnect
      if (!publicId) return null;
      const url = `${BASE_URL}/voyager/api/identity/profiles/${encodeURIComponent(publicId)}/profileActions?action=disconnect`;
      console.log(`${LOG} Strategy 1: POST ${url}`);
      return fetch(url, { method: 'POST', headers });
    }
    case 2: {
      // memberRelationships with connectionUrn field + decorationId (from Unipile docs)
      // POST /voyager/api/relationships/dash/memberRelationships?action=removeFromMyConnections&decorationId=...
      if (!connectionUrn) return null;
      const url = `${REMOVE_ENDPOINT}&decorationId=com.linkedin.voyager.dash.deco.relationships.MemberRelationship-34`;
      console.log(`${LOG} Strategy 2: POST ${url} body={connectionUrn: ${connectionUrn}}`);
      return fetch(url, { method: 'POST', headers, body: JSON.stringify({ connectionUrn }) });
    }
    case 3: {
      // memberRelationships with connectionUrn field (no decorationId)
      if (!connectionUrn) return null;
      console.log(`${LOG} Strategy 3: POST ${REMOVE_ENDPOINT} body={connectionUrn: ${connectionUrn}}`);
      return fetch(REMOVE_ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ connectionUrn }) });
    }
    case 4: {
      // POST action on the connection resource directly
      if (!connectionUrn || !connectionUrn.includes('fsd_connection')) return null;
      const encodedUrn = encodeURIComponent(connectionUrn);
      const url = `${BASE_URL}/voyager/api/relationships/dash/connections/${encodedUrn}?action=removeConnection`;
      console.log(`${LOG} Strategy 4: POST ${url}`);
      return fetch(url, { method: 'POST', headers, body: '{}' });
    }
    case 5: {
      // DELETE on the connection resource
      if (!connectionUrn) return null;
      const encodedUrn = encodeURIComponent(connectionUrn);
      const url = `${BASE_URL}/voyager/api/relationships/dash/connections/${encodedUrn}`;
      console.log(`${LOG} Strategy 5: DELETE ${url}`);
      const deleteHeaders = { ...headers };
      delete deleteHeaders['content-type'];
      return fetch(url, { method: 'DELETE', headers: deleteHeaders });
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

  console.log(`${LOG} Attempting removal: connectionUrn=${connectionUrn}, profileUrn=${profileUrn}, publicId=${connection.publicIdentifier || 'N/A'}`);

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
        console.log(`${LOG} Strategy ${stratNum} succeeded (${resp.status})`);
        workingRemovalStrategy = stratNum;
        return true;
      }
      if (resp.status === 429) throw new Error('RATE_LIMITED');
      const body = await resp.text().catch(() => '');
      console.log(`${LOG} Strategy ${stratNum} failed: ${resp.status} - ${body.substring(0, 500)}`);
    } catch (err) {
      if (err.message === 'RATE_LIMITED') throw err;
      console.log(`${LOG} Strategy ${stratNum} error:`, err.message);
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

  for (let i = 0; i < connections.length; i++) {
    if (isCancelled) {
      sendProgress(completed, connections.length, null, 'cancelled');
      return { completed, failed, cancelled: true };
    }

    await waitWhilePaused();
    if (isCancelled) {
      sendProgress(completed, connections.length, null, 'cancelled');
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
        await sleep(RATE.backoff);
        if (!isCancelled) {
          try {
            await removeConnection(conn);
            completed++;
            sendProgress(completed, connections.length, conn.name, 'removed');
          } catch (retryErr) {
            failed.push({ item: conn, error: retryErr.message });
            sendProgress(completed, connections.length, conn.name, 'failed');
          }
        }
      } else {
        failed.push({ item: conn, error: err.message });
        sendProgress(completed, connections.length, conn.name, 'failed');
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
        .catch(() => sendResponse({ authenticated: false }));
      return true;

    case 'fetchAllConnections':
      fetchAllConnections((fetched, total) => {
        chrome.runtime.sendMessage({
          action: 'fetchProgress',
          payload: { fetched, total },
        }).catch(() => {});
      })
        .then(connections => sendResponse({ connections }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'bulkRemoveConnections':
      bulkRemove(payload.connections, (completed, total, currentItem, status) => {
        chrome.runtime.sendMessage({
          action: 'removeProgress',
          payload: { completed, total, currentItem, status },
        }).catch(() => {});
      })
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'pauseRemoval':
      isPaused = true;
      sendResponse({ success: true });
      return false;

    case 'resumeRemoval':
      isPaused = false;
      if (pauseResolve) { pauseResolve(); pauseResolve = null; }
      sendResponse({ success: true });
      return false;

    case 'cancelRemoval':
      isCancelled = true;
      isPaused = false;
      if (pauseResolve) { pauseResolve(); pauseResolve = null; }
      sendResponse({ success: true });
      return false;

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

console.log(`${LOG} Service worker loaded.`);
