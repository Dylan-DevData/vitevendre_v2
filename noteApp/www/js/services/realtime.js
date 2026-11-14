import { api, session } from '../api.js';

// Client temps réel (WebSocket) : une connexion par session, reconnexion automatique avec attente
// croissante, salons réabonnés après chaque reconnexion, battement de cœur pour détecter les coupures
// silencieuses des réseaux mobiles.
//
//   const rt = createRealtime();
//   rt.connect();
//   const off = rt.on('comment.new', (data) => ...);   // off() pour se désabonner
//   rt.join('video:12'); rt.leave('video:12');
//   rt.on('connection', ({ online, again }) => ...);   // événement local ; again = reconnexion
//   rt.close();                                          // à la déconnexion de l'utilisateur

const PING_EVERY_MS = 25000;
const DEAD_AFTER_MS = 60000;
const MAX_BACKOFF_MS = 30000;

export function createRealtime() {
  const handlers = new Map(); // événement -> Set<fonction>
  const rooms = new Set();
  let socket = null;
  let closed = true;
  let connected = false;
  let hadConnection = false;
  let attempts = 0;
  let retryTimer = 0;
  let pingTimer = 0;
  let lastSeen = 0;

  function emit(event, data) {
    const set = handlers.get(event);
    if (set) [...set].forEach((fn) => { try { fn(data); } catch (error) { console.error(error); } });
  }

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => handlers.get(event).delete(fn);
  }

  function send(payload) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(payload));
  }

  const join = (room) => { rooms.add(room); send({ type: 'join', room }); };
  const leave = (room) => { rooms.delete(room); send({ type: 'leave', room }); };

  function stopPing() { clearInterval(pingTimer); pingTimer = 0; }

  function startPing(current) {
    stopPing();
    pingTimer = setInterval(() => {
      // Aucun message depuis trop longtemps : la connexion est morte sans l'avoir dit.
      if (Date.now() - lastSeen > DEAD_AFTER_MS) { current.close(); return; }
      send({ type: 'ping' });
    }, PING_EVERY_MS);
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    // 1 s, 2 s, 4 s… plafonné à 30 s, avec un peu d'aléa pour éviter que tout le monde se reconnecte en même temps.
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts) * (0.6 + Math.random() * 0.4);
    attempts += 1;
    retryTimer = setTimeout(() => { retryTimer = 0; open(); }, delay);
  }

  function open() {
    if (closed || socket || typeof window.WebSocket !== 'function' || !session.token) return;
    let current;
    try { current = new window.WebSocket(api.wsUrl()); } catch (error) { scheduleRetry(); return; }
    socket = current;
    lastSeen = Date.now();

    current.onmessage = (event) => {
      lastSeen = Date.now();
      let message;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (!message || typeof message.event !== 'string') return;
      if (message.event === 'hello') {
        connected = true; attempts = 0;
        rooms.forEach((room) => send({ type: 'join', room }));   // retrouve ses salons après une coupure
        startPing(current);
        emit('connection', { online: true, again: hadConnection });
        hadConnection = true;
        return;
      }
      if (message.event === 'pong' || message.event === 'joined') return;
      emit(message.event, message.data);
    };
    current.onclose = () => {
      if (socket !== current) return;
      socket = null; stopPing();
      if (connected) { connected = false; emit('connection', { online: false, again: false }); }
      scheduleRetry();
    };
    current.onerror = () => { /* onclose suit toujours : la reconnexion s'y décide */ };
  }

  // Retour au premier plan / réseau revenu : on ne fait pas attendre l'utilisateur.
  function retryNow() {
    if (closed) return;
    if (socket) return;
    clearTimeout(retryTimer); retryTimer = 0; attempts = 0;
    open();
  }
  const onVisible = () => { if (!document.hidden) retryNow(); };
  const listeners = [
    [window, 'online', retryNow],
    [document, 'visibilitychange', onVisible],
    [document, 'resume', retryNow],   // Cordova
  ];

  return {
    on, join, leave,
    get connected() { return connected; },
    connect() {
      if (!closed) return;
      closed = false;
      listeners.forEach(([target, name, fn]) => target.addEventListener(name, fn));
      open();
    },
    close() {
      closed = true; connected = false;
      clearTimeout(retryTimer); retryTimer = 0; stopPing();
      listeners.forEach(([target, name, fn]) => target.removeEventListener(name, fn));
      if (socket) { const current = socket; socket = null; current.close(); }
      rooms.clear(); handlers.clear();
    },
  };
}
