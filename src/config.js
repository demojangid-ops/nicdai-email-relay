import { normalizeMailbox } from './message.js';

export const CONFIG_DEFAULTS = Object.freeze({
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_FROM_NAME: 'NICDAI',
  SMTP_EHLO_NAME: 'nicdai-email-relay.demojangid.workers.dev',
  SMTP_TIMEOUT_MS: '30000'
});

export function smtpConfiguration(env = {}) {
  const host = settingOrDefault(env.SMTP_HOST, CONFIG_DEFAULTS.SMTP_HOST);
  const port = integerSetting(
    settingOrDefault(env.SMTP_PORT, CONFIG_DEFAULTS.SMTP_PORT),
    'SMTP_PORT',
    1,
    65535
  );
  if (port === 25) {
    throw new Error('Cloudflare Workers does not allow outbound SMTP on port 25.');
  }

  const defaultSecure = port === 465 ? CONFIG_DEFAULTS.SMTP_SECURE : 'false';
  const secure = booleanSetting(settingOrDefault(env.SMTP_SECURE, defaultSecure), 'SMTP_SECURE');
  if (port === 465 && !secure) {
    throw new Error('SMTP_SECURE must be true when SMTP_PORT is 465.');
  }

  const username = requiredSetting(env.SMTP_USERNAME, 'SMTP_USERNAME');
  const password = requiredSetting(env.SMTP_PASSWORD, 'SMTP_PASSWORD');
  const fromEmail = normalizeMailbox(
    settingOrDefault(env.SMTP_FROM_EMAIL, username),
    'SMTP_FROM_EMAIL'
  );
  const fromName = settingOrDefault(env.SMTP_FROM_NAME, CONFIG_DEFAULTS.SMTP_FROM_NAME)
    .slice(0, 120);
  const ehloName = settingOrDefault(env.SMTP_EHLO_NAME, CONFIG_DEFAULTS.SMTP_EHLO_NAME);
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(ehloName)) {
    throw new Error('SMTP_EHLO_NAME is invalid.');
  }

  const timeoutMs = integerSetting(
    settingOrDefault(env.SMTP_TIMEOUT_MS, CONFIG_DEFAULTS.SMTP_TIMEOUT_MS),
    'SMTP_TIMEOUT_MS',
    5000,
    120000
  );

  return { host, port, secure, username, password, fromEmail, fromName, ehloName, timeoutMs };
}

function settingOrDefault(value, fallback) {
  const setting = typeof value === 'string' ? value.trim() : '';
  return setting || fallback;
}

function requiredSetting(value, name) {
  const setting = typeof value === 'string' ? value.trim() : '';
  if (!setting) throw new Error(`${name} is not configured.`);
  return setting;
}

function integerSetting(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function booleanSetting(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}
