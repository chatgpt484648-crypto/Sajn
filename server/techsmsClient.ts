import { sealJson, unsealJson } from './cryptoVault.ts';
import {
  HAS_REMOTE_KV,
  IS_VERCEL,
  readLocalSessionRawSync,
  readSessionRawAsync,
  writeSessionRawAsync,
} from './storageAdapter.ts';
import {
  flushPersistence,
  mergeDirectTechSmsSync,
  setTechSmsSyncStatus,
  type SealedBuyerPayload,
} from './stateStore.ts';
import type { ActiveNumberRecord } from '../src/types/mirror.ts';

const SUPABASE_URL = 'https://zxonrfrzpdwkhxvwojbb.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp4b25yZnJ6cGR3a2h4dndvamJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MDA3NDYsImV4cCI6MjEwMzk3Njc0Nn0.yvHEwDgtfhxIPWn6Fs9eLMXACm4gVnmvkheWFaMj56M';
const TECHSMS_API_BASE = 'https://api.techsms.org';

export interface TechSmsSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  email: string;
  accountName: string;
}

function parseSessionRaw(raw: string | null): TechSmsSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TechSmsSession>;
    if (parsed.accessToken && parsed.refreshToken && parsed.email) {
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt || 0,
        email: parsed.email,
        accountName: parsed.accountName || parsed.email,
      };
    }
  } catch {
    // Ignore malformed session
  }
  return null;
}

let currentSession: TechSmsSession | null = parseSessionRaw(
  readLocalSessionRawSync(),
);
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastNumbersFetchAt = 0;
let lastSyncCompletedAt = 0;
let syncInFlight: Promise<void> | null = null;
let sessionCookieNeedsUpdate = false;

// Cache transient access tokens per email for cold Vercel buyer requests
const buyerSessionCache = new Map<string, TechSmsSession>();
const buyerLastSyncAt = new Map<string, number>();
const buyerSyncInFlight = new Map<string, Promise<void>>();

function persistSession(session: TechSmsSession | null): void {
  const raw = session ? JSON.stringify(session, null, 2) : null;
  writeSessionRawAsync(raw).catch((err) => {
    console.error('Failed to persist session:', err);
  });
}

export function consumeUpdatedSessionCookieValue(): string | null {
  if (!sessionCookieNeedsUpdate || !currentSession) return null;
  sessionCookieNeedsUpdate = false;
  return sealJson(currentSession);
}

export function getActiveSessionMeta(): {
  email: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  accountName: string;
} | null {
  if (!currentSession) return null;
  return {
    email: currentSession.email,
    refreshToken: currentSession.refreshToken,
    accessToken: currentSession.accessToken,
    expiresAt: currentSession.expiresAt,
    accountName: currentSession.accountName,
  };
}

export function getSealedSessionCookieValue(): string | null {
  if (!currentSession) return null;
  return sealJson(currentSession);
}

export async function restoreSessionIfNeeded(
  sealedCookieValue?: string,
): Promise<boolean> {
  if (currentSession) return true;

  if (HAS_REMOTE_KV) {
    const remoteRaw = await readSessionRawAsync();
    const parsed = parseSessionRaw(remoteRaw);
    if (parsed) {
      currentSession = parsed;
      setTechSmsSyncStatus({
        connected: true,
        email: parsed.email,
        lastError: null,
      });
      return true;
    }
  }

  if (sealedCookieValue) {
    const fromCookie = unsealJson<TechSmsSession>(sealedCookieValue);
    if (fromCookie?.accessToken && fromCookie?.refreshToken && fromCookie?.email) {
      currentSession = fromCookie;
      setTechSmsSyncStatus({
        connected: true,
        email: fromCookie.email,
        lastError: null,
      });
      return true;
    }
  }

  return false;
}

function formatPhoneWithPlus(raw: string | undefined | null): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s.startsWith('+') ? s : `+${s}`;
}

