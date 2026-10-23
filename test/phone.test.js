'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, formatChatId } = require('../src/services/whatsapp');

test('deutsche Nummern werden ins WAHA Format umgewandelt', () => {
  const expected = '491711234567@c.us';
  for (const input of [
    '0171 1234567',
    '01711234567',
    '0171/123-4567',
    '(0171) 123 45 67',
    '+49 171 1234567',
    '+491711234567',
    '0049 171 1234567',
    '+49 (0) 171 1234567',
    '491711234567',
    '171 1234567',
  ]) {
    assert.equal(formatChatId(input), expected, input);
  }
});

test('Festnetz und Auslandsnummern', () => {
  assert.equal(formatChatId('089 12345678'), '498912345678@c.us');
  assert.equal(formatChatId('+43 664 1234567'), '436641234567@c.us');
  assert.equal(formatChatId('0043 664 1234567'), '436641234567@c.us');
});

test('ungültige Eingaben liefern null', () => {
  for (const input of ['', '12345', 'abc', '0', '+49 12', '0171 1234567 1234567 99', null, undefined, 42]) {
    assert.equal(normalizePhone(input), null, String(input));
  }
});
