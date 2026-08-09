import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  ATTACHMENT_EXPIRATION_TTL_SECONDS,
  ATTACHMENT_QUEUE_DELAY_SECONDS,
  deleteStagedAttachments,
  hydrateEmailAttachments,
  stageEmailAttachments
} from '../src/attachments.js';
import { normalizeEmailRequest, normalizeQueuedEmail } from '../src/message.js';

class MemoryKvNamespace {
  constructor() {
    this.values = new Map();
    this.putOptions = new Map();
  }

  async put(key, value, options) {
    this.values.set(key, new Uint8Array(value));
    this.putOptions.set(key, options);
  }

  async get(key, type) {
    assert.equal(type, 'arrayBuffer');
    const value = this.values.get(key);
    return value ? value.slice().buffer : null;
  }

  async delete(key) {
    this.values.delete(key);
  }
}

test('stages, hydrates and deletes a PDF with Workers KV', async () => {
  assert.equal(ATTACHMENT_QUEUE_DELAY_SECONDS, 60);
  const pdf = Buffer.from('%PDF-1.7\nNICDAI KV attachment test\n%%EOF');
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  const message = normalizeEmailRequest({
    to: 'student@example.com',
    subject: 'Certificate issued',
    body: '<p>Your certificate is attached.</p>',
    bodyType: 'html',
    attachments: [{
      filename: 'NICDAI-2026-KV.pdf',
      contentType: 'application/pdf',
      size: pdf.length,
      sha256,
      contentBase64: pdf.toString('base64')
    }]
  });
  const kv = new MemoryKvNamespace();
  const env = { ATTACHMENT_KV: kv };
  const requestId = '12345678-1234-4123-8123-123456789abc';

  const staged = await stageEmailAttachments(message, requestId, env);
  const storageKey = `relay/${requestId}/0.pdf`;
  assert.deepEqual(staged.stagedKeys, [storageKey]);
  assert.equal(staged.message.attachments[0].storageKey, storageKey);
  assert.equal(staged.message.attachments[0].contentBase64, undefined);
  assert.equal(kv.putOptions.get(storageKey).expirationTtl, ATTACHMENT_EXPIRATION_TTL_SECONDS);
  assert.equal(kv.putOptions.get(storageKey).metadata.sha256, sha256);

  const queued = normalizeQueuedEmail(staged.message);
  const hydrated = await hydrateEmailAttachments(queued, env);
  assert.equal(hydrated.attachments[0].contentBase64, pdf.toString('base64'));

  await deleteStagedAttachments([storageKey], env, 'sent');
  assert.equal(kv.values.has(storageKey), false);
});

test('rejects invalid PDF bytes before writing to KV', async () => {
  const invalidPdf = Buffer.from('not-a-pdf');
  const sha256 = crypto.createHash('sha256').update(invalidPdf).digest('hex');
  const message = normalizeEmailRequest({
    to: 'student@example.com',
    subject: 'Certificate issued',
    body: 'Attached.',
    bodyType: 'text',
    attachments: [{
      filename: 'certificate.pdf',
      contentType: 'application/pdf',
      size: invalidPdf.length,
      sha256,
      contentBase64: invalidPdf.toString('base64')
    }]
  });
  const kv = new MemoryKvNamespace();

  await assert.rejects(
    stageEmailAttachments(message, '12345678-1234-4123-8123-123456789abc', {
      ATTACHMENT_KV: kv
    }),
    /not a valid PDF payload/
  );
  assert.equal(kv.values.size, 0);
});

test('requires the ATTACHMENT_KV binding for certificate attachments', async () => {
  const pdf = Buffer.from('%PDF-test');
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  const message = normalizeEmailRequest({
    to: 'student@example.com',
    subject: 'Certificate issued',
    body: 'Attached.',
    bodyType: 'text',
    attachments: [{
      filename: 'certificate.pdf',
      contentType: 'application/pdf',
      size: pdf.length,
      sha256,
      contentBase64: pdf.toString('base64')
    }]
  });

  await assert.rejects(
    stageEmailAttachments(message, '12345678-1234-4123-8123-123456789abc', {}),
    /ATTACHMENT_KV is not configured/
  );
});
