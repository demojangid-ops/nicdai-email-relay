import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RelayValidationError,
  buildMimeMessage,
  normalizeEmailRequest
} from '../src/message.js';

test('normalizes a valid HTML email request', () => {
  assert.deepEqual(normalizeEmailRequest({
    to: ['Student@Example.com', 'student@example.com'],
    cc: 'support@example.com, audit@example.com',
    subject: 'Certificate issued',
    body: '<strong>Congratulations</strong>',
    bodyType: 'html'
  }), {
    to: ['student@example.com'],
    cc: ['support@example.com', 'audit@example.com'],
    subject: 'Certificate issued',
    body: '<strong>Congratulations</strong>',
    bodyType: 'html'
  });
});

test('rejects header injection and invalid recipients', () => {
  assert.throws(() => normalizeEmailRequest({
    to: 'invalid-address',
    subject: 'Hello\r\nBcc: attacker@example.com',
    body: 'test',
    bodyType: 'text'
  }), RelayValidationError);
  assert.throws(() => normalizeEmailRequest({
    to: 'student@example.com',
    subject: 'Hello\r\nBcc: attacker@example.com',
    body: 'test',
    bodyType: 'text'
  }), /line breaks/);
});

test('builds a safe UTF-8 HTML MIME message', () => {
  const message = normalizeEmailRequest({
    to: 'student@example.com',
    cc: 'support@example.com',
    subject: 'NICDAI certificate 🎓',
    body: '<p>Congratulations, विद्यार्थी</p>',
    bodyType: 'html'
  });
  const mime = buildMimeMessage(message, {
    fromEmail: 'certificates@example.com',
    fromName: 'NICDAI',
    requestId: '12345678-test',
    date: '2026-08-06T00:00:00.000Z'
  });

  assert.match(mime, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(mime, /To: student@example.com/);
  assert.match(mime, /Cc: support@example.com/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.match(mime, /X-NICDAI-Relay-ID: 12345678-test/);
  assert.doesNotMatch(mime, /विद्यार्थी/);
});
