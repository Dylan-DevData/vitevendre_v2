const PHONE_PATTERN = /^\+?[0-9]{8,15}$/;

function isValidPhone(phone) {
  return typeof phone === 'string' && PHONE_PATTERN.test(phone.trim());
}

module.exports = { isValidPhone };
