import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IS_VERCEL = Boolean(process.env.VERCEL || process.env.NOW_REGION);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DATA_DIR = path.resolve(process.cwd(), 'data');
const ALT_BUNDLED_DATA_DIR = path.resolve(MODULE_DIR, '..', 'data');
const WRITABLE_DATA_DIR = IS_VERCEL
  ? path.join('/tmp', 'mirror-data')
  : BUNDLED_DATA_DIR;

const WRITABLE_STATE_FILE = path.join(WRITABLE_DATA_DIR, 'mirror-state.json');
const WRITABLE_SESSION_FILE = path.join(WRITABLE_DATA_DIR, 'techsms-session.json');

const KV_URL = (
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  ''
).replace(/\/+$/, '');
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const HAS_REMOTE_KV = Boolean(KV_URL && KV_TOKEN);

const KV_STATE_KEY = 'techsms_mirror:state:v1';
const KV_SESSION_KEY = 'techsms_mirror:session:v1';

async function kvCommand<T = unknown>(args: string[]): Promise<T | null> {
  if (!HAS_REMOTE_KV) return null;
  try {
    const res = await fetch(KV_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: T; error?: string };
    if (data.error) return null;
    return data.result ?? null;
  } catch {
    return null;
  }
}

function ensureWritableDir(): void {
  if (!fs.existsSync(WRITABLE_DATA_DIR)) {
    fs.mkdirSync(WRITABLE_DATA_DIR, { recursive: true });
  }
}

export function readBundledSeedStateRaw(): string | null {
  const candidates = [
    path.join(BUNDLED_DATA_DIR, 'mirror-state.json'),
    path.join(ALT_BUNDLED_DATA_DIR, 'mirror-state.json'),
  ];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    } catch (err) {
      console.error('Failed to read bundled mirror-state.json:', err);
    }
  }
  return null;
}

export function readLocalStateRawSync(): string | null {
  try {
    if (fs.existsSync(WRITABLE_STATE_FILE)) {
      return fs.readFileSync(WRITABLE_STATE_FILE, 'utf-8');
    }
  } catch {
    // Fallback to bundled seed below
  }
  return readBundledSeedStateRaw();
}

export async function readStateRawAsync(): Promise<string | null> {
  if (HAS_REMOTE_KV) {
    const remote = await kvCommand<string>(['GET', KV_STATE_KEY]);
    if (typeof remote === 'string' && remote.trim()) {
      return remote;
    }
  }
  return readLocalStateRawSync();
}

export function writeLocalStateRawSync(raw: string): void {
  try {
    ensureWritableDir();
    fs.writeFileSync(WRITABLE_STATE_FILE, raw, 'utf-8');
  } catch (err) {
    console.error('Failed to write mirror-state.json:', err);
  }
}

export async function writeStateRawAsync(raw: string): Promise<void> {
  writeLocalStateRawSync(raw);
  if (HAS_REMOTE_KV) {
    await kvCommand(['SET', KV_STATE_KEY, raw]);
  }
}

export function readLocalSessionRawSync(): string | null {
  try {
    if (fs.existsSync(WRITABLE_SESSION_FILE)) {
      return fs.readFileSync(WRITABLE_SESSION_FILE, 'utf-8');
    }
  } catch {
    // Ignore missing session
  }
  return null;
}

export async function readSessionRawAsync(): Promise<string | null> {
  if (HAS_REMOTE_KV) {
    const remote = await kvCommand<string>(['GET', KV_SESSION_KEY]);
    if (typeof remote === 'string' && remote.trim()) {
      return remote;
    }
  }
  return readLocalSessionRawSync();
}

export function writeLocalSessionRawSync(raw: string | null): void {
  try {
    if (!raw) {
      if (fs.existsSync(WRITABLE_SESSION_FILE)) {
        fs.unlinkSync(WRITABLE_SESSION_FILE);
      }
      return;
    }
    ensureWritableDir();
    fs.writeFileSync(WRITABLE_SESSION_FILE, raw, 'utf-8');
  } catch (err) {
    console.error('Failed to persist techsms-session.json:', err);
  }
}

export async function writeSessionRawAsync(raw: string | null): Promise<void> {
  writeLocalSessionRawSync(raw);
  if (HAS_REMOTE_KV) {
    if (!raw) {
      await kvCommand(['DEL', KV_SESSION_KEY]);
    } else {
      await kvCommand(['SET', KV_SESSION_KEY, raw]);
    }
  }
}
