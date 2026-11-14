import { createApi } from './api-core.js';
import { getApiOrigin } from './config.js';

const TOKEN_KEY = 'vv.token';
const USER_KEY = 'vv.user';

function read(key) {
  try { return window.localStorage.getItem(key); } catch (error) { return null; }
}
function write(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch (error) { /* ignoré */ }
}

export const session = {
  get token() { return read(TOKEN_KEY); },
  get user() { try { return JSON.parse(read(USER_KEY)); } catch (error) { return null; } },
  set({ token, user }) { write(TOKEN_KEY, token); write(USER_KEY, JSON.stringify(user)); },
  clear() { write(TOKEN_KEY, null); write(USER_KEY, null); },
};

export const api = createApi({
  base: getApiOrigin(),
  getToken: () => session.token,
  onUnauthorized: () => {
    session.clear();
    window.dispatchEvent(new CustomEvent('vv:logout'));
  },
});

// Flux temps réel (SSE). EventSource se reconnecte seul après une coupure.
export function openEvents(handlers) {
  if (!session.token || typeof window.EventSource !== 'function') return { close() {}, get connected() { return false; } };
  const source = new window.EventSource(api.eventsUrl());
  let connected = false;
  source.addEventListener('hello', () => { connected = true; });
  source.onerror = () => { connected = false; };
  Object.entries(handlers).forEach(([name, handler]) => {
    source.addEventListener(name, (event) => {
      try { handler(JSON.parse(event.data)); } catch (error) { console.error(error); }
    });
  });
  return { close: () => source.close(), get connected() { return connected; } };
}
