import { RelayValidationError } from './message.js';

export const ATTACHMENT_EXPIRATION_TTL_SECONDS = 24 * 60 * 60;
export const ATTACHMENT_QUEUE_DELAY_SECONDS = 60;

export async function stageEmailAttachments(message, requestId, env) {
  const attachments = message.attachments || [];
  if (!attachments.length) return { message, stagedKeys: [] };
  const storage = attachmentStorage(env);

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
      await storage.put(storageKey, bytes, {
        expirationTtl: ATTACHMENT_EXPIRATION_TTL_SECONDS,
        metadata: {
          filename: attachment.filename,
          contentType: attachment.contentType,
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

export async function hydrateEmailAttachments(message, env) {
  const attachments = message.attachments || [];
  if (!attachments.length) return message;
  const storage = attachmentStorage(env);

  const hydratedAttachments = [];
  for (const attachment of attachments) {
    const stored = await storage.get(attachment.storageKey, 'arrayBuffer');
    if (!stored) throw new Error('A staged email attachment is missing.');
    const bytes = new Uint8Array(stored);
    if (bytes.byteLength !== attachment.size) {
      throw new Error('A staged email attachment failed its size integrity check.');
    }
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

export async function deleteStagedAttachments(keys, env, reason, logger = console) {
  if (!keys.length || !env.ATTACHMENT_KV) return;
  const uniqueKeys = [...new Set(keys)];
  const results = await Promise.allSettled(
    uniqueKeys.map((storageKey) => env.ATTACHMENT_KV.delete(storageKey))
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    logger.error(JSON.stringify({
      event: 'email_attachment_cleanup_failed',
      reason,
      attachmentCount: uniqueKeys.length,
      failureCount: failures.length,
      errors: failures.map((result) => safeErrorMessage(result.reason))
    }));
  }
}

function attachmentStorage(env) {
  if (!env.ATTACHMENT_KV) {
    throw new Error('ATTACHMENT_KV is not configured.');
  }
  return env.ATTACHMENT_KV;
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

function safeErrorMessage(error) {
  return String(error?.message || error || 'Unknown KV cleanup error').slice(0, 300);
}
