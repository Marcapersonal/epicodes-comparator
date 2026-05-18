const BASE = '/api';

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  // Settings
  getSettings:  ()     => apiFetch('/settings'),
  saveSettings: (body) => apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) }),

  // Search
  search: (q) => apiFetch(`/search?q=${encodeURIComponent(q)}`),

  // Watchlist
  getWatchlist:        ()        => apiFetch('/watchlist'),
  addToWatchlist:      (body)    => apiFetch('/watchlist', { method: 'POST', body: JSON.stringify(body) }),
  removeFromWatchlist: (id)      => apiFetch(`/watchlist/${id}`, { method: 'DELETE' }),
  setAlert:            (id, body)=> apiFetch(`/watchlist/${id}/alert`, { method: 'PUT', body: JSON.stringify(body) }),

  // Bulk
  getBulk: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/bulk${qs ? '?' + qs : ''}`);
  },
  startBulkRefresh: () => apiFetch('/bulk/refresh', { method: 'POST' }),
  getBulkStatus:    () => apiFetch('/bulk/status'),

  // Alerts history
  getAlerts: () => apiFetch('/alerts'),

  // Price history
  startHistoryFetch: () => apiFetch('/history/fetch', { method: 'POST' }),
  getHistoryStatus:  () => apiFetch('/history/status'),

  // ── Catalog (new game_catalog system) ─────────────────────────────────────
  /** List all non-excluded catalog entries */
  getCatalog: (all = false) => apiFetch(`/catalog${all ? '?all=1' : ''}`),

  /** Count of entries with no validated_at */
  getUnvalidatedCount: () => apiFetch('/catalog/unvalidated-count'),

  /** Preview editions from Sony US before adding — returns { editions: [...] } */
  previewCatalogAdd: (name) => apiFetch('/catalog/preview', {
    method: 'POST', body: JSON.stringify({ name }),
  }),

  /** Confirm and add selected editions to the catalog */
  confirmCatalogAdd: (editions) => apiFetch('/catalog/add', {
    method: 'POST', body: JSON.stringify({ editions }),
  }),

  /** Mark a catalog entry as validated by user */
  validateCatalogEntry: (id) => apiFetch(`/catalog/validate/${id}`, { method: 'POST' }),

  /** Update any fields on a catalog entry (URLs, confidence, etc.) */
  updateCatalogEntry: (id, data) => apiFetch(`/catalog/${id}`, {
    method: 'PUT', body: JSON.stringify(data),
  }),

  /** Exclude (soft-delete) a catalog entry */
  removeCatalogEntry: (id) => apiFetch(`/catalog/${id}`, { method: 'DELETE' }),

  /** Legacy quick-add (no edition expansion) */
  addToCatalog: (name) => apiFetch('/catalog', {
    method: 'POST', body: JSON.stringify({ name }),
  }),

  /** Backward compat */
  removeFromCatalog: (id) => apiFetch(`/catalog/${id}`, { method: 'DELETE' }),

  /** Re-search alt region for all catalog entries (background job) */
  reSearchAltRegion: () => apiFetch('/catalog/re-search-alt-region', { method: 'POST' }),

  // ── PlatPrices (kept for potential future use, UI removed per TASK 8) ─────
  // getPlatPricesStatus: () => apiFetch('/platprices/status'),
  // startPlatPricesSeed: () => apiFetch('/platprices/seed', { method: 'POST' }),
};

export function createProgressStream(batchId, onMessage) {
  const es = new EventSource(`/api/bulk/progress/${batchId}`);
  es.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch (_) {}
  };
  es.onerror = () => es.close();
  return () => es.close();
}

export function createHistoryStream(jobId, onMessage) {
  const es = new EventSource(`/api/history/progress/${jobId}`);
  es.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch (_) {}
  };
  es.onerror = () => es.close();
  return () => es.close();
}

// PlatPrices stream kept for backward compat but unused by UI
export function createPlatPricesStream(jobId, onMessage) {
  const es = new EventSource(`/api/platprices/progress/${jobId}`);
  es.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch (_) {}
  };
  es.onerror = () => es.close();
  return () => es.close();
}
