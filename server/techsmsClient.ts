import fs from 'node:fs';
import path from 'node:path';
import type { ActiveNumberRecord } from '../src/types/mirror.ts';
import {
  mergeDirectTechSmsSync,
  setTechSmsSyncStatus,
} from './stateStore.ts';

const SUPABASE_URL = 'https://zxonrfrzpdwkhxvwojbb.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp4b25yZnJ6cGR3a2h4dndvamJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MDA3NDYsImV4cCI6MjEwMzk3Njc0Nn0.yvHEwDgtfhxIPWn6Fs9eLMXACm4gVnmvkheWFaMj56M';
const TECHSMS_API_BASE = 'https://api.techsms.org';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SESSION_FILE = path.join(DATA_DIR, 'techsms-session.json');

interface TechSmsSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  email: string;
  accountName: string;
}

let currentSession: TechSmsSession | null = loadSessionFromDisk();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastNumbersFetchAt = 0;
let syncInFlight = false;

function loadSessionFromDisk(): TechSmsSession | null {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
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
    }
  } catch (err) {
    console.error('Failed to load techsms-session.json:', err);
  }
  return null;
}

function saveSessionToDisk(session: TechSmsSession | null): void {
  try {
    if (!session) {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      return;
    }
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save techsms-session.json:', err);
  }
}

function formatPhoneWithPlus(raw: string | undefined | null): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s.startsWith('+') ? s : `+${s}`;
}

async function refreshSessionIfNeeded(): Promise<string> {
  if (!currentSession) {
    throw new Error('No TechSMS account connected.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (currentSession.expiresAt > nowSec + 120) {
    return currentSession.accessToken;
  }

  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: currentSession.refreshToken }),
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
      data.error_description || data.msg || 'TechSMS session expired. Please reconnect.';
    currentSession = null;
    saveSessionToDisk(null);
    stopBackgroundPoller();
    setTechSmsSyncStatus({
      connected: false,
      email: null,
      lastError: errMsg,
    });
    throw new Error(errMsg);
  }

  currentSession = {
    ...currentSession,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || currentSession.refreshToken,
    expiresAt:
      data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
  saveSessionToDisk(currentSession);
  return currentSession.accessToken;
}

async function fetchTechSmsJson<T>(apiPath: string): Promise<T> {
  const token = await refreshSessionIfNeeded();
  const res = await fetch(`${TECHSMS_API_BASE}${apiPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (res.status === 401) {
    // Force refresh once
    if (currentSession) currentSession.expiresAt = 0;
    const freshToken = await refreshSessionIfNeeded();
    const retry = await fetch(`${TECHSMS_API_BASE}${apiPath}`, {
      headers: {
        Authorization: `Bearer ${freshToken}`,
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

  currentSession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt:
      data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    email: data.user?.email || email.trim(),
    accountName: metaName.trim() || email.trim(),
  };

  // Try /api/auth/me for authoritative display name
  try {
    const me = await fetchTechSmsJson<{
      success?: boolean;
      data?: { name?: string; full_name?: string; email?: string };
      name?: string;
      full_name?: string;
    }>('/api/auth/me');
    const resolvedName =
      me.data?.name || me.data?.full_name || me.name || me.full_name;
    if (resolvedName && resolvedName.trim()) {
      currentSession.accountName = resolvedName.trim();
    }
  } catch {
    // Keep metadata name if /api/auth/me shape differs
  }

  saveSessionToDisk(currentSession);
  setTechSmsSyncStatus({
    connected: true,
    email: currentSession.email,
    lastError: null,
  });

  lastNumbersFetchAt = 0;
  await syncTechSmsNow(true);
  startBackgroundPoller();

  return {
    accountName: currentSession.accountName,
    email: currentSession.email,
  };
}

export async function syncTechSmsNow(includeNumbers = true): Promise<void> {
  if (!currentSession || syncInFlight) return;
  syncInFlight = true;

  try {
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
        const numRes = await fetchTechSmsJson<{
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
        }>(`/api/numbers/my-numbers?page=${page}&per_page=100`);

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

    const cdrRes = await fetchTechSmsJson<{
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
    }>('/api/cdr?page=1&per_page=100&sync=true');

    const mappedMessages = (cdrRes.data?.records || []).map((rec) => ({
      time: rec.timestamp || '',
      destination: formatPhoneWithPlus(rec.destination),
      senderId: rec.sender_id || 'UNKNOWN',
      message: rec.message || '',
    }));

    let todaysSms: number | null = null;
    try {
      const statsRes = await fetchTechSmsJson<{
        success?: boolean;
        data?: { active_numbers?: number; today_sms?: number };
      }>('/api/admin/dashboard-stats?refresh=true');
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

    mergeDirectTechSmsSync({
      accountName: currentSession.accountName,
      accountStatus: 'Operational · Auto-Synced',
      totalActiveNumbers: totalActiveCount,
      todaysSmsCount: todaysSms,
      activeNumbers,
      messages: mappedMessages,
    });

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
    syncInFlight = false;
  }
}

export function startBackgroundPoller(): void {
  if (!currentSession) return;
  setTechSmsSyncStatus({
    connected: true,
    email: currentSession.email,
    lastError: null,
  });

  if (pollTimer) return;
  // Immediate initial sync, then automatic polling every 4 seconds
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

export function disconnectTechSmsAccount(): void {
  stopBackgroundPoller();
  currentSession = null;
  saveSessionToDisk(null);
  setTechSmsSyncStatus({
    connected: false,
    email: null,
    lastSyncAt: null,
    lastError: null,
  });
}
