import crypto from 'node:crypto';
import type { Response } from 'express';
import { sealJson, unsealJson } from './cryptoVault.ts';
import {
  HAS_REMOTE_KV,
  readLocalStateRawSync,
  readStateRawAsync,
  writeStateRawAsync,
} from './storageAdapter.ts';
import type {
  AccountSummary,
  ActiveNumberRecord,
  BuyerLink,
  BuyerPortalPayload,
  MirrorState,
  OcrExtractionPayload,
  ScanLogEntry,
  SmsRecord,
  TechSmsSyncStatus,
} from '../src/types/mirror.ts';

export interface SealedBuyerPayload {
  v: 2;
  id: string;
  accountKey: string;
  accountName: string;
  phoneNumber: string;
  buyerLabel: string;
  onlyAfterCreated: boolean;
  createdAt: string;
  email?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
}

interface MultiAccountDiskStore {
  activeAccountKey: string;
  accounts: Record<string, MirrorState>;
  buyerLinks: BuyerLink[];
  revokedLinkIds?: string[];
}

function normalizeAccountKey(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'default-account';
}

function normalizePhone(num: string): string {
  return num.replace(/[\s()-]/g, '').trim();
}

function createEmptyAccountState(accountName = 'Ahmad Amir'): MirrorState {
  return {
    accountKey: normalizeAccountKey(accountName),
    accountName,
    accountStatus: 'Operational · Full Access',
    sourceUrl: 'https://techsms.org/dashboard',
    reportedActiveNumbersCount: null,
    reportedTodaysSmsCount: null,
    explicitActiveNumbers: [],
    messages: [],
    lastSyncedAt: null,
    totalScans: 0,
    scanHistory: [],
  };
}

function parseStoreJson(raw: string | null): MultiAccountDiskStore {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<MultiAccountDiskStore> &
        Partial<MirrorState>;

      if (parsed.accounts && typeof parsed.accounts === 'object') {
        const accounts: Record<string, MirrorState> = {};
        for (const [key, val] of Object.entries(parsed.accounts)) {
          if (val && typeof val === 'object') {
            accounts[key] = {
              ...createEmptyAccountState(val.accountName || key),
              ...val,
              accountKey: key,
              explicitActiveNumbers: Array.isArray(val.explicitActiveNumbers)
                ? val.explicitActiveNumbers
                : [],
              messages: Array.isArray(val.messages) ? val.messages : [],
              scanHistory: Array.isArray(val.scanHistory) ? val.scanHistory : [],
            };
          }
        }
        const activeKey =
          parsed.activeAccountKey && accounts[parsed.activeAccountKey]
            ? parsed.activeAccountKey
            : Object.keys(accounts)[0] || 'ahmad-amir';

        if (!accounts[activeKey]) {
          accounts[activeKey] = createEmptyAccountState('Ahmad Amir');
        }
        return {
          activeAccountKey: activeKey,
          accounts,
          buyerLinks: Array.isArray(parsed.buyerLinks) ? parsed.buyerLinks : [],
          revokedLinkIds: Array.isArray(parsed.revokedLinkIds)
            ? parsed.revokedLinkIds
            : [],
        };
      }

      if (parsed.accountName || Array.isArray(parsed.messages)) {
        const name = parsed.accountName || 'Ahmad Amir';
        const key = normalizeAccountKey(name);
        return {
          activeAccountKey: key,
          accounts: {
            [key]: {
              ...createEmptyAccountState(name),
              ...parsed,
              accountKey: key,
              explicitActiveNumbers: Array.isArray(parsed.explicitActiveNumbers)
                ? parsed.explicitActiveNumbers
                : [],
              messages: Array.isArray(parsed.messages) ? parsed.messages : [],
              scanHistory: Array.isArray(parsed.scanHistory)
                ? parsed.scanHistory
                : [],
            },
          },
          buyerLinks: [],
          revokedLinkIds: [],
        };
      }
    } catch (err) {
      console.error('Failed to parse mirror-state.json:', err);
    }
  }

  return {
    activeAccountKey: 'ahmad-amir',
    accounts: {
      'ahmad-amir': createEmptyAccountState('Ahmad Amir'),
    },
    buyerLinks: [],
    revokedLinkIds: [],
  };
}

