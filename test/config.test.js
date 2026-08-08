import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG_DEFAULTS, smtpConfiguration } from '../src/config.js';

const REQUIRED_ENV = Object.freeze({
  SMTP_USERNAME: 'relay@example.com',
  SMTP_PASSWORD: 'example-app-password'
});

test('uses safe defaults for optional SMTP environment bindings', () => {
  assert.deepEqual(smtpConfiguration(REQUIRED_ENV), {
    host: CONFIG_DEFAULTS.SMTP_HOST,
    port: 465,
    secure: true,
    username: 'relay@example.com',
    password: 'example-app-password',
    fromEmail: 'relay@example.com',
    fromName: CONFIG_DEFAULTS.SMTP_FROM_NAME,
    ehloName: CONFIG_DEFAULTS.SMTP_EHLO_NAME,
    timeoutMs: 30000
  });
});

test('reads SMTP overrides from environment bindings', () => {
  const config = smtpConfiguration({
    ...REQUIRED_ENV,
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_FROM_EMAIL: 'sender@example.com',
    SMTP_FROM_NAME: 'NICDAI Certificates',
    SMTP_EHLO_NAME: 'relay.example.com',
    SMTP_TIMEOUT_MS: '45000'
  });

  assert.equal(config.host, 'smtp.example.com');
  assert.equal(config.port, 587);
  assert.equal(config.secure, false);
  assert.equal(config.fromEmail, 'sender@example.com');
  assert.equal(config.fromName, 'NICDAI Certificates');
  assert.equal(config.ehloName, 'relay.example.com');
  assert.equal(config.timeoutMs, 45000);
});

test('requires credentials instead of using unsafe default secrets', () => {
  assert.throws(() => smtpConfiguration({}), /SMTP_USERNAME is not configured/);
  assert.throws(
    () => smtpConfiguration({ SMTP_USERNAME: 'relay@example.com' }),
    /SMTP_PASSWORD is not configured/
  );
});
