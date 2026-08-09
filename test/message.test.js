import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  RelayValidationError,
  buildMimeMessage,
  normalizeEmailRequest,
  normalizeQueuedEmail
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

test('normalizes, stages and renders an integrity-protected PDF attachment', () => {
  const pdf = Buffer.from('%PDF-1.7\nNICDAI certificate test\n%%EOF');
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  const incoming = normalizeEmailRequest({
    to: 'student@example.com',
    subject: 'Your certificate',
    body: '<p>Attached.</p>',
    bodyType: 'html',
    attachments: [{
      filename: 'NICDAI-2026-TEST.pdf',
      contentType: 'application/pdf',
      size: pdf.length,
      sha256,
      contentBase64: pdf.toString('base64')
    }]
  });
  assert.equal(incoming.attachments[0].size, pdf.length);

  const queued = normalizeQueuedEmail({
    ...incoming,
    attachments: [{
      filename: incoming.attachments[0].filename,
      contentType: incoming.attachments[0].contentType,
      size: incoming.attachments[0].size,
      sha256,
      storageKey: 'relay/12345678-1234-4123-8123-123456789abc/0.pdf'
    }]
  });
  assert.equal(queued.attachments[0].storageKey, 'relay/12345678-1234-4123-8123-123456789abc/0.pdf');

  const mime = buildMimeMessage({
    ...queued,
    attachments: [{ ...queued.attachments[0], contentBase64: pdf.toString('base64') }]
  }, {
    fromEmail: 'certificates@example.com',
    fromName: 'NICDAI',
    requestId: '12345678-attachment',
    date: '2026-08-09T00:00:00.000Z'
  });
  assert.match(mime, /Content-Type: multipart\/mixed/);
  assert.match(mime, /Content-Type: application\/pdf; name="NICDAI-2026-TEST\.pdf"/);
  assert.match(mime, /Content-Disposition: attachment; filename="NICDAI-2026-TEST\.pdf"/);
  assert.match(mime, new RegExp(`X-Attachment-SHA256: ${sha256}`));
  assert.match(mime, new RegExp(pdf.toString('base64')));
});

test('rejects unsafe or inconsistent attachments', () => {
  const pdf = Buffer.from('%PDF-test');
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  const baseMessage = {
    to: 'student@example.com',
    subject: 'Certificate',
    body: 'Attached.',
    bodyType: 'text'
  };
  assert.throws(() => normalizeEmailRequest({
    ...baseMessage,
    attachments: [{
      filename: '../certificate.pdf',
      contentType: 'application/pdf',
      size: pdf.length,
      sha256,
      contentBase64: pdf.toString('base64')
    }]
  }), /safe PDF filename/);
  assert.throws(() => normalizeEmailRequest({
    ...baseMessage,
    attachments: [{
      filename: 'certificate.pdf',
      contentType: 'application/pdf',
      size: pdf.length + 1,
      sha256,
      contentBase64: pdf.toString('base64')
    }]
  }), /size does not match/);
});