let store: MultiAccountDiskStore = parseStoreJson(readLocalStateRawSync());
let hydratedFromRemote = false;
let pendingWrite: Promise<void> = Promise.resolve();

let syncStatus: TechSmsSyncStatus = {
  connected: false,
  email: null,
  lastSyncAt: null,
  lastError: null,
  pollingIntervalMs: 4000,
};

const sseClients = new Set<Response>();
const buyerSseClients = new Map<string, Set<Response>>();

export async function ensureStoreLoaded(): Promise<void> {
  if (!HAS_REMOTE_KV && hydratedFromRemote) return;
  if (HAS_REMOTE_KV) {
    const raw = await readStateRawAsync();
    if (raw) {
      store = parseStoreJson(raw);
    }
  }
  hydratedFromRemote = true;
}

function persistStore(nextStore: MultiAccountDiskStore): void {
  const serialized = JSON.stringify(nextStore, null, 2);
  pendingWrite = pendingWrite
    .then(() => writeStateRawAsync(serialized))
    .catch((err) => {
      console.error('Failed to persist mirror state:', err);
    });
}

export async function flushPersistence(): Promise<void> {
  await pendingWrite;
}

export function setTechSmsSyncStatus(next: Partial<TechSmsSyncStatus>): void {
  syncStatus = { ...syncStatus, ...next };
  broadcastState();
}

export function getTechSmsSyncStatus(): TechSmsSyncStatus {
  return syncStatus;
}

function buildKnownAccounts(): AccountSummary[] {
  return Object.entries(store.accounts).map(([key, acc]) => ({
    key,
    accountName: acc.accountName,
    messageCount: acc.messages.length,
    activeNumbersCount: acc.reportedActiveNumbersCount,
    lastSyncedAt: acc.lastSyncedAt,
  }));
}

export function getMirrorState(): MirrorState {
  const current =
    store.accounts[store.activeAccountKey] ?? createEmptyAccountState('Ahmad Amir');
  return {
    ...current,
    accountKey: store.activeAccountKey,
    knownAccounts: buildKnownAccounts(),
    buyerLinks: store.buyerLinks.filter(
      (link) => link.accountKey === store.activeAccountKey,
    ),
    techsmsSync: syncStatus,
  };
}

export function unsealBuyerToken(token: string): SealedBuyerPayload | null {
  const unsealed = unsealJson<SealedBuyerPayload>(token);
  if (!unsealed || unsealed.v !== 2 || !unsealed.phoneNumber) return null;
  if (store.revokedLinkIds?.includes(unsealed.id)) return null;
  return unsealed;
}

export function mergeBuyerLinksFromCookie(cookieLinks: BuyerLink[]): void {
  if (!Array.isArray(cookieLinks) || cookieLinks.length === 0) return;
  const revoked = new Set(store.revokedLinkIds ?? []);
  const byToken = new Map<string, BuyerLink>();
  for (const existing of store.buyerLinks) {
    byToken.set(existing.token, existing);
  }
  for (const link of cookieLinks) {
    if (!link?.token || !link?.phoneNumber) continue;
    const unsealed = unsealJson<SealedBuyerPayload>(link.token);
    if (unsealed && revoked.has(unsealed.id)) continue;
    if (!byToken.has(link.token)) {
      byToken.set(link.token, link);
    }
  }
  store.buyerLinks = Array.from(byToken.values());
}

export function getBuyerLinksForCookie(): BuyerLink[] {
  return store.buyerLinks
    .filter((link) => link.accountKey === store.activeAccountKey)
    .slice(0, 6);
}

