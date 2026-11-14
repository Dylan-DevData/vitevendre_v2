// Hub d'événements temps réel.
// Deux transports reçoivent les mêmes événements :
//  - SSE (Server-Sent Events), historique : GET /api/events ;
//  - WebSocket (realtime.service.js), utilisé par l'application : ws://hôte/ws.
// Le reste du code n'appelle que emitToUser / emitToRoom / broadcast, sans savoir quel transport est utilisé.
const clients = new Map(); // userId -> Set<res>
const transports = new Set(); // transports additionnels (WebSocket)
const KEEPALIVE_MS = 20000;

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function subscribe(userId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  send(res, 'hello', { userId });
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  // Le commentaire SSE maintient la connexion ouverte à travers les proxys mobiles.
  const timer = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS);
  res.on('close', () => {
    clearInterval(timer);
    const set = clients.get(userId);
    if (set) {
      set.delete(res);
      if (!set.size) clients.delete(userId);
    }
  });
}

// Branche un transport : { emitToUser, emitToRoom, broadcast } (toutes les méthodes sont facultatives).
function addTransport(transport) {
  transports.add(transport);
  return () => transports.delete(transport);
}

// Un seul utilisateur (toutes ses connexions : téléphone, navigateur…).
function emitToUser(userId, event, data) {
  const set = clients.get(userId);
  if (set) set.forEach((res) => send(res, event, data));
  transports.forEach((t) => t.emitToUser && t.emitToUser(userId, event, data));
}

// Tous ceux qui ont rejoint un salon (ex. "video:12" = fenêtre de commentaires ouverte).
function emitToRoom(room, event, data) {
  transports.forEach((t) => t.emitToRoom && t.emitToRoom(room, event, data));
}

// Tout le monde.
function broadcast(event, data) {
  clients.forEach((set) => set.forEach((res) => send(res, event, data)));
  transports.forEach((t) => t.broadcast && t.broadcast(event, data));
}

module.exports = { subscribe, emitToUser, emitToRoom, broadcast, addTransport };
