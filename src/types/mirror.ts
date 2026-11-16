export interface SmsRecord {
  id: string;
  time: string;
  destination: string;
  senderId: string;
  message: string;
  otpCode: string;
  firstSeenAt: string;
}

export interface ActiveNumberRecord {
  number: string;
  country?: string;
  service?: string;
  range?: string;
  term?: string;
  allocatedAt?: string;
  expiresAt?: string;
  status: string;
  lastSeenAt: string;
}

export interface ScanLogEntry {
  id: string;
  timestamp: string;
  sourceMode: 'auto-sync' | 'live-tab' | 'upload' | 'paste' | 'attached-capture';
  newMessagesCount: number;
  activeNumbersCount: number | null;
  summary: string;
}

export interface AccountSummary {
  key: string;
  accountName: string;
  messageCount: number;
  activeNumbersCount: number | null;
  lastSyncedAt: string | null;
}

export interface BuyerLink {
  token: string;
  accountKey: string;
  phoneNumber: string;
  buyerLabel: string;
  onlyAfterCreated: boolean;
  active: boolean;
  createdAt: string;
}

export interface BuyerPortalPayload {
  valid: boolean;
  active: boolean;
  phoneNumber: string;
  buyerLabel: string;
  createdAt: string;
  messages: Array<{
    id: string;
    time: string;
    senderId: string;
    otpCode: string;
    message: string;
  }>;
}

export interface TechSmsSyncStatus {
  connected: boolean;
  email: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  pollingIntervalMs: number;
}

export interface MirrorState {
  accountKey?: string;
  accountName: string;
  accountStatus: string;
  sourceUrl: string;
  reportedActiveNumbersCount: number | null;
  reportedTodaysSmsCount: number | null;
  explicitActiveNumbers: ActiveNumberRecord[];
  messages: SmsRecord[];
  lastSyncedAt: string | null;
  totalScans: number;
  scanHistory: ScanLogEntry[];
  knownAccounts?: AccountSummary[];
  buyerLinks?: BuyerLink[];
  techsmsSync?: TechSmsSyncStatus;
}

export interface OcrExtractionPayload {
  detectedSource: string;
  accountName: string;
  accountStatus: string;
  activeNumbersCount: number;
  todaysSmsCount: number;
  activeNumbers: Array<{
    number: string;
    country: string;
    service: string;
    range?: string;
    term?: string;
    allocatedAt?: string;
    expiresAt?: string;
    status: string;
  }>;
  messages: Array<{
    time: string;
    destination: string;
    senderId: string;
    message: string;
    otpCode: string;
  }>;
}
