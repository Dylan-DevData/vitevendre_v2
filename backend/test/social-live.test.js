// Commentaires, abonnements, profil public et événements WebSocket de bout en bout.
// Lancer :  E2E_DATABASE_URL=postgresql://... node --test --test-concurrency=1 test/social-live.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const DB = process.env.E2E_DATABASE_URL;
const skip = !DB && 'E2E_DATABASE_URL non défini';

test('commentaires, abonnements et temps réel par WebSocket', { skip, timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vv2-live-'));
  process.env.DATABASE_URL = DB;
  process.env.JWT_SECRET = 'w'.repeat(40);
  process.env.UPLOAD_DIR = path.join(root, 'uploads');
  process.env.MEDIA_DIR = path.join(root, 'media');
  const { pool } = require('../src/config/db');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  const app = require('../src/app');
  const realtime = require('../src/services/realtime.service');
  const { authenticateToken } = require('../src/middlewares/authenticate');
  const server = http.createServer(app);
  const live = realtime.attach(server, { verifyToken: authenticateToken });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const sockets = [];
  t.after(async () => { sockets.forEach((ws) => ws.terminate()); live.close(); server.closeAllConnections(); server.close(); await pool.end(); });

  const call = async (method, url, { token, json } = {}) => {
    const res = await fetch(base + url, {
      method, body: json ? JSON.stringify(json) : undefined,
      headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  const register = async (phone, fullName) =>
    (await call('POST', '/api/auth/register', { json: { phone, fullName, password: 'motdepasse123' } })).data;
  const connect = async (token) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    ws.inbox = [];
    ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw.toString())));
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return ws;
  };
  const waitFor = async (ws, predicate, label) => {
    for (let i = 0; i < 100; i += 1) {
      const found = ws.inbox.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`message attendu : ${label}`);
  };
  const settle = () => new Promise((r) => setTimeout(r, 80));

  const alice = await register('600000011', 'Alice');
  const bob = await register('600000012', 'Bob');
  const carol = await register('600000013', 'Carol');
  // Vidéo prête d'Alice (insertion directe : le transcodage n'est pas l'objet de ce test).
  const videoId = Number((await pool.query(
    `INSERT INTO videos (user_id, caption, status, published_at) VALUES ($1, 'salut', 'ready', now()) RETURNING id`,
    [alice.user.id])).rows[0].id);

  const bobWs = await connect(bob.token);
  const carolWs = await connect(carol.token);
  const aliceWs = await connect(alice.token);
  bobWs.send(JSON.stringify({ type: 'join', room: `video:${videoId}` }));
  await waitFor(bobWs, (m) => m.event === 'joined', 'joined');

  // ----- Commentaires -----
  assert.equal((await call('POST', `/api/videos/${videoId}/comments`, { json: { body: 'hello' } })).status, 401);
  assert.equal((await call('POST', `/api/videos/${videoId}/comments`, { token: bob.token, json: { body: '   ' } })).status, 400);
  assert.equal((await call('POST', `/api/videos/${videoId}/comments`, { token: bob.token, json: { body: 'x'.repeat(501) } })).status, 400);
  assert.equal((await call('POST', '/api/videos/999999/comments', { token: bob.token, json: { body: 'hello' } })).status, 404);

  const posted = await call('POST', `/api/videos/${videoId}/comments`, { token: bob.token, json: { body: '  Super vidéo !  ' } });
  assert.equal(posted.status, 201);
  assert.equal(posted.data.comment.body, 'Super vidéo !');
  assert.equal(posted.data.comment.author.name, 'Bob');
  assert.equal(posted.data.commentCount, 1);
  const live1 = await waitFor(bobWs, (m) => m.event === 'comment.new', 'comment.new dans le salon');
  assert.equal(live1.data.comment.id, posted.data.comment.id);
  assert.equal((await waitFor(carolWs, (m) => m.event === 'video.stats', 'stats')).data.commentCount, 1);
  await settle();
  assert.ok(!carolWs.inbox.some((m) => m.event === 'comment.new'), 'Carol n’a pas ouvert les commentaires');

  const listed = await call('GET', `/api/videos/${videoId}/comments`);
  assert.equal(listed.data.comments.length, 1);
  assert.equal(listed.data.total, 1);
  assert.equal((await call('GET', '/api/videos', { token: carol.token })).data.videos[0].commentCount, 1);

  // Suppression : un tiers non, le propriétaire de la vidéo oui.
  const commentId = posted.data.comment.id;
  assert.equal((await call('DELETE', `/api/comments/${commentId}`, { token: carol.token })).status, 403);
  assert.equal((await call('DELETE', `/api/comments/${commentId}`)).status, 401);
  const deleted = await call('DELETE', `/api/comments/${commentId}`, { token: alice.token });
  assert.deepEqual(deleted.data, { deleted: true, commentCount: 0 });
  assert.equal((await waitFor(bobWs, (m) => m.event === 'comment.deleted', 'comment.deleted')).data.commentId, commentId);
  assert.equal((await call('DELETE', `/api/comments/${commentId}`, { token: alice.token })).status, 404);

  // L'auteur supprime son propre commentaire.
  const mine = await call('POST', `/api/videos/${videoId}/comments`, { token: bob.token, json: { body: 'encore' } });
  assert.equal((await call('DELETE', `/api/comments/${mine.data.comment.id}`, { token: bob.token })).status, 200);

  // Limite anti-spam : 8 par minute.
  let blocked = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = await call('POST', `/api/videos/${videoId}/comments`, { token: carol.token, json: { body: `spam ${i}` } });
    if (r.status === 429) blocked += 1;
  }
  assert.equal(blocked, 2, '8 acceptés puis 2 refusés');

  // J'aime : compteur en direct chez les autres.
  await call('POST', `/api/videos/${videoId}/like`, { token: bob.token });
  assert.equal((await waitFor(carolWs, (m) => m.event === 'video.stats' && m.data.likeCount === 1, 'stats like')).data.videoId, videoId);

  // ----- Abonnements -----
  assert.equal((await call('POST', `/api/users/${bob.user.id}/follow`, { token: bob.token })).status, 400, 'pas d’auto-abonnement');
  assert.equal((await call('POST', '/api/users/999999/follow', { token: bob.token })).status, 404);
  assert.equal((await call('POST', `/api/users/${alice.user.id}/follow`)).status, 401);

  const followed = await call('POST', `/api/users/${alice.user.id}/follow`, { token: bob.token });
  assert.deepEqual(followed.data, { following: true, followerCount: 1 });
  const notif = await waitFor(aliceWs, (m) => m.event === 'follow.new', 'follow.new');
  assert.equal(notif.data.follower.name, 'Bob');
  assert.equal((await waitFor(carolWs, (m) => m.event === 'user.stats', 'user.stats')).data.followerCount, 1);

  // Idempotent : pas de seconde notification.
  const again = await call('POST', `/api/users/${alice.user.id}/follow`, { token: bob.token });
  assert.equal(again.data.followerCount, 1);
  await settle();
  assert.equal(aliceWs.inbox.filter((m) => m.event === 'follow.new').length, 1);

  // Profil public.
  const asBob = (await call('GET', `/api/users/${alice.user.id}`, { token: bob.token })).data.user;
  assert.equal(asBob.name, 'Alice');
  assert.equal(asBob.videoCount, 1);
  assert.equal(asBob.followerCount, 1);
  assert.equal(asBob.followingCount, 0);
  assert.equal(asBob.followedByMe, true);
  assert.equal(asBob.isMe, false);
  assert.equal((await call('GET', `/api/users/${alice.user.id}`)).data.user.followedByMe, false);
  assert.equal((await call('GET', `/api/users/${alice.user.id}`, { token: alice.token })).data.user.isMe, true);
  assert.equal((await call('GET', `/api/users/${bob.user.id}`)).data.user.followingCount, 1);
  assert.equal((await call('GET', '/api/users/999999')).status, 404);
  assert.equal((await call('GET', '/api/videos', { token: bob.token })).data.videos[0].author.followedByMe, true);

  const unfollowed = await call('DELETE', `/api/users/${alice.user.id}/follow`, { token: bob.token });
  assert.deepEqual(unfollowed.data, { following: false, followerCount: 0 });
});
