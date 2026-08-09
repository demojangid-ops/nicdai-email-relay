import { connect } from 'cloudflare:sockets';
import {
  RelayValidationError,
  buildMimeMessage,
  normalizeEmailRequest,
  normalizeQueuedEmail
} from './message.js';
import { smtpConfiguration } from './config.js';

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
});
const encoder = new TextEncoder();
const MAX_REQUEST_BYTES = 21_000_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        status: 'ok',
        service: 'nicdai-email-relay',
        queueConfigured: Boolean(env.EMAIL_QUEUE),
        attachmentStorageConfigured: Boolean(env.ATTACHMENT_BUCKET)
      });
    }
    if (request.method !== 'POST' || url.pathname !== '/send') {
      return json({ error: 'Not found.' }, 404);
    }

    if (!await isAuthorized(request, env.RELAY_API_KEY)) {
      return json({ error: 'Unauthorized.' }, 401);
    }
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return json({ error: 'Content-Type must be application/json.' }, 415);
    }

    let stagedKeys = [];
    try {
      const declaredLength = Number(request.headers.get('content-length') || 0);
      if (declaredLength > MAX_REQUEST_BYTES) {
        return json({ error: 'Request body is too large.' }, 413);
      }
      const rawBody = await request.text();
      if (encoder.encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
        return json({ error: 'Request body is too large.' }, 413);
      }
      const message = normalizeEmailRequest(JSON.parse(rawBody));
      const requestId = crypto.randomUUID();
      const staged = await stageEmailAttachments(message, requestId, env);
      stagedKeys = staged.stagedKeys;
      await env.EMAIL_QUEUE.send({ ...staged.message, requestId, queuedAt: new Date().toISOString() });
      console.log(JSON.stringify({
        event: 'email_queued',
        requestId,
        recipientCount: message.to.length + message.cc.length,
        attachmentCount: stagedKeys.length
      }));
      return json({ status: 'queued', requestId }, 202);
    } catch (error) {
      if (stagedKeys.length) await deleteStagedAttachments(stagedKeys, env, 'queue_failed');
      if (error instanceof RelayValidationError || error instanceof SyntaxError) {
        return json({ error: error.message || 'The JSON request body is invalid.' }, 400);
      }
      console.error(JSON.stringify({ event: 'email_queue_failed', error: safeError(error) }));
      return json({ error: 'The email could not be queued.' }, 503);
    }
  },

  async queue(batch, env) {
    for (const queuedMessage of batch.messages) {
      const requestId = queuedMessage.body?.requestId || queuedMessage.id;
      try {
        const message = normalizeQueuedEmail(queuedMessage.body);
        const hydratedMessage = await hydrateEmailAttachments(message, env);
        await sendSmtpEmail(hydratedMessage, requestId, env);
        queuedMessage.ack();
        if (message.attachments?.length) {
          await deleteStagedAttachments(
            message.attachments.map((attachment) => attachment.storageKey),
            env,
            'sent'
          );
        }
        console.log(JSON.stringify({
          event: 'email_sent',
          requestId,
          attempt: queuedMessage.attempts,
          recipientCount: message.to.length + message.cc.length,
          attachmentCount: message.attachments?.length || 0
        }));
      } catch (error) {
        const attempt = Math.max(1, Number(queuedMessage.attempts) || 1);
        const delaySeconds = Math.min(900, 30 * (2 ** (attempt - 1)));
        console.error(JSON.stringify({
          event: 'email_delivery_failed',
          requestId,
          attempt,
          retryInSeconds: delaySeconds,
          error: safeError(error)
        }));
        queuedMessage.retry({ delaySeconds });
      }
    }
  }
};

async function stageEmailAttachments(message, requestId, env) {
  const attachments = message.attachments || [];
  if (!attachments.length) return { message, stagedKeys: [] };
  if (!env.ATTACHMENT_BUCKET) {
    throw new Error('ATTACHMENT_BUCKET is not configured.');
  }

  const stagedAttachments = [];
  const stagedKeys = [];
  try {
    for (const [index, attachment] of attachments.entries()) {
      const bytes = base64ToBytes(attachment.contentBase64);
      if (!isPdf(bytes)) {
        throw new RelayValidationError(`attachments[${index}] is not a valid PDF payload.`);
      }
      const actualSha256 = await sha256Hex(bytes);
      if (actualSha256 !== attachment.sha256) {
        throw new RelayValidationError(`attachments[${index}] failed its SHA-256 integrity check.`);
      }
      const storageKey = `relay/${requestId}/${index}.pdf`;
      await env.ATTACHMENT_BUCKET.put(storageKey, bytes, {
        httpMetadata: {
          contentType: attachment.contentType,
          contentDisposition: `attachment; filename="${attachment.filename}"`,
          cacheControl: 'private, no-store'
        },
        customMetadata: {
          filename: attachment.filename,
          sha256: attachment.sha256,
          size: String(attachment.size)
        }
      });
      stagedKeys.push(storageKey);
      stagedAttachments.push({
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        sha256: attachment.sha256,
        storageKey
      });
    }
  } catch (error) {
    await deleteStagedAttachments(stagedKeys, env, 'staging_failed');
    throw error;
  }

  return {
    message: { ...message, attachments: stagedAttachments },
    stagedKeys
  };
}