export function getBuyerPortalData(token: string): BuyerPortalPayload {
  const unsealed = unsealJson<SealedBuyerPayload>(token);
  if (unsealed && store.revokedLinkIds?.includes(unsealed.id)) {
    return {
      valid: false,
      active: false,
      phoneNumber: '',
      buyerLabel: '',
      createdAt: '',
      messages: [],
    };
  }

  const storedLink = store.buyerLinks.find((item) => item.token === token);
  const resolvedLink:
    | {
        accountKey: string;
        phoneNumber: string;
        buyerLabel: string;
        onlyAfterCreated: boolean;
        active: boolean;
        createdAt: string;
      }
    | null = storedLink
    ? storedLink
    : unsealed && unsealed.v === 2 && unsealed.phoneNumber
      ? {
          accountKey: unsealed.accountKey,
          phoneNumber: unsealed.phoneNumber,
          buyerLabel: unsealed.buyerLabel || '',
          onlyAfterCreated: Boolean(unsealed.onlyAfterCreated),
          active: true,
          createdAt: unsealed.createdAt,
        }
      : null;

  if (!resolvedLink) {
    return {
      valid: false,
      active: false,
      phoneNumber: '',
      buyerLabel: '',
      createdAt: '',
      messages: [],
    };
  }

  if (!resolvedLink.active) {
    return {
      valid: true,
      active: false,
      phoneNumber: resolvedLink.phoneNumber,
      buyerLabel: resolvedLink.buyerLabel,
      createdAt: resolvedLink.createdAt,
      messages: [],
    };
  }

  const account = store.accounts[resolvedLink.accountKey];
  const targetNormalized = normalizePhone(resolvedLink.phoneNumber);

  const filteredMessages = (account?.messages ?? [])
    .filter((msg) => {
      if (normalizePhone(msg.destination) !== targetNormalized) return false;
      if (resolvedLink.onlyAfterCreated && msg.firstSeenAt < resolvedLink.createdAt) {
        return false;
      }
      return true;
    })
    .map((msg) => ({
      id: msg.id,
      time: msg.time,
      senderId: msg.senderId,
      otpCode: msg.otpCode,
      message: msg.message,
    }));

  return {
    valid: true,
    active: true,
    phoneNumber: resolvedLink.phoneNumber,
    buyerLabel: resolvedLink.buyerLabel,
    createdAt: resolvedLink.createdAt,
    messages: filteredMessages,
  };
}

export function addSseClient(res: Response): void {
  sseClients.add(res);
  res.write(`event: state\ndata: ${JSON.stringify(getMirrorState())}\n\n`);
}

export function removeSseClient(res: Response): void {
  sseClients.delete(res);
}

export function addBuyerSseClient(token: string, res: Response): void {
  let clients = buyerSseClients.get(token);
  if (!clients) {
    clients = new Set<Response>();
    buyerSseClients.set(token, clients);
  }
  clients.add(res);
  res.write(`event: buyer\ndata: ${JSON.stringify(getBuyerPortalData(token))}\n\n`);
}

export function removeBuyerSseClient(token: string, res: Response): void {
  const clients = buyerSseClients.get(token);
  if (!clients) return;
  clients.delete(res);
  if (clients.size === 0) {
    buyerSseClients.delete(token);
  }
}

