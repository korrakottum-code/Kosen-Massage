import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16, promptPayPayload } from '../public/assets/promptpay.js';

test('crc16 CCITT-FALSE check value', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('phone number payload with amount', () => {
  const p = promptPayPayload('081-234-5678', 100);
  assert.ok(p.startsWith('000201010212'));
  assert.ok(p.includes('0016A000000677010111' + '01130066812345678'));
  assert.ok(p.includes('5406100.00'));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
});

test('national id payload without amount is static', () => {
  const p = promptPayPayload('1234567890123');
  assert.ok(p.startsWith('000201010211'));
  assert.ok(p.includes('02131234567890123'));
  assert.ok(!p.includes('5406'));
});

test('invalid id throws', () => {
  assert.throws(() => promptPayPayload('12345'));
});
