import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Response } from 'express';
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

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'mirror-state.json');

interface MultiAccountDiskStore {
  activeAccountKey: string;
  accounts: Record<string, MirrorState>;
  buyerLinks: BuyerLink[];
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

const DEFAULT_STORE: MultiAccountDiskStore = {
  activeAccountKey: 'ahmad-amir',
  accounts: {
    'ahmad-amir': createEmptyAccountState('Ahmad Amir'),
  },
  buyerLinks: [],
};

let syncStatus: TechSmsSyncStatus = {
  connected: false,
  email: null,
  lastSyncAt: null,
  lastError: null,
  pollingIntervalMs: 4000,
};

const sseClients = new Set<Response>();
const buyerSseClients = new Map<string, Set<Response>>();

function loadStoreFromDisk(): MultiAccountDiskStore {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
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
        };
      }
    }
  } catch (err) {
    console.error('Failed to read mirror-state.json:', err);
  }
  return {
    activeAccountKey: DEFAULT_STORE.activeAccountKey,
    accounts: { ...DEFAULT_STORE.accounts },
    buyerLinks: [],
  };
}

let store: MultiAccountDiskStore = loadStoreFromDisk();

function saveStoreToDisk(nextStore: MultiAccountDiskStore): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(nextStore, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist mirror-state.json:', err);
  }
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

export function getBuyerPortalData(token: string): BuyerPortalPayload {
  const link = store.buyerLinks.find((item) => item.token === token);
  if (!link) {
    return {
      valid: false,
      active: false,
      phoneNumber: '',
      buyerLabel: '',
      createdAt: '',
      messages: [],
    };
  }

  if (!link.active) {
    return {
      valid: true,
      active: false,
      phoneNumber: link.phoneNumber,
      buyerLabel: link.buyerLabel,
      createdAt: link.createdAt,
      messages: [],
    };
  }

  const account = store.accounts[link.accountKey];
  const targetNormalized = normalizePhone(link.phoneNumber);

  const filteredMessages = (account?.messages ?? [])
    .filter((msg) => {
      if (normalizePhone(msg.destination) !== targetNormalized) return false;
      if (link.onlyAfterCreated && msg.firstSeenAt < link.createdAt) return false;
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
    phoneNumber: link.phoneNumber,
    buyerLabel: link.buyerLabel,
    createdAt: link.createdAt,
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
): BuyerLink {
  const cleanNumber = phoneNumber.trim();
  const token = crypto.randomBytes(8).toString('hex');
  const link: BuyerLink = {
    token,
    accountKey: store.activeAccountKey,
    phoneNumber: cleanNumber,
    buyerLabel: buyerLabel.trim(),
    onlyAfterCreated: Boolean(onlyAfterCreated),
    active: true,
    createdAt: new Date().toISOString(),
  };

  store.buyerLinks = [link, ...store.buyerLinks];
  saveStoreToDisk(store);
  broadcastState();
  return link;
}

export function updateBuyerLink(
  token: string,
  updates: { active?: boolean; onlyAfterCreated?: boolean; buyerLabel?: string },
): BuyerLink | null {
  const idx = store.buyerLinks.findIndex((item) => item.token === token);
  if (idx === -1) return null;

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
  saveStoreToDisk(store);
  broadcastState();
  return next;
}

export function deleteBuyerLink(token: string): boolean {
  const prevLen = store.buyerLinks.length;
  store.buyerLinks = store.buyerLinks.filter((item) => item.token !== token);
  if (store.buyerLinks.length === prevLen) return false;
  saveStoreToDisk(store);
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
    saveStoreToDisk(store);
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
    saveStoreToDisk(store);
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

  // Merge My Numbers / Active Numbers cleanly without wiping when scanning dashboard overview
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

  saveStoreToDisk(store);
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
  saveStoreToDisk(store);
  broadcastState();
  return getMirrorState();
}
