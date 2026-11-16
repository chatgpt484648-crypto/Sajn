import crypto from 'node:crypto';

function getEncryptionKey(): Buffer {
  const secret =
    process.env.MIRROR_SECRET ||
    process.env.GEMINI_API_KEY ||
    'virtual-numbers-mirror-default-secret-v1';
  return crypto.createHash('sha256').update(secret).digest();
}

export function sealJson(payload: unknown): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'b2',
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('_');
}

export function unsealJson<T>(token: string): T | null {
  try {
    if (!token || !token.startsWith('b2_')) return null;
    const parts = token.split('_');
    if (parts.length !== 4) return null;
    const [, ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const data = Buffer.from(dataB64, 'base64url');
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function parseCookieHeader(
  cookieHeader: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        result[k] = decodeURIComponent(v);
      } catch {
        result[k] = v;
      }
    }
  }
  return result;
}
