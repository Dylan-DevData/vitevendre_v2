const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidPhone } = require('./validation');

test('phone validation matches the database format', () => {
  assert.equal(isValidPhone('+237699123456'), true);
  assert.equal(isValidPhone('699123456'), true);
  assert.equal(isValidPhone('69 912 3456'), false);
  assert.equal(isValidPhone('+1234567'), false);
});
