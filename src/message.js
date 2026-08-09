const MAX_RECIPIENTS = 50;
const MAX_SUBJECT_BYTES = 500;
const MAX_BODY_BYTES = 80_000;
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 10_000_000;
const MAX_TOTAL_ATTACHMENT_BYTES = 15_000_000;
const EMAIL_PATTERN = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STORAGE_KEY_PATTERN = /^relay\/[0-9a-f-]{36}\/[0-2]\.pdf$/i;

export function normalizeEmailRequest(input) {
  const message = normalizeEmailCore(input);
  const attachments = normalizeInlineAttachments(input.attachments);
  return attachments.length ? { ...message, attachments } : message;
}

export function normalizeQueuedEmail(input) {
  const message = normalizeEmailCore(input);
  const attachments = normalizeStagedAttachments(input.attachments);
  return attachments.length ? { ...message, attachments } : message;
}

function normalizeEmailCore(input) {
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
  const bodyContentType = message.bodyType === 'html' ? 'text/html' : 'text/plain';
  const attachments = normalizeMimeAttachments(message.attachments);
  const boundary = `----=_NICDAI_${requestId}`;
  const headers = [
    `Date: ${new Date(options.date || Date.now()).toUTCString()}`,
    `Message-ID: <${requestId}@${fromEmail.split('@')[1]}>`,
    `From: ${encodeHeader(fromName)} <${fromEmail}>`,
    `To: ${message.to.join(', ')}`,
    ...(message.cc.length ? [`Cc: ${message.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    `X-NICDAI-Relay-ID: ${requestId}`,
    'MIME-Version: 1.0',
    ...(attachments.length
      ? [`Content-Type: multipart/mixed; boundary="${boundary}"`]
      : [
          `Content-Type: ${bodyContentType}; charset=UTF-8`,
          'Content-Transfer-Encoding: base64'
        ])
  ];

  if (!attachments.length) {
    return `${headers.join('\r\n')}\r\n\r\n${wrapBase64(base64Utf8(message.body))}\r\n`;
  }

  const parts = [
    `--${boundary}`,
    `Content-Type: ${bodyContentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64Utf8(message.body))
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      `X-Attachment-SHA256: ${attachment.sha256}`,
      '',
      wrapBase64(attachment.contentBase64)
    );
  }
  parts.push(`--${boundary}--`, '');
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
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

function normalizeInlineAttachments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RelayValidationError('attachments must be an array.');
  }
  if (value.length > MAX_ATTACHMENTS) {
    throw new RelayValidationError(`A message can have at most ${MAX_ATTACHMENTS} attachments.`);
  }

  let totalBytes = 0;
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      throw new RelayValidationError(`attachments[${index}] must be an object.`);
    }
    const metadata = normalizeAttachmentMetadata(attachment, index);
    const contentBase64 = normalizeBase64(attachment.contentBase64, index);
    const decodedBytes = decodedBase64Length(contentBase64);
    if (decodedBytes !== metadata.size) {
      throw new RelayValidationError(`attachments[${index}] size does not match its encoded content.`);
    }
    if (decodedBytes > MAX_ATTACHMENT_BYTES) {
      throw new RelayValidationError(`attachments[${index}] exceeds ${MAX_ATTACHMENT_BYTES} bytes.`);
    }
    totalBytes += decodedBytes;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new RelayValidationError(`attachments cannot exceed ${MAX_TOTAL_ATTACHMENT_BYTES} bytes in total.`);
    }
    return { ...metadata, contentBase64 };
  });
}

function normalizeStagedAttachments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RelayValidationError('attachments must be an array.');
  }
  if (value.length > MAX_ATTACHMENTS) {
    throw new RelayValidationError(`A message can have at most ${MAX_ATTACHMENTS} attachments.`);
  }

  let totalBytes = 0;
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      throw new RelayValidationError(`attachments[${index}] must be an object.`);
    }
    const metadata = normalizeAttachmentMetadata(attachment, index);
    const storageKey = typeof attachment.storageKey === 'string'
      ? attachment.storageKey.trim()
      : '';
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new RelayValidationError(`attachments[${index}] has an invalid storage key.`);
    }
    totalBytes += metadata.size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new RelayValidationError(`attachments cannot exceed ${MAX_TOTAL_ATTACHMENT_BYTES} bytes in total.`);
    }
    return { ...metadata, storageKey };
  });
}

function normalizeAttachmentMetadata(attachment, index) {
  const filename = typeof attachment.filename === 'string' ? attachment.filename.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.pdf$/i.test(filename)) {
    throw new RelayValidationError(`attachments[${index}] filename must be a safe PDF filename.`);
  }
  const contentType = typeof attachment.contentType === 'string'
    ? attachment.contentType.trim().toLowerCase()
    : '';
  if (contentType !== 'application/pdf') {
    throw new RelayValidationError(`attachments[${index}] must use application/pdf.`);
  }
  const size = Number(attachment.size);
  if (!Number.isInteger(size) || size < 5 || size > MAX_ATTACHMENT_BYTES) {
    throw new RelayValidationError(`attachments[${index}] has an invalid size.`);
  }
  const sha256 = typeof attachment.sha256 === 'string'
    ? attachment.sha256.trim().toLowerCase()
    : '';
  if (!SHA256_PATTERN.test(sha256)) {
    throw new RelayValidationError(`attachments[${index}] must include a valid SHA-256 digest.`);
  }
  return { filename, contentType, size, sha256 };
}

function normalizeMimeAttachments(value) {
  if (!Array.isArray(value) || !value.length) return [];
  return value.map((attachment, index) => {
    const metadata = normalizeAttachmentMetadata(attachment, index);
    const contentBase64 = normalizeBase64(attachment.contentBase64, index);
    if (decodedBase64Length(contentBase64) !== metadata.size) {
      throw new RelayValidationError(`attachments[${index}] size does not match its encoded content.`);
    }
    return { ...metadata, contentBase64 };
  });
}

function normalizeBase64(value, index) {
  const contentBase64 = typeof value === 'string' ? value : '';
  if (!contentBase64 || contentBase64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    throw new RelayValidationError(`attachments[${index}] content must be canonical base64.`);
  }
  return contentBase64;
}

function decodedBase64Length(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
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
