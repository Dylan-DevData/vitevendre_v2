// Client HTTP sans dépendance au navigateur (testable dans Node).
export class ApiError extends Error {
  constructor({ status = 0, code = 'REQUEST_FAILED', message, network = false }) {
    super(message || 'Une erreur est survenue pendant la requête.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.network = network;
  }
}

export function createApi({ base, getToken = () => null, onUnauthorized = () => {}, fetchImpl }) {
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  async function raw(method, path, { body, headers = {}, signal, auth = true } = {}) {
    const token = auth ? getToken() : null;
    let response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        signal,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      throw new ApiError({ code: 'NETWORK', network: true, message: 'Réseau indisponible.' });
    }
    let data = null;
    if (response.status !== 204) {
      const text = await response.text().catch(() => '');
      try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
    }
    return { status: response.status, data };
  }

  async function json(method, path, payload, options = {}) {
    const result = await raw(method, path, {
      ...options,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    });
    if (result.status === 401 && options.auth !== false) onUnauthorized();
    if (result.status >= 400) {
      throw new ApiError({
        status: result.status,
        message: (result.data && result.data.error) || `Erreur serveur (${result.status}).`,
      });
    }
    return result.data;
  }

  return {
    base,
    register: (body) => json('POST', '/api/auth/register', body, { auth: false }),
    login: (body) => json('POST', '/api/auth/login', body, { auth: false }),
    feed: ({ before, limit = 8, author } = {}) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (before) params.set('before', String(before));
      if (author) params.set('author', String(author));
      return json('GET', `/api/videos?${params}`);
    },
    getVideo: (id) => json('GET', `/api/videos/${id}`),
    like: (id) => json('POST', `/api/videos/${id}/like`),
    unlike: (id) => json('DELETE', `/api/videos/${id}/like`),

    // --- Commentaires ---
    comments: (id, { before, limit = 20 } = {}) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (before) params.set('before', String(before));
      return json('GET', `/api/videos/${id}/comments?${params}`);
    },
    addComment: (id, body) => json('POST', `/api/videos/${id}/comments`, { body }),
    deleteComment: (id) => json('DELETE', `/api/comments/${id}`),

    // --- Profils publics et abonnements ---
    profile: (id) => json('GET', `/api/users/${id}`),
    follow: (id) => json('POST', `/api/users/${id}/follow`),
    unfollow: (id) => json('DELETE', `/api/users/${id}/follow`),

    // --- Upload reprenable par offset ---
    // Seul patchChunk transporte des octets vidéo ; les autres opérations échangent du JSON.
    createUpload: (body, signal) => json('POST', '/api/uploads', body, { signal }),
    getUpload: (id, signal) => json('GET', `/api/uploads/${id}`, undefined, { signal }),
    // Ne lève pas pour 409 : le serveur y renvoie l'offset réel à reprendre.
    patchChunk: (id, offset, bytes, signal) => raw('PATCH', `/api/uploads/${id}`, {
      body: bytes,
      signal,
      // L'offset permet au backend de détecter un morceau répété ou manquant.
      headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' },
    }),
    completeUpload: (id) => json('POST', `/api/uploads/${id}/complete`),
    abortUpload: (id) => json('DELETE', `/api/uploads/${id}`),

    // WebSocket temps réel : http -> ws, https -> wss.
    wsUrl: () => `${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(getToken() || '')}`,
    eventsUrl: () => `${base}/api/events?token=${encodeURIComponent(getToken() || '')}`,
  };
}