async function refreshTechSmsSessionToken(
  session: TechSmsSession,
  isPrimarySession: boolean,
): Promise<TechSmsSession> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (session.accessToken && session.expiresAt > nowSec + 120) {
    return session;
  }

  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    },
  );

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires_at?: number;
    error_description?: string;
    msg?: string;
  };

  if (!res.ok || !data.access_token) {
    const errMsg =
      data.error_description ||
      data.msg ||
      'TechSMS session expired. Please reconnect.';
    if (isPrimarySession) {
      currentSession = null;
      persistSession(null);
      stopBackgroundPoller();
      setTechSmsSyncStatus({
        connected: false,
        email: null,
        lastError: errMsg,
      });
    }
    throw new Error(errMsg);
  }

  const refreshed: TechSmsSession = {
    ...session,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt:
      data.expires_at ||
      Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };

  if (isPrimarySession) {
    currentSession = refreshed;
    sessionCookieNeedsUpdate = true;
    persistSession(refreshed);
  }

  return refreshed;
}

async function fetchTechSmsJsonWithSession<T>(
  apiPath: string,
  sessionRef: { current: TechSmsSession },
  isPrimarySession: boolean,
): Promise<T> {
  sessionRef.current = await refreshTechSmsSessionToken(
    sessionRef.current,
    isPrimarySession,
  );

  const res = await fetch(`${TECHSMS_API_BASE}${apiPath}`, {
    headers: {
      Authorization: `Bearer ${sessionRef.current.accessToken}`,
      Accept: 'application/json',
    },
  });

  if (res.status === 401) {
    sessionRef.current = { ...sessionRef.current, expiresAt: 0 };
    sessionRef.current = await refreshTechSmsSessionToken(
      sessionRef.current,
      isPrimarySession,
    );
    const retry = await fetch(`${TECHSMS_API_BASE}${apiPath}`, {
      headers: {
        Authorization: `Bearer ${sessionRef.current.accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!retry.ok) {
      throw new Error(`TechSMS API returned HTTP ${retry.status}`);
    }
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    throw new Error(`TechSMS API returned HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function loginTechSmsAccount(
  email: string,
  password: string,
): Promise<{ accountName: string; email: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: email.trim(), password }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires_at?: number;
    user?: {
      email?: string;
      user_metadata?: { name?: string; full_name?: string };
    };
    error_description?: string;
    msg?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.msg || 'Invalid TechSMS email or password.',
    );
  }

  const metaName =
    data.user?.user_metadata?.name ||
    data.user?.user_metadata?.full_name ||
    '';

  let session: TechSmsSession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt:
      data.expires_at ||
      Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    email: data.user?.email || email.trim(),
    accountName: metaName.trim() || email.trim(),
  };

  try {
    const sessionRef = { current: session };
    const me = await fetchTechSmsJsonWithSession<{
      success?: boolean;
      data?: { name?: string; full_name?: string; email?: string };
      name?: string;
      full_name?: string;
    }>('/api/auth/me', sessionRef, false);
    session = sessionRef.current;
    const resolvedName =
      me.data?.name || me.data?.full_name || me.name || me.full_name;
    if (resolvedName && resolvedName.trim()) {
      session.accountName = resolvedName.trim();
    }
  } catch {
    // Keep metadata name if /api/auth/me differs
  }

  currentSession = session;
  await writeSessionRawAsync(JSON.stringify(session, null, 2));

  setTechSmsSyncStatus({
    connected: true,
    email: session.email,
    lastError: null,
  });

  lastNumbersFetchAt = 0;
  await syncTechSmsNow(true);
  await flushPersistence();
  startBackgroundPoller();

  return {
    accountName: currentSession.accountName,
    email: currentSession.email,
  };
}

export async function syncTechSmsNow(includeNumbers = true): Promise<void> {
  if (!currentSession) return;
  if (syncInFlight) return syncInFlight;

  const task = (async () => {
    try {
      if (!currentSession) return;
      const sessionRef = { current: currentSession };
      const shouldFetchNumbers =
        includeNumbers || Date.now() - lastNumbersFetchAt > 18000;

      let activeNumbers: ActiveNumberRecord[] | undefined;
      let totalActiveCount: number | null = null;

      if (shouldFetchNumbers) {
        const collected: ActiveNumberRecord[] = [];
        let page = 1;
        let totalPages = 1;
        const nowIso = new Date().toISOString();

        do {
          const numRes = await fetchTechSmsJsonWithSession<{
            success?: boolean;
            data?: {
              numbers?: Array<{
                number?: string;
                range_name?: string;
                term?: string;
                allocated_at?: string;
                expires_at?: string;
              }>;
              total_count?: number;
              total_pages?: number;
            };
          }>(
            `/api/numbers/my-numbers?page=${page}&per_page=100`,
            sessionRef,
            true,
          );

          if (numRes.success && numRes.data) {
            totalActiveCount =
              typeof numRes.data.total_count === 'number'
                ? numRes.data.total_count
                : totalActiveCount;
            totalPages = numRes.data.total_pages || 1;
            for (const row of numRes.data.numbers || []) {
              const formatted = formatPhoneWithPlus(row.number);
              if (!formatted) continue;
              collected.push({
                number: formatted,
                country: row.range_name?.includes('United Kingdom')
                  ? 'United Kingdom'
                  : undefined,
                service: row.range_name || 'TechSMS Exclusive',
                range: row.range_name || 'Standard',
                term: row.term || '',
                allocatedAt: row.allocated_at ? row.allocated_at.split('T')[0] : '',
                expiresAt: row.expires_at
                  ? row.expires_at.replace('T', ' ').substring(0, 16)
                  : '',
                status: 'Active',
                lastSeenAt: nowIso,
              });
            }
          }
          page += 1;
        } while (page <= totalPages && page <= 10);

        activeNumbers = collected;
        if (totalActiveCount === null) {
          totalActiveCount = collected.length;
        }
        lastNumbersFetchAt = Date.now();
      }

      const cdrRes = await fetchTechSmsJsonWithSession<{
        success?: boolean;
        data?: {
          records?: Array<{
            timestamp?: string;
            destination?: string;
            sender_id?: string;
            message?: string;
          }>;
          total_count?: number;
        };
      }>('/api/cdr?page=1&per_page=100&sync=true', sessionRef, true);

      const mappedMessages = (cdrRes.data?.records || []).map((rec) => ({
        time: rec.timestamp || '',
        destination: formatPhoneWithPlus(rec.destination),
        senderId: rec.sender_id || 'UNKNOWN',
        message: rec.message || '',
      }));

      let todaysSms: number | null = null;
      try {
        const statsRes = await fetchTechSmsJsonWithSession<{
          success?: boolean;
          data?: { active_numbers?: number; today_sms?: number };
        }>('/api/admin/dashboard-stats?refresh=true', sessionRef, true);
        if (statsRes.success && statsRes.data) {
          if (
            typeof statsRes.data.active_numbers === 'number' &&
            totalActiveCount === null
          ) {
            totalActiveCount = statsRes.data.active_numbers;
          }
          if (typeof statsRes.data.today_sms === 'number') {
            todaysSms = statsRes.data.today_sms;
          }
        }
      } catch {
        // Optional endpoint for non-admin accounts
      }

      currentSession = sessionRef.current;

      mergeDirectTechSmsSync({
        accountName: currentSession.accountName,
        accountStatus: 'Operational · Auto-Synced',
        totalActiveNumbers: totalActiveCount,
        todaysSmsCount: todaysSms,
        activeNumbers,
        messages: mappedMessages,
      });

      await flushPersistence();
      lastSyncCompletedAt = Date.now();

      setTechSmsSyncStatus({
        connected: true,
        email: currentSession.email,
        lastSyncAt: new Date().toISOString(),
        lastError: null,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Auto-sync failed.';
      setTechSmsSyncStatus({
        connected: Boolean(currentSession),
        email: currentSession?.email ?? null,
        lastError: errMsg,
      });
    } finally {
      syncInFlight = null;
    }
  })();

  syncInFlight = task;
  return task;
}

export async function ensureFreshSync(minAgeMs = 3000): Promise<void> {
  if (!currentSession) return;
  if (Date.now() - lastSyncCompletedAt < minAgeMs) return;
  await syncTechSmsNow(Date.now() - lastNumbersFetchAt > 18000);
}

export async function ensureFreshSyncForBuyer(
  unsealed: SealedBuyerPayload,
  minAgeMs = 3000,
): Promise<void> {
  // Prefer existing global session if it matches the same account
  if (
    currentSession &&
    (!unsealed.email || currentSession.email === unsealed.email)
  ) {
    await ensureFreshSync(minAgeMs);
    return;
  }

  if (!unsealed.refreshToken || !unsealed.email) {
    return;
  }

  const cacheKey = unsealed.email;
  const lastAt = buyerLastSyncAt.get(cacheKey) ?? 0;
  if (Date.now() - lastAt < minAgeMs) {
    return;
  }

  const existingFlight = buyerSyncInFlight.get(cacheKey);
  if (existingFlight) {
    return existingFlight;
  }

  const task = (async () => {
    try {
      const cached = buyerSessionCache.get(cacheKey);
      const sessionRef: { current: TechSmsSession } = {
        current: cached ?? {
          accessToken: unsealed.accessToken || '',
          refreshToken: unsealed.refreshToken!,
          expiresAt: unsealed.expiresAt || 0,
          email: unsealed.email!,
          accountName: unsealed.accountName || 'TechSMS User',
        },
      };

      const cdrRes = await fetchTechSmsJsonWithSession<{
        success?: boolean;
        data?: {
          records?: Array<{
            timestamp?: string;
            destination?: string;
            sender_id?: string;
            message?: string;
          }>;
        };
      }>('/api/cdr?page=1&per_page=100&sync=true', sessionRef, false);

      buyerSessionCache.set(cacheKey, sessionRef.current);

      const mappedMessages = (cdrRes.data?.records || []).map((rec) => ({
        time: rec.timestamp || '',
        destination: formatPhoneWithPlus(rec.destination),
        senderId: rec.sender_id || 'UNKNOWN',
        message: rec.message || '',
      }));

      mergeDirectTechSmsSync({
        accountName: unsealed.accountName || sessionRef.current.accountName,
        accountStatus: 'Operational · Auto-Synced',
        totalActiveNumbers: null,
        todaysSmsCount: null,
        messages: mappedMessages,
      });

      await flushPersistence();
      buyerLastSyncAt.set(cacheKey, Date.now());
    } catch (err) {
      console.error('Buyer serverless sync error:', err);
    } finally {
      buyerSyncInFlight.delete(cacheKey);
    }
  })();

  buyerSyncInFlight.set(cacheKey, task);
  return task;
}

export function startBackgroundPoller(): void {
  if (!currentSession) return;
  setTechSmsSyncStatus({
    connected: true,
    email: currentSession.email,
    lastError: null,
  });

  if (IS_VERCEL) return;
  if (pollTimer) return;
  syncTechSmsNow(true).catch(() => {});
  pollTimer = setInterval(() => {
    syncTechSmsNow(false).catch(() => {});
  }, 4000);
}

export function stopBackgroundPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export async function disconnectTechSmsAccount(): Promise<void> {
  stopBackgroundPoller();
  currentSession = null;
  lastSyncCompletedAt = 0;
  await writeSessionRawAsync(null);
  setTechSmsSyncStatus({
    connected: false,
    email: null,
    lastSyncAt: null,
    lastError: null,
  });
}
