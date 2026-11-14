const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../src/utils/rateLimit');

test('limiteur : bloque au-delà du maximum, par clé, puis libère', async () => {
  const limiter = createRateLimiter({ max: 3, windowMs: 100 });
  assert.ok(limiter.take('a') && limiter.take('a') && limiter.take('a'));
  assert.equal(limiter.take('a'), false, '4e action refusée');
  assert.equal(limiter.take('b'), true, 'une autre clé n’est pas affectée');
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(limiter.take('a'), true, 'fenêtre écoulée : de nouveau autorisé');
});
