// Temps réel par WebSocket (bibliothèque "ws"), sur le même port que l'API : ws://hôte:3000/ws?token=<jwt>
//
// Serveur -> client : { "event": "comment.new", "data": { ... } }
// Client -> serveur : { "type": "join" | "leave", "room": "video:12" }   |   { "type": "ping" }
//
// Salons autorisés : "video:<id>" (commentaires en direct d'une vidéo). Les événements destinés à
// une personne (video.ready, follow.new…) arrivent sans salon, via emitToUser.
const { WebSocketServer } = require('ws');
const events = require('./events.service');

const PATH = '/ws';
const ROOM_PATTERN = /^video:[1-9]\d{0,15}$/;
const MAX_ROOMS_PER_SOCKET = 30;
const MAX_MESSAGE_BYTES = 1024;
const HEARTBEAT_MS = 30000;
const FLOOD_WINDOW_MS = 10000;
const FLOOD_MAX_MESSAGES = 40;

/**
 * Attache le serveur WebSocket à un serveur HTTP existant.
 * verifyToken(token) -> { id, role } ou lève une erreur (jeton invalide) ; injecté pour pouvoir tester sans base.
 * Retourne { close(), stats() }.
 */
function attach(httpServer, { verifyToken, path = PATH } = {}) {
  if (typeof verifyToken !== 'function') throw new Error('verifyToken est requis.');

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const byUser = new Map();  // userId -> Set<ws>
  const rooms = new Map();   // salon -> Set<ws>
  const everyone = new Set();

  function sendTo(ws, event, data) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event, data }));
  }

  function leaveRoom(ws, room) {
    ws.rooms.delete(room);
    const set = rooms.get(room);
    if (set) { set.delete(ws); if (!set.size) rooms.delete(room); }
  }

  const transport = events.addTransport({
    emitToUser(userId, event, data) {
      const set = byUser.get(userId);
      if (set) set.forEach((ws) => sendTo(ws, event, data));
    },
    emitToRoom(room, event, data) {
      const set = rooms.get(room);
      if (set) set.forEach((ws) => sendTo(ws, event, data));
    },
    broadcast(event, data) {
      everyone.forEach((ws) => sendTo(ws, event, data));
    },
  });

  function onMessage(ws, raw) {
    // Anti-inondation : un client qui spamme est coupé.
    const now = Date.now();
    if (now - ws.windowStart > FLOOD_WINDOW_MS) { ws.windowStart = now; ws.count = 0; }
    ws.count += 1;
    if (ws.count > FLOOD_MAX_MESSAGES) { ws.close(1008, 'Trop de messages'); return; }

    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch (error) { return; }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'ping') { sendTo(ws, 'pong', { t: now }); return; }

    if (message.type === 'join' || message.type === 'leave') {
      const room = message.room;
      if (typeof room !== 'string' || !ROOM_PATTERN.test(room)) return;
      if (message.type === 'leave') { leaveRoom(ws, room); return; }
      if (ws.rooms.has(room)) { sendTo(ws, 'joined', { room }); return; }
      if (ws.rooms.size >= MAX_ROOMS_PER_SOCKET) { sendTo(ws, 'error', { message: 'Trop de salons.' }); return; }
      ws.rooms.add(room);
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws);
      sendTo(ws, 'joined', { room });
    }
  }

  function onConnection(ws, user) {
    ws.user = user;
    ws.rooms = new Set();
    ws.alive = true;
    ws.windowStart = Date.now();
    ws.count = 0;
    everyone.add(ws);
    if (user) {
      if (!byUser.has(user.id)) byUser.set(user.id, new Set());
      byUser.get(user.id).add(ws);
    }
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw) => onMessage(ws, raw));
    ws.on('error', () => { /* la fermeture suit : rien d'autre à faire */ });
    ws.on('close', () => {
      everyone.delete(ws);
      [...ws.rooms].forEach((room) => leaveRoom(ws, room));
      if (user) {
        const set = byUser.get(user.id);
        if (set) { set.delete(ws); if (!set.size) byUser.delete(user.id); }
      }
    });
    sendTo(ws, 'hello', { userId: user ? user.id : null });
  }

  function reject(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (error) { reject(socket, 400, 'Bad Request'); return; }
    if (url.pathname !== path) { reject(socket, 404, 'Not Found'); return; }
    socket.on('error', () => {});

    const token = url.searchParams.get('token');
    // Sans jeton : lecture seule anonyme (le fil est public). Jeton fourni mais invalide : refus.
    const identify = token ? verifyToken(token) : Promise.resolve(null);
    identify.then((user) => {
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
    }).catch((error) => {
      if (error && error.status && error.status < 500) reject(socket, 401, 'Unauthorized');
      else reject(socket, 500, 'Internal Server Error');
    });
  });

  // Battement de cœur : coupe les connexions mortes (téléphone sorti du réseau sans fermeture propre).
  const heartbeat = setInterval(() => {
    everyone.forEach((ws) => {
      if (!ws.alive) { ws.terminate(); return; }
      ws.alive = false;
      try { ws.ping(); } catch (error) { /* ignoré */ }
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    stats: () => ({ connections: everyone.size, users: byUser.size, rooms: rooms.size }),
    close() {
      clearInterval(heartbeat);
      transport();
      everyone.forEach((ws) => ws.close(1001, 'Arrêt du serveur'));
      wss.close();
    },
  };
}

module.exports = { attach, PATH };
