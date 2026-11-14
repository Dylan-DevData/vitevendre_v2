// Serveur WebSocket : salons, diffusion, authentification, anti-inondation. Aucune base de données requise.
//   node --test test/realtime.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const events = require('../src/services/events.service');
const realtime = require('../src/services/realtime.service');

const verifyToken = async (token) => {
  if (token === 'alice') return { id: 1, role: 'user' };
  if (token === 'bob') return { id: 2, role: 'user' };
  const error = new Error('Jeton invalide.'); error.status = 401; throw error;
};

async function setup(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const live = realtime.attach(server, { verifyToken });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const sockets = [];
  t.after(() => { sockets.forEach((ws) => ws.terminate()); live.close(); server.closeAllConnections(); server.close(); });

  // Ouvre un client ; les messages reçus s'accumulent dans ws.inbox.
  async function connect(token, path = '/ws') {
    const url = `ws://127.0.0.1:${port}${path}${token ? `?token=${token}` : ''}`;
    const ws = new WebSocket(url);
    ws.inbox = [];
    ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw.toString())));
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error('refus'), { status: res.statusCode }))); });
    return ws;
  }
  const waitFor = async (ws, predicate, label) => {
    for (let i = 0; i < 100; i += 1) {
      const found = ws.inbox.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`message attendu : ${label}`);
  };
  const settle = () => new Promise((r) => setTimeout(r, 60));
  return { connect, live, waitFor, settle };
}

test('hello, diffusion générale et message ciblé', async (t) => {
  const { connect, waitFor, settle } = await setup(t);
  const alice = await connect('alice');
  const bob = await connect('bob');
  const anonymous = await connect(null);
  assert.equal((await waitFor(alice, (m) => m.event === 'hello', 'hello')).data.userId, 1);
  assert.equal((await waitFor(anonymous, (m) => m.event === 'hello', 'hello')).data.userId, null);

  events.broadcast('video.stats', { videoId: 5, likeCount: 3 });
  for (const ws of [alice, bob, anonymous]) {
    assert.deepEqual((await waitFor(ws, (m) => m.event === 'video.stats', 'stats')).data, { videoId: 5, likeCount: 3 });
  }

  events.emitToUser(2, 'follow.new', { follower: { id: 1, name: 'Alice' } });
  await waitFor(bob, (m) => m.event === 'follow.new', 'follow.new');
  await settle();
  assert.ok(!alice.inbox.some((m) => m.event === 'follow.new'), 'Alice ne reçoit pas le message de Bob');
});

test('salons : join, leave, salons invalides ignorés', async (t) => {
  const { connect, live, waitFor, settle } = await setup(t);
  const alice = await connect('alice');
  const bob = await connect('bob');

  alice.send(JSON.stringify({ type: 'join', room: 'video:12' }));
  await waitFor(alice, (m) => m.event === 'joined' && m.data.room === 'video:12', 'joined');
  bob.send(JSON.stringify({ type: 'join', room: '../../etc' }));       // invalide
  bob.send(JSON.stringify({ type: 'join', room: 'video:0' }));         // invalide
  bob.send('pas du json');                                              // ignoré sans planter
  await settle();
  assert.deepEqual(live.stats(), { connections: 2, users: 2, rooms: 1 });

  events.emitToRoom('video:12', 'comment.new', { videoId: 12, comment: { id: 1 } });
  await waitFor(alice, (m) => m.event === 'comment.new', 'comment.new');
  await settle();
  assert.ok(!bob.inbox.some((m) => m.event === 'comment.new'), 'Bob n’est pas dans le salon');

  alice.send(JSON.stringify({ type: 'leave', room: 'video:12' }));
  await settle();
  assert.equal(live.stats().rooms, 0);
  events.emitToRoom('video:12', 'comment.new', { videoId: 12 });
  await settle();
  assert.equal(alice.inbox.filter((m) => m.event === 'comment.new').length, 1, 'plus de message après leave');
});

test('limite de salons par connexion', async (t) => {
  const { connect, live, waitFor, settle } = await setup(t);
  const alice = await connect('alice');
  for (let i = 1; i <= 32; i += 1) alice.send(JSON.stringify({ type: 'join', room: `video:${i}` }));
  await waitFor(alice, (m) => m.event === 'error', 'erreur trop de salons');
  await settle();
  assert.equal(live.stats().rooms, 30);
});

test('authentification : jeton invalide et mauvais chemin refusés', async (t) => {
  const { connect } = await setup(t);
  await assert.rejects(connect('faux'), (error) => error.status === 401);
  await assert.rejects(connect('alice', '/autre'), (error) => error.status === 404);
});

test('ping applicatif et nettoyage à la fermeture', async (t) => {
  const { connect, live, waitFor, settle } = await setup(t);
  const alice = await connect('alice');
  alice.send(JSON.stringify({ type: 'ping' }));
  await waitFor(alice, (m) => m.event === 'pong', 'pong');
  alice.send(JSON.stringify({ type: 'join', room: 'video:7' }));
  await settle();
  assert.equal(live.stats().rooms, 1);
  alice.close();
  await new Promise((r) => alice.once('close', r));
  await settle();
  assert.deepEqual(live.stats(), { connections: 0, users: 0, rooms: 0 });
});

test('anti-inondation : un client qui spamme est coupé', async (t) => {
  const { connect } = await setup(t);
  const alice = await connect('alice');
  const closed = new Promise((resolve) => alice.once('close', (code) => resolve(code)));
  for (let i = 0; i < 60; i += 1) alice.send(JSON.stringify({ type: 'ping' }));
  assert.equal(await closed, 1008);
});