function broadcastBuyerUpdates(): void {
  for (const [token, clients] of buyerSseClients.entries()) {
    const payload = `event: buyer\ndata: ${JSON.stringify(getBuyerPortalData(token))}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }
}

export function broadcastState(): void {
  const payload = `event: state\ndata: ${JSON.stringify(getMirrorState())}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
  broadcastBuyerUpdates();
}

export function createBuyerLink(
  phoneNumber: string,
  buyerLabel = '',
  onlyAfterCreated = false,
  sessionMeta?: {
    email?: string;
    refreshToken?: string;
    accessToken?: string;
    expiresAt?: number;
    accountName?: string;
  } | null,
): BuyerLink {
  const cleanNumber = phoneNumber.trim();
  const cleanLabel = buyerLabel.trim();
  const createdAt = new Date().toISOString();
  const id = crypto.randomBytes(6).toString('hex');
  const currentAccount = store.accounts[store.activeAccountKey];

  const sealedPayload: SealedBuyerPayload = {
    v: 2,
    id,
    accountKey: store.activeAccountKey,
    accountName:
      sessionMeta?.accountName || currentAccount?.accountName || 'Ahmad Amir',
    phoneNumber: cleanNumber,
    buyerLabel: cleanLabel,
    onlyAfterCreated: Boolean(onlyAfterCreated),
    createdAt,
    ...(sessionMeta?.refreshToken && sessionMeta?.email
      ? {
          email: sessionMeta.email,
          refreshToken: sessionMeta.refreshToken,
          accessToken: sessionMeta.accessToken,
          expiresAt: sessionMeta.expiresAt,
        }
      : {}),
  };

  const token = sealJson(sealedPayload);

  const link: BuyerLink = {
    token,
    accountKey: store.activeAccountKey,
    phoneNumber: cleanNumber,
    buyerLabel: cleanLabel,
    onlyAfterCreated: Boolean(onlyAfterCreated),
    active: true,
    createdAt,
  };

  store.buyerLinks = [link, ...store.buyerLinks];
  persistStore(store);
  broadcastState();
  return link;
}

export function updateBuyerLink(
  token: string,
  updates: { active?: boolean; onlyAfterCreated?: boolean; buyerLabel?: string },
): BuyerLink | null {
  let idx = store.buyerLinks.findIndex((item) => item.token === token);
  if (idx === -1) {
    const unsealed = unsealJson<SealedBuyerPayload>(token);
    if (
      unsealed &&
      unsealed.v === 2 &&
      !store.revokedLinkIds?.includes(unsealed.id)
    ) {
      const recovered: BuyerLink = {
        token,
        accountKey: unsealed.accountKey,
        phoneNumber: unsealed.phoneNumber,
        buyerLabel: unsealed.buyerLabel || '',
        onlyAfterCreated: Boolean(unsealed.onlyAfterCreated),
        active: true,
        createdAt: unsealed.createdAt,
      };
      store.buyerLinks = [recovered, ...store.buyerLinks];
      idx = 0;
    } else {
      return null;
    }
  }

  const current = store.buyerLinks[idx];
  const next: BuyerLink = {
    ...current,
    active: typeof updates.active === 'boolean' ? updates.active : current.active,
    onlyAfterCreated:
      typeof updates.onlyAfterCreated === 'boolean'
        ? updates.onlyAfterCreated
        : current.onlyAfterCreated,
    buyerLabel:
      typeof updates.buyerLabel === 'string'
        ? updates.buyerLabel.trim()
        : current.buyerLabel,
  };

  store.buyerLinks[idx] = next;
  persistStore(store);
  broadcastState();
  return next;
}

export function deleteBuyerLink(token: string): boolean {
  const prevLen = store.buyerLinks.length;
  store.buyerLinks = store.buyerLinks.filter((item) => item.token !== token);
  const unsealed = unsealJson<SealedBuyerPayload>(token);
  let revokedAdded = false;
  if (unsealed && unsealed.id) {
    const set = new Set(store.revokedLinkIds ?? []);
    if (!set.has(unsealed.id)) {
      set.add(unsealed.id);
      store.revokedLinkIds = Array.from(set).slice(-200);
      revokedAdded = true;
    }
  }
  if (store.buyerLinks.length === prevLen && !revokedAdded) return false;
  persistStore(store);
  broadcastState();
  return true;
}

function makeMessageId(
  time: string,
  destination: string,
  senderId: string,
  message: string,
): string {
  const key = `${time.trim()}|${destination.trim()}|${senderId.trim()}|${message.trim()}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 14);
}

function extractOtpFallback(message: string): string {
  const match = message.match(/\b(\d{4,8})\b/);
  return match ? match[1] : '';
}

export function switchActiveAccount(accountKey: string): MirrorState {
  if (store.accounts[accountKey]) {
    store.activeAccountKey = accountKey;
    persistStore(store);
    broadcastState();
  }
  return getMirrorState();
}

export function mergeDirectTechSmsSync(params: {
  accountName: string;
  accountStatus: string;
  totalActiveNumbers: number | null;
  todaysSmsCount: number | null;
  activeNumbers?: ActiveNumberRecord[];
  messages: Array<{
    time: string;
    destination: string;
    senderId: string;
    message: string;
  }>;
}): { newMessagesAdded: number; changed: boolean } {
  const nowIso = new Date().toISOString();
  const cleanName = params.accountName.trim() || 'TechSMS User';
  const targetKey = normalizeAccountKey(cleanName);

  if (!store.accounts[targetKey]) {
    store.accounts[targetKey] = createEmptyAccountState(cleanName);
  }
  const prevKey = store.activeAccountKey;
  store.activeAccountKey = targetKey;
  const targetAccount = store.accounts[targetKey];

  const existingMessageMap = new Map<string, SmsRecord>();
  for (const msg of targetAccount.messages) {
    existingMessageMap.set(msg.id, msg);
  }

  let newMessagesAdded = 0;
  for (const rawMsg of params.messages) {
    const cleanTime = (rawMsg.time || '').trim();
    const cleanDest = (rawMsg.destination || '').trim();
    const cleanSender = (rawMsg.senderId || '').trim();
    const cleanBody = (rawMsg.message || '').trim();
    if (!cleanDest && !cleanBody) continue;

    const id = makeMessageId(cleanTime, cleanDest, cleanSender, cleanBody);
    if (!existingMessageMap.has(id)) {
      newMessagesAdded += 1;
      existingMessageMap.set(id, {
        id,
        time: cleanTime || nowIso.slice(0, 19),
        destination: cleanDest || 'Unknown',
        senderId: cleanSender || 'Unknown',
        message: cleanBody,
        otpCode: extractOtpFallback(cleanBody),
        firstSeenAt: nowIso,
      });
    }
  }

  const mergedMessages = Array.from(existingMessageMap.values()).sort((a, b) => {
    const timeCmp = b.time.localeCompare(a.time);
    if (timeCmp !== 0) return timeCmp;
    return b.firstSeenAt.localeCompare(a.firstSeenAt);
  });

  const nextActiveNumbers =
    params.activeNumbers !== undefined
      ? params.activeNumbers
      : targetAccount.explicitActiveNumbers;

  const numbersChanged =
    params.activeNumbers !== undefined &&
    params.activeNumbers.length !== targetAccount.explicitActiveNumbers.length;

  const countChanged =
    (params.totalActiveNumbers !== null &&
      params.totalActiveNumbers !== targetAccount.reportedActiveNumbersCount) ||
    (params.todaysSmsCount !== null &&
      params.todaysSmsCount !== targetAccount.reportedTodaysSmsCount);

  const changed =
    newMessagesAdded > 0 ||
    numbersChanged ||
    countChanged ||
    prevKey !== targetKey ||
    targetAccount.totalScans === 0;

  const nextScanHistory =
    newMessagesAdded > 0 || numbersChanged || targetAccount.totalScans === 0
      ? [
          {
            id: crypto.randomUUID().slice(0, 8),
            timestamp: nowIso,
            sourceMode: 'auto-sync' as const,
            newMessagesCount: newMessagesAdded,
            activeNumbersCount:
              params.totalActiveNumbers ?? nextActiveNumbers.length,
            summary: `[${cleanName}] Auto-synced ${nextActiveNumbers.length} My Numbers & ${newMessagesAdded} new SMS`,
          },
          ...targetAccount.scanHistory,
        ].slice(0, 30)
      : targetAccount.scanHistory;

  store.accounts[targetKey] = {
    accountKey: targetKey,
    accountName: cleanName,
    accountStatus: params.accountStatus || targetAccount.accountStatus,
    sourceUrl: 'https://techsms.org/dashboard',
    reportedActiveNumbersCount:
      params.totalActiveNumbers ??
      (nextActiveNumbers.length > 0
        ? nextActiveNumbers.length
        : targetAccount.reportedActiveNumbersCount),
    reportedTodaysSmsCount:
      params.todaysSmsCount ?? targetAccount.reportedTodaysSmsCount,
    explicitActiveNumbers: nextActiveNumbers,
    messages: mergedMessages.slice(0, 1000),
    lastSyncedAt: nowIso,
    totalScans: targetAccount.totalScans + (changed ? 1 : 0),
    scanHistory: nextScanHistory,
  };

  if (changed) {
    persistStore(store);
    broadcastState();
  }

  return { newMessagesAdded, changed };
}

export function mergeOcrResult(
  payload: OcrExtractionPayload,
  sourceMode: ScanLogEntry['sourceMode'],
): {
  state: MirrorState;
  newMessagesAdded: number;
  totalExtractedMessages: number;
} {
  const nowIso = new Date().toISOString();

  const detectedName = payload.accountName.trim();
  if (detectedName) {
    const targetKey = normalizeAccountKey(detectedName);
    if (!store.accounts[targetKey]) {
      store.accounts[targetKey] = createEmptyAccountState(detectedName);
    }
    store.activeAccountKey = targetKey;
  }

  const targetAccount =
    store.accounts[store.activeAccountKey] ??
    createEmptyAccountState(detectedName || 'Ahmad Amir');

  const existingMessageMap = new Map<string, SmsRecord>();
  for (const msg of targetAccount.messages) {
    existingMessageMap.set(msg.id, msg);
  }

  let newMessagesAdded = 0;
  for (const rawMsg of payload.messages) {
    const cleanTime = (rawMsg.time || '').trim();
    const cleanDest = (rawMsg.destination || '').trim();
    const cleanSender = (rawMsg.senderId || '').trim();
    const cleanBody = (rawMsg.message || '').trim();
    if (!cleanDest && !cleanBody) continue;

    const id = makeMessageId(cleanTime, cleanDest, cleanSender, cleanBody);
    if (!existingMessageMap.has(id)) {
      newMessagesAdded += 1;
      existingMessageMap.set(id, {
        id,
        time: cleanTime || nowIso.slice(0, 19),
        destination: cleanDest || 'Unknown',
        senderId: cleanSender || 'Unknown',
        message: cleanBody,
        otpCode: (rawMsg.otpCode || '').trim() || extractOtpFallback(cleanBody),
        firstSeenAt: nowIso,
      });
    }
  }

  const mergedMessages = Array.from(existingMessageMap.values()).sort((a, b) => {
    const timeCmp = b.time.localeCompare(a.time);
    if (timeCmp !== 0) return timeCmp;
    return b.firstSeenAt.localeCompare(a.firstSeenAt);
  });

  let mergedActiveNumbers: ActiveNumberRecord[] =
    targetAccount.explicitActiveNumbers;
  if (payload.activeNumbers.length > 0) {
    const numMap = new Map<string, ActiveNumberRecord>();
    for (const existing of targetAccount.explicitActiveNumbers) {
      numMap.set(existing.number, existing);
    }
    for (const item of payload.activeNumbers) {
      const cleanNum = (item.number || '').trim();
      if (!cleanNum) continue;
      numMap.set(cleanNum, {
        number: cleanNum,
        country: (item.country || '').trim() || undefined,
        service: (item.service || '').trim() || undefined,
        range: (item.range || '').trim() || undefined,
        term: (item.term || '').trim() || undefined,
        allocatedAt: (item.allocatedAt || '').trim() || undefined,
        expiresAt: (item.expiresAt || '').trim() || undefined,
        status: (item.status || '').trim() || 'Active',
        lastSeenAt: nowIso,
      });
    }
    mergedActiveNumbers = Array.from(numMap.values());
  }

  const nextActiveCount =
    payload.activeNumbersCount > 0
      ? payload.activeNumbersCount
      : mergedActiveNumbers.length > 0
        ? mergedActiveNumbers.length
        : payload.activeNumbersCount === 0
          ? 0
          : targetAccount.reportedActiveNumbersCount;

  const nextTodaysSms =
    payload.todaysSmsCount >= 0
      ? payload.todaysSmsCount
      : targetAccount.reportedTodaysSmsCount;

  const logEntry: ScanLogEntry = {
    id: crypto.randomUUID().slice(0, 8),
    timestamp: nowIso,
    sourceMode,
    newMessagesCount: newMessagesAdded,
    activeNumbersCount: nextActiveCount,
    summary: `[${detectedName || targetAccount.accountName}] Extracted ${payload.activeNumbers.length} numbers & ${newMessagesAdded} new SMS`,
  };

  store.accounts[store.activeAccountKey] = {
    accountKey: store.activeAccountKey,
    accountName: detectedName || targetAccount.accountName,
    accountStatus: payload.accountStatus.trim() || targetAccount.accountStatus,
    sourceUrl: 'https://techsms.org/dashboard',
    reportedActiveNumbersCount: nextActiveCount,
    reportedTodaysSmsCount: nextTodaysSms,
    explicitActiveNumbers: mergedActiveNumbers,
    messages: mergedMessages.slice(0, 1000),
    lastSyncedAt: nowIso,
    totalScans: targetAccount.totalScans + 1,
    scanHistory: [logEntry, ...targetAccount.scanHistory].slice(0, 30),
  };

  persistStore(store);
  broadcastState();

  return {
    state: getMirrorState(),
    newMessagesAdded,
    totalExtractedMessages: payload.messages.length,
  };
}

export function clearMirrorState(): MirrorState {
  const currentName =
    store.accounts[store.activeAccountKey]?.accountName || 'Ahmad Amir';
  store.accounts[store.activeAccountKey] = createEmptyAccountState(currentName);
  persistStore(store);
  broadcastState();
  return getMirrorState();
}
