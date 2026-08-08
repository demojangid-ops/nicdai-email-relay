const MAX_RECIPIENTS = 50;
const MAX_SUBJECT_BYTES = 500;
const MAX_BODY_BYTES = 80_000;
const EMAIL_PATTERN = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

export function normalizeEmailRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RelayValidationError('The request body must be a JSON object.');
  }

  const to = normalizeRecipients(input.to, 'to', true);
  const cc = normalizeRecipients(input.cc, 'cc', false)
    .filter((recipient) => !to.includes(recipient));
  if (to.length + cc.length > MAX_RECIPIENTS) {
    throw new RelayValidationError(`A message can have at most ${MAX_RECIPIENTS} recipients.`);
  }

  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  if (!subject) throw new RelayValidationError('subject is required.');
  if (containsHeaderBreak(subject)) {
    throw new RelayValidationError('subject cannot contain line breaks.');
  }
  if (byteLength(subject) > MAX_SUBJECT_BYTES) {
    throw new RelayValidationError(`subject cannot exceed ${MAX_SUBJECT_BYTES} UTF-8 bytes.`);
  }

  const body = typeof input.body === 'string' ? input.body : '';
  if (!body) throw new RelayValidationError('body is required.');
  if (byteLength(body) > MAX_BODY_BYTES) {
    throw new RelayValidationError(`body cannot exceed ${MAX_BODY_BYTES} UTF-8 bytes.`);
  }

  const requestedBodyType = typeof input.bodyType === 'string'
    ? input.bodyType.trim().toLowerCase()
    : '';
  const bodyType = requestedBodyType === 'plain' ? 'text' : requestedBodyType;
  if (bodyType !== 'text' && bodyType !== 'html') {
    throw new RelayValidationError('bodyType must be either text or html.');
  }

  return { to, cc, subject, body, bodyType };
}

export function normalizeMailbox(value, fieldName = 'email') {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 254 || containsHeaderBreak(email) || !EMAIL_PATTERN.test(email)) {
    throw new RelayValidationError(`${fieldName} must be a valid email address.`);
  }
  return email;
}

export function buildMimeMessage(message, options) {
  const fromEmail = normalizeMailbox(options.fromEmail, 'SMTP_FROM_EMAIL');
  const fromName = sanitizeDisplayName(options.fromName || 'NICDAI');
  const requestId = sanitizeMessageId(options.requestId);
  const contentType = message.bodyType === 'html' ? 'text/html' : 'text/plain';
  const headers = [
    `Date: ${new Date(options.date || Date.now()).toUTCString()}`,
    `Message-ID: <${requestId}@${fromEmail.split('@')[1]}>`,
    `From: ${encodeHeader(fromName)} <${fromEmail}>`,
    `To: ${message.to.join(', ')}`,
    ...(message.cc.length ? [`Cc: ${message.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    `X-NICDAI-Relay-ID: ${requestId}`,
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64'
  ];

  return `${headers.join('\r\n')}\r\n\r\n${wrapBase64(base64Utf8(message.body))}\r\n`;
}

export class RelayValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelayValidationError';
    this.statusCode = 400;
  }
}

function normalizeRecipients(value, fieldName, required) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RelayValidationError(`${fieldName} is required.`);
    return [];
  }

  const rawValues = Array.isArray(value) ? value : [value];
  const recipients = rawValues.flatMap((entry) => {
    if (typeof entry !== 'string') {
      throw new RelayValidationError(`${fieldName} must be an email address or an array of email addresses.`);
    }
    return entry.split(',');
  }).map((entry) => normalizeMailbox(entry, fieldName));

  return [...new Set(recipients)];
}

function sanitizeDisplayName(value) {
  const name = String(value || '').trim();
  if (!name || containsHeaderBreak(name)) return 'NICDAI';
  return name.slice(0, 120);
}

function sanitizeMessageId(value) {
  const requestId = String(value || '').trim();
  return /^[A-Za-z0-9._-]{8,128}$/.test(requestId)
    ? requestId
    : 'invalid-request-id';
}

function encodeHeader(value) {
  const header = String(value);
  return /^[\x20-\x7E]+$/.test(header)
    ? header
    : `=?UTF-8?B?${base64Utf8(header)}?=`;
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function wrapBase64(value) {
  return value.match(/.{1,76}/g)?.join('\r\n') || '';
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function containsHeaderBreak(value) {
  return /[\r\n]/.test(value);
}
