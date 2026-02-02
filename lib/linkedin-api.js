/**
 * LinkedIn Voyager API wrapper.
 * Handles CSRF extraction, connection fetching (with pagination), and connection removal.
 * This file runs as a content script on linkedin.com.
 */

const LinkedInAPI = (() => {
  const BASE_URL = 'https://www.linkedin.com';
  const REMOVE_ENDPOINT = BASE_URL + '/voyager/api/relationships/dash/memberRelationships?action=removeFromMyConnections';
  const PAGE_SIZE = 40;
  const LOG_PREFIX = '[LCM]';

  // Multiple endpoint configurations to try, in order of likelihood
  const ENDPOINT_CONFIGS = [
    {
      name: 'dash-connections-v17',
      url: BASE_URL + '/voyager/api/relationships/dash/connections',
      params: {
        decorationId: 'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionList-17',
        count: String(PAGE_SIZE),
        q: 'search',
        sortType: 'RECENTLY_ADDED',
      },
    },
    {
      name: 'dash-connections-v16',
      url: BASE_URL + '/voyager/api/relationships/dash/connections',
      params: {
        decorationId: 'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionList-16',
        count: String(PAGE_SIZE),
        q: 'search',
        sortType: 'RECENTLY_ADDED',
      },
    },
    {
      name: 'dash-connections-v15',
      url: BASE_URL + '/voyager/api/relationships/dash/connections',
      params: {
        decorationId: 'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionList-15',
        count: String(PAGE_SIZE),
        q: 'search',
        sortType: 'RECENTLY_ADDED',
      },
    },
    {
      name: 'dash-connections-no-decoration',
      url: BASE_URL + '/voyager/api/relationships/dash/connections',
      params: {
        count: String(PAGE_SIZE),
        q: 'search',
        sortType: 'RECENTLY_ADDED',
      },
    },
    {
      name: 'legacy-connections',
      url: BASE_URL + '/voyager/api/relationships/connections',
      params: {
        count: String(PAGE_SIZE),
        q: 'search',
        sortType: 'RECENTLY_ADDED',
      },
    },
  ];

  // Which endpoint config worked (cached after discovery)
  let workingEndpointConfig = null;

  /**
   * Extract CSRF token from the JSESSIONID cookie.
   */
  function getCsrfToken() {
    const match = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    if (!match) {
      throw new Error('Could not find JSESSIONID cookie. Make sure you are logged into LinkedIn.');
    }
    return match[1];
  }

  /**
   * Standard headers required for Voyager API requests.
   */
  function getHeaders() {
    const csrf = getCsrfToken();
    return {
      'csrf-token': csrf,
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': 'en_US',
      'x-li-page-instance': 'urn:li:page:d_flagship3_people_connections;',
    };
  }

  /**
   * Parse connections from a Voyager API response.
   * Tries multiple strategies to handle different LinkedIn response formats.
   */
  function parseConnectionsResponse(json) {
    const included = json.included || [];
    const elements = json.data?.elements || json.elements || json.data?.['*elements'] || [];

    console.log(`${LOG_PREFIX} Response has ${included.length} included entities and ${elements.length} elements`);

    // Log all unique $recipeType and $type values for debugging
    const types = new Set();
    for (const entity of included) {
      if (entity['$recipeType']) types.add('recipe:' + entity['$recipeType']);
      if (entity['$type']) types.add('type:' + entity['$type']);
    }
    console.log(`${LOG_PREFIX} Entity types found:`, [...types]);

    // Strategy 1: Look for MiniProfile entities (standard format)
    let connections = tryParseMiniProfiles(included);
    if (connections.length > 0) {
      console.log(`${LOG_PREFIX} Strategy 1 (MiniProfile) found ${connections.length} connections`);
      return connections;
    }

    // Strategy 2: Look for entities with firstName/lastName regardless of type
    connections = tryParseByNameFields(included);
    if (connections.length > 0) {
      console.log(`${LOG_PREFIX} Strategy 2 (name fields) found ${connections.length} connections`);
      return connections;
    }

    // Strategy 3: Parse from elements array directly
    connections = tryParseElements(elements, included);
    if (connections.length > 0) {
      console.log(`${LOG_PREFIX} Strategy 3 (elements) found ${connections.length} connections`);
      return connections;
    }

    // Strategy 4: Dump first few entities for diagnosis
    console.log(`${LOG_PREFIX} All strategies failed. Dumping first 3 included entities for diagnosis:`);
    for (let i = 0; i < Math.min(3, included.length); i++) {
      console.log(`${LOG_PREFIX} Entity ${i}:`, JSON.stringify(included[i], null, 2).substring(0, 1000));
    }
    if (elements.length > 0) {
      console.log(`${LOG_PREFIX} First element:`, JSON.stringify(elements[0], null, 2).substring(0, 1000));
    }

    return [];
  }

  /**
   * Strategy 1: Standard MiniProfile parsing.
   */
  function tryParseMiniProfiles(included) {
    const profiles = [];
    const connectionEntities = [];

    for (const entity of included) {
      const type = (entity['$recipeType'] || entity['$type'] || '').toLowerCase();

      // Collect profile entities
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

      // Collect connection entities
      if (type.includes('connection') || entity.connectedMember || entity.connectedMemberResolutionResult) {
        connectionEntities.push(entity);
      }
    }

    console.log(`${LOG_PREFIX} Strategy 1: found ${profiles.length} profiles, ${connectionEntities.length} connection entities`);

    // Try to match profiles to connections
    for (const connEntity of connectionEntities) {
      // Try multiple ways to find the member URN
      const memberUrn = extractMemberUrn(connEntity);
      if (!memberUrn) continue;

      const profile = profiles.find(p => p.entityUrn === memberUrn);
      if (profile) {
        profile.connectionUrn = connEntity.entityUrn || '';
        profile.connectedAt = connEntity.createdAt || null;
      }
    }

    // Return profiles that have a connectionUrn
    const matched = profiles.filter(p => p.connectionUrn);

    // If we have profiles but no connection URN matches, use the profiles directly
    // with their entityUrn as a fallback connectionUrn
    if (matched.length === 0 && profiles.length > 0) {
      console.log(`${LOG_PREFIX} No connectionUrn matches, using profile entityUrns as fallback`);
      return profiles.map(p => ({
        ...p,
        connectionUrn: p.connectionUrn || p.entityUrn,
      }));
    }

    return matched;
  }

  /**
   * Strategy 2: Find any entity with firstName and lastName.
   */
  function tryParseByNameFields(included) {
    const connections = [];
    const seen = new Set();

    for (const entity of included) {
      if (!entity.firstName && !entity.lastName) continue;
      if (!entity.entityUrn) continue;
      if (seen.has(entity.entityUrn)) continue;
      seen.add(entity.entityUrn);

      connections.push({
        firstName: entity.firstName || '',
        lastName: entity.lastName || '',
        name: `${entity.firstName || ''} ${entity.lastName || ''}`.trim(),
        headline: entity.occupation || entity.headline || entity.title || '',
        publicIdentifier: entity.publicIdentifier || '',
        profileUrl: entity.publicIdentifier
          ? `https://www.linkedin.com/in/${entity.publicIdentifier}/`
          : '',
        entityUrn: entity.entityUrn || '',
        connectionUrn: entity.entityUrn, // Use entityUrn as connectionUrn fallback
        connectedAt: entity.createdAt || null,
        profilePicture: extractProfilePicture(entity),
      });
    }

    return connections;
  }

  /**
   * Strategy 3: Parse from the elements array (some endpoints return data here).
   */
  function tryParseElements(elements, included) {
    const connections = [];
    const entityMap = new Map();
    for (const entity of included) {
      if (entity.entityUrn) entityMap.set(entity.entityUrn, entity);
    }

    for (const elem of elements) {
      // Elements might be URN strings referencing included entities
      if (typeof elem === 'string') {
        const entity = entityMap.get(elem);
        if (entity && (entity.firstName || entity.lastName)) {
          connections.push({
            firstName: entity.firstName || '',
            lastName: entity.lastName || '',
            name: `${entity.firstName || ''} ${entity.lastName || ''}`.trim(),
            headline: entity.occupation || entity.headline || '',
            publicIdentifier: entity.publicIdentifier || '',
            profileUrl: entity.publicIdentifier
              ? `https://www.linkedin.com/in/${entity.publicIdentifier}/`
              : '',
            entityUrn: entity.entityUrn,
            connectionUrn: entity.entityUrn,
            profilePicture: extractProfilePicture(entity),
          });
        }
        continue;
      }

      // Elements might be objects with member data or references
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
              profileUrl: profile.publicIdentifier
                ? `https://www.linkedin.com/in/${profile.publicIdentifier}/`
                : '',
              entityUrn: profile.entityUrn || '',
              connectionUrn: elem.entityUrn || profile.entityUrn || '',
              connectedAt: elem.createdAt || null,
              profilePicture: extractProfilePicture(profile),
            });
          }
        }

        // The element itself might contain the profile data
        if (elem.firstName || elem.lastName) {
          connections.push({
            firstName: elem.firstName || '',
            lastName: elem.lastName || '',
            name: `${elem.firstName || ''} ${elem.lastName || ''}`.trim(),
            headline: elem.occupation || elem.headline || '',
            publicIdentifier: elem.publicIdentifier || '',
            profileUrl: elem.publicIdentifier
              ? `https://www.linkedin.com/in/${elem.publicIdentifier}/`
              : '',
            entityUrn: elem.entityUrn || '',
            connectionUrn: elem.entityUrn || '',
            profilePicture: extractProfilePicture(elem),
          });
        }
      }
    }

    return connections;
  }

  /**
   * Extract the connected member URN from a connection entity.
   * Tries multiple field names that LinkedIn may use.
   */
  function extractMemberUrn(entity) {
    const fields = [
      'connectedMember',
      'connectedMemberResolutionResult',
      '*connectedMember',
      'member',
      '*member',
      'miniProfile',
      '*miniProfile',
    ];

    for (const field of fields) {
      const val = entity[field];
      if (!val) continue;
      if (typeof val === 'string') return val;
      if (typeof val === 'object' && val.entityUrn) return val.entityUrn;
    }

    return null;
  }

  /**
   * Extract a usable profile picture URL from a profile entity.
   */
  function extractProfilePicture(entity) {
    try {
      const pictures = entity.picture || entity.profilePicture || entity.image;
      if (!pictures) return '';

      // Try nested VectorImage format
      const vectorImage = pictures['com.linkedin.common.VectorImage'] || pictures;
      const artifacts = vectorImage?.artifacts || [];
      const rootUrl = vectorImage?.rootUrl || '';

      if (artifacts.length > 0 && rootUrl) {
        const smallest = artifacts[0];
        return rootUrl + (smallest.fileIdentifyingUrlPathSegment || '');
      }

      // Try direct URL
      if (typeof pictures === 'string') return pictures;

      return '';
    } catch {
      return '';
    }
  }

  /**
   * Try a specific endpoint configuration and return the result.
   */
  async function tryFetchWithConfig(config, start) {
    const params = new URLSearchParams({ ...config.params, start: String(start) });
    const url = `${config.url}?${params.toString()}`;

    console.log(`${LOG_PREFIX} Trying ${config.name}: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: getHeaders(),
      credentials: 'include',
    });

    if (!response.ok) {
      console.log(`${LOG_PREFIX} ${config.name} returned ${response.status}`);
      if (response.status === 429) throw new Error('RATE_LIMITED');
      return null;
    }

    const json = await response.json();

    // Log the top-level structure
    const keys = Object.keys(json);
    console.log(`${LOG_PREFIX} ${config.name} response keys:`, keys);

    if (json.included) {
      console.log(`${LOG_PREFIX} ${config.name} has ${json.included.length} included entities`);
    }
    if (json.data) {
      console.log(`${LOG_PREFIX} ${config.name} data keys:`, Object.keys(json.data));
      if (json.data.paging) {
        console.log(`${LOG_PREFIX} ${config.name} paging:`, json.data.paging);
      }
    }
    if (json.paging) {
      console.log(`${LOG_PREFIX} ${config.name} paging:`, json.paging);
    }

    // Extract total
    const total = json.data?.paging?.total
      || json.paging?.total
      || json.data?.paging?.count
      || 0;

    const connections = parseConnectionsResponse(json);

    return { connections, total, json };
  }

  /**
   * Discover which endpoint configuration works by trying each one.
   */
  async function discoverEndpoint() {
    for (const config of ENDPOINT_CONFIGS) {
      try {
        const result = await tryFetchWithConfig(config, 0);
        if (result && (result.connections.length > 0 || result.total > 0)) {
          console.log(`${LOG_PREFIX} Working endpoint found: ${config.name} (${result.connections.length} connections, total: ${result.total})`);
          workingEndpointConfig = config;
          return result;
        }

        // Even if 0 connections, if we got a valid response with paging, log it
        if (result) {
          console.log(`${LOG_PREFIX} ${config.name} returned valid response but 0 connections. Trying next...`);

          // Dump the raw response for this endpoint to help debug
          console.log(`${LOG_PREFIX} ${config.name} raw response (first 2000 chars):`,
            JSON.stringify(result.json, null, 2).substring(0, 2000));
        }
      } catch (err) {
        if (err.message === 'RATE_LIMITED') throw err;
        console.log(`${LOG_PREFIX} ${config.name} failed:`, err.message);
      }
    }

    throw new Error(
      'Could not find a working LinkedIn API endpoint. ' +
      'Open DevTools console (F12) and look for [LCM] messages for diagnostic details.'
    );
  }

  /**
   * Fetch a single page of connections using the discovered endpoint.
   */
  async function fetchConnectionsPage(start = 0) {
    if (!workingEndpointConfig) {
      throw new Error('No working endpoint discovered. Call discoverEndpoint first.');
    }

    const result = await tryFetchWithConfig(workingEndpointConfig, start);
    if (!result) {
      throw new Error(`API request failed for ${workingEndpointConfig.name}`);
    }

    return { connections: result.connections, total: result.total };
  }

  /**
   * Fetch ALL connections with pagination.
   * First discovers the working endpoint, then paginates through all results.
   */
  async function fetchAllConnections(progressCallback) {
    console.log(`${LOG_PREFIX} Starting connection fetch...`);
    console.log(`${LOG_PREFIX} CSRF token present: ${!!getCsrfToken()}`);

    // Step 1: Discover which endpoint works
    const firstPage = await discoverEndpoint();
    const allConnections = [...firstPage.connections];
    let total = firstPage.total || firstPage.connections.length;

    console.log(`${LOG_PREFIX} First page: ${firstPage.connections.length} connections, total reported: ${total}`);

    if (progressCallback) {
      progressCallback(allConnections.length, total);
    }

    // Step 2: Paginate through remaining pages
    let start = PAGE_SIZE;

    while (start < total) {
      try {
        const result = await fetchConnectionsPage(start);

        allConnections.push(...result.connections);
        start += PAGE_SIZE;

        // Update total if the API gives us a better number
        if (result.total > total) {
          total = result.total;
        }

        if (progressCallback) {
          progressCallback(allConnections.length, total);
        }

        // Safety: if a page returns 0 connections, we've hit the end
        if (result.connections.length === 0) {
          console.log(`${LOG_PREFIX} Empty page at start=${start}, stopping pagination`);
          break;
        }

        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 200));

      } catch (err) {
        if (err.message === 'RATE_LIMITED') {
          console.log(`${LOG_PREFIX} Rate limited during pagination at start=${start}, waiting 30s...`);
          await new Promise(resolve => setTimeout(resolve, 30000));
          // Retry same page
          continue;
        }
        console.error(`${LOG_PREFIX} Error fetching page at start=${start}:`, err);
        break;
      }
    }

    console.log(`${LOG_PREFIX} Fetch complete. Total connections: ${allConnections.length}`);
    return allConnections;
  }

  /**
   * Remove a single connection.
   */
  async function removeConnection(connectionUrn) {
    console.log(`${LOG_PREFIX} Removing connection: ${connectionUrn}`);

    const response = await fetch(REMOVE_ENDPOINT, {
      method: 'POST',
      headers: {
        ...getHeaders(),
        'content-type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        invitee: connectionUrn,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) throw new Error('RATE_LIMITED');
      throw new Error(`Failed to remove connection: ${response.status}`);
    }

    return true;
  }

  /**
   * Check if the user is logged in.
   */
  function isAuthenticated() {
    try {
      getCsrfToken();
      return true;
    } catch {
      return false;
    }
  }

  return {
    fetchAllConnections,
    removeConnection,
    isAuthenticated,
    getCsrfToken,
    PAGE_SIZE,
  };
})();
