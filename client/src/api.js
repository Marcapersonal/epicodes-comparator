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
  getSettings:    ()        => apiFetch('/settings'),
  saveSettings:   (body)    => apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) }),

  // Search
  search:         (q)       => apiFetch(`/search?q=${encodeURIComponent(q)}`),

  // Watchlist
  getWatchlist:   ()        => apiFetch('/watchlist'),
  addToWatchlist: (body)    => apiFetch('/watchlist', { method: 'POST', body: JSON.stringify(body) }),
  removeFromWatchlist: (id) => apiFetch(`/watchlist/${id}`, { method: 'DELETE' }),
  setAlert:       (id, body)=> apiFetch(`/watchlist/${id}/alert`, { method: 'PUT', body: JSON.stringify(body) }),

  // Bulk
  getBulk:        (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/bulk${qs ? '?' + qs : ''}`);
  },
  startBulkRefresh: ()     => apiFetch('/bulk/refresh', { method: 'POST' }),
  getBulkStatus:    ()     => apiFetch('/bulk/status'),

  // Alerts history
  getAlerts:      ()        => apiFetch('/alerts'),
};

export function createProgressStream(batchId, onMessage) {
  const es = new EventSource(`/api/bulk/progress/${batchId}`);
  es.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch (_) {}
  };
  es.onerror = () => es.close();
  return () => es.close();
}