async function hydrateEmailAttachments(message, env) {
  const attachments = message.attachments || [];
  if (!attachments.length) return message;
  if (!env.ATTACHMENT_BUCKET) {
    throw new Error('ATTACHMENT_BUCKET is not configured.');
  }

  const hydratedAttachments = [];
  for (const attachment of attachments) {
    const object = await env.ATTACHMENT_BUCKET.get(attachment.storageKey);
    if (!object) throw new Error('A staged email attachment is missing.');
    if (object.size !== attachment.size) {
      throw new Error('A staged email attachment failed its size integrity check.');
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (!isPdf(bytes) || await sha256Hex(bytes) !== attachment.sha256) {
      throw new Error('A staged email attachment failed its content integrity check.');
    }
    hydratedAttachments.push({
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      sha256: attachment.sha256,
      contentBase64: bytesToBase64(bytes)
    });
  }
  return { ...message, attachments: hydratedAttachments };
}

async function deleteStagedAttachments(keys, env, reason) {
  if (!keys.length || !env.ATTACHMENT_BUCKET) return;
  try {
    await env.ATTACHMENT_BUCKET.delete(keys);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'email_attachment_cleanup_failed',
      reason,
      attachmentCount: keys.length,
      error: safeError(error)
    }));
  }
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isPdf(bytes) {
  return bytes.length >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

async function sendSmtpEmail(message, requestId, env) {
  const config = smtpConfiguration(env);
  let socket;
  let session;
  let timer;
  try {
    const delivery = (async () => {
      socket = connect(
        { hostname: config.host, port: config.port },
        { secureTransport: config.secure ? 'on' : 'starttls' }
      );
      await socket.opened;
      session = new SmtpSession(socket);
      await session.expect([220]);
      await session.command(`EHLO ${config.ehloName}`, [250]);

      if (!config.secure) {
        await session.command('STARTTLS', [220]);
        socket = await session.startTls();
        session = new SmtpSession(socket);
        await session.command(`EHLO ${config.ehloName}`, [250]);
      }

      await session.command('AUTH LOGIN', [334]);
      await session.command(base64Ascii(config.username), [334]);
      await session.command(base64Ascii(config.password), [235]);
      await session.command(`MAIL FROM:<${config.fromEmail}>`, [250]);
      for (const recipient of [...message.to, ...message.cc]) {
        await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
      }
      await session.command('DATA', [354]);
      const mime = buildMimeMessage(message, {
        fromEmail: config.fromEmail,
        fromName: config.fromName,
        requestId
      });
      await session.writeRaw(`${mime}.\r\n`);
      await session.expect([250]);
      await session.command('QUIT', [221]);
    })();

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { socket?.close(); } catch {}
        reject(new Error(`SMTP delivery timed out after ${config.timeoutMs} ms.`));
      }, config.timeoutMs);
    });
    await Promise.race([delivery, timeout]);
  } finally {
    clearTimeout(timer);
    try { await session?.close(); } catch {}
    if (!session) {
      try { await socket?.close(); } catch {}
    }
  }
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.decoder = new TextDecoder();
    this.buffer = '';
  }

  async command(command, allowedCodes) {
    if (/[\r\n]/.test(command)) throw new Error('Unsafe SMTP command.');
    await this.writeRaw(`${command}\r\n`);
    return this.expect(allowedCodes);
  }

  async expect(allowedCodes) {
    const response = await this.readResponse();
    if (!allowedCodes.includes(response.code)) {
      const error = new Error(`SMTP command failed with status ${response.code}: ${response.lines.join(' | ')}`);
      error.smtpCode = response.code;
      throw error;
    }
    return response;
  }

  async readResponse() {
    const lines = [];
    let responseCode = null;
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex < 0) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error('SMTP server closed the connection unexpectedly.');
        this.buffer += this.decoder.decode(value, { stream: true });
        if (this.buffer.length > 64_000) throw new Error('SMTP response exceeded the safety limit.');
        continue;
      }

      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) continue;
      const code = Number(match[1]);
      if (responseCode === null) responseCode = code;
      lines.push(line);
      if (match[2] === ' ' && code === responseCode) return { code, lines };
    }
  }

  async writeRaw(value) {
    await this.writer.write(encoder.encode(value));
  }

  async startTls() {
    this.reader.releaseLock();
    this.writer.releaseLock();
    const secureSocket = this.socket.startTls();
    await secureSocket.opened;
    return secureSocket;
  }

  async close() {
    try { this.reader.releaseLock(); } catch {}
    try { this.writer.releaseLock(); } catch {}
    await this.socket.close();
  }
}

async function isAuthorized(request, expectedSecret) {
  const expected = typeof expectedSecret === 'string' ? expectedSecret : '';
  const authorization = request.headers.get('authorization') || '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (expected.length < 32 || !supplied) return false;
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(supplied))
  ]);
  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(suppliedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

function base64Ascii(value) {
  const input = String(value);
  if (/[^\x00-\x7F]/.test(input)) {
    const bytes = encoder.encode(input);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return btoa(input);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function safeError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    message: String(error?.message || 'Unknown error')
      .replace(/(password\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
      .slice(0, 500),
    smtpCode: Number.isFinite(Number(error?.smtpCode)) ? Number(error.smtpCode) : null
  };
}
