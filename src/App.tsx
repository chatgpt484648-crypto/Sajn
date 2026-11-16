import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar, type NavTab } from './components/TopBar';
import { OverviewSection } from './components/OverviewSection';
import { ActiveNumbersView } from './components/ActiveNumbersView';
import { SmsInboxView } from './components/SmsInboxView';
import { OcrSyncPanel } from './components/OcrSyncPanel';
import { BuyerOtpPortal } from './components/BuyerOtpPortal';
import {
  captureVideoFrame,
  computeFrameDiffPercent,
  playNewSmsChime,
  readFileAsBase64,
} from './utils/frameCapture';
import type { BuyerLink, MirrorState, ScanLogEntry } from './types/mirror';

const INITIAL_STATE: MirrorState = {
  accountKey: 'ahmad-amir',
  accountName: 'Ahmad Amir',
  accountStatus: 'Operational · Full Access',
  sourceUrl: 'https://techsms.org/dashboard',
  reportedActiveNumbersCount: null,
  reportedTodaysSmsCount: null,
  explicitActiveNumbers: [],
  messages: [],
  lastSyncedAt: null,
  totalScans: 0,
  scanHistory: [],
  knownAccounts: [],
  buyerLinks: [],
  techsmsSync: {
    connected: false,
    email: null,
    lastSyncAt: null,
    lastError: null,
    pollingIntervalMs: 4000,
  },
};

function getBuyerTokenFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('buyer');
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [buyerToken] = useState<string | null>(() => getBuyerTokenFromUrl());

  if (buyerToken) {
    return <BuyerOtpPortal token={buyerToken} />;
  }

  return <SellerAdminApp />;
}

function SellerAdminApp() {
  const [state, setState] = useState<MirrorState>(INITIAL_STATE);
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [selectedNumberFilter, setSelectedNumberFilter] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);

  const [isLiveCaptureActive, setIsLiveCaptureActive] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isSyncingNow, setIsSyncingNow] = useState(false);
  const [isConnectingTechSms, setIsConnectingTechSms] = useState(false);
  const [techSmsAuthError, setTechSmsAuthError] = useState<string | null>(null);

  const [scanIntervalSec, setScanIntervalSec] = useState(3);
  const [changeDetectionEnabled, setChangeDetectionEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [toastNotice, setToastNotice] = useState<string | null>(null);

  const captureVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const lastSignatureRef = useRef<Uint8Array | null>(null);
  const lastOcrTimestampRef = useRef<number>(0);
  const scanInFlightRef = useRef(false);
  const previousMsgCountRef = useRef<number>(0);
  const soundEnabledRef = useRef<boolean>(soundEnabled);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  const showNotice = useCallback((msg: string) => {
    setToastNotice(msg);
    setTimeout(() => {
      setToastNotice((prev) => (prev === msg ? null : prev));
    }, 3500);
  }, []);

  const applyIncomingState = useCallback(
    (nextState: MirrorState, notifyNew = true) => {
      const prevCount = previousMsgCountRef.current;
      if (notifyNew && nextState.messages.length > prevCount && prevCount > 0) {
        if (soundEnabledRef.current) {
          playNewSmsChime();
        }
        showNotice(
          `${nextState.messages.length - prevCount} new inbound SMS received`,
        );
      }
      previousMsgCountRef.current = nextState.messages.length;
      setState(nextState);
    },
    [showNotice],
  );

  useEffect(() => {
    let active = true;
    let pollInFlight = false;

    const pullLatestState = async (live = true) => {
      if (!active || pollInFlight) return;
      pollInFlight = true;
      try {
        const res = await fetch(live ? '/api/state?live=1' : '/api/state');
        if (!res.ok) return;
        const nextState = (await res.json()) as MirrorState;
        if (!active) return;
        applyIncomingState(nextState, previousMsgCountRef.current > 0);
        setSseConnected(true);
      } catch {
        // Ignore transient network errors
      } finally {
        pollInFlight = false;
      }
    };

    pullLatestState(true);

    const es = new EventSource('/api/stream');
    es.onopen = () => {
      if (active) setSseConnected(true);
    };
    es.onerror = () => {
      // Serverless environments close SSE streams; polling keeps state live
    };
    es.addEventListener('state', (event) => {
      if (!active) return;
      try {
        const nextState = JSON.parse((event as MessageEvent).data) as MirrorState;
        applyIncomingState(nextState, true);
      } catch {
        // Ignore malformed SSE payload
      }
    });

    const pollTimer = setInterval(() => {
      pullLatestState(true);
    }, 4000);

    return () => {
      active = false;
      clearInterval(pollTimer);
      es.close();
    };
  }, [applyIncomingState]);

  useEffect(() => {
    if (activeTab === 'sync' && previewVideoRef.current && mediaStreamRef.current) {
      previewVideoRef.current.srcObject = mediaStreamRef.current;
      previewVideoRef.current.play().catch(() => {});
    }
  }, [activeTab, isLiveCaptureActive]);

  const submitOcrImage = useCallback(
    async (
      imageBase64: string,
      mimeType: string,
      sourceMode: ScanLogEntry['sourceMode'],
    ) => {
      if (scanInFlightRef.current) return;
      scanInFlightRef.current = true;
      setIsScanning(true);
      setOcrError(null);

      try {
        const res = await fetch('/api/ocr/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64, mimeType, sourceMode }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          state?: MirrorState;
          newMessagesAdded?: number;
          totalExtractedMessages?: number;
        };

        if (!res.ok) {
          throw new Error(data.error || 'OCR request failed.');
        }

        if (data.state) {
          applyIncomingState(data.state, false);
        }

        lastOcrTimestampRef.current = Date.now();

        if (sourceMode !== 'live-tab') {
          showNotice(
            `OCR extracted ${data.totalExtractedMessages ?? 0} SMS (${data.newMessagesAdded ?? 0} new)`,
          );
        }
      } catch (err) {
        setOcrError(err instanceof Error ? err.message : 'OCR extraction failed.');
      } finally {
        scanInFlightRef.current = false;
        setIsScanning(false);
      }
    },
    [showNotice],
  );

  const runLiveFrameCapture = useCallback(
    async (forceScan = false) => {
      const video = captureVideoRef.current;
      if (!video || !mediaStreamRef.current || scanInFlightRef.current) return;

      const captured = captureVideoFrame(video);
      if (!captured) return;

      const msSinceLastOcr = Date.now() - lastOcrTimestampRef.current;
      const periodicHeartbeatDue = msSinceLastOcr >= 15000;

      if (!forceScan && changeDetectionEnabled && !periodicHeartbeatDue) {
        const diffPercent = computeFrameDiffPercent(
          lastSignatureRef.current,
          captured.signature,
        );
        if (diffPercent < 0.03) {
          return;
        }
      }

      lastSignatureRef.current = captured.signature;
      await submitOcrImage(captured.base64, captured.mimeType, 'live-tab');
    },
    [changeDetectionEnabled, submitOcrImage],
  );

  const stopLiveCapture = useCallback(() => {
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
    if (captureVideoRef.current) {
      captureVideoRef.current.srcObject = null;
    }
    if (previewVideoRef.current) {
      previewVideoRef.current.srcObject = null;
    }
    lastSignatureRef.current = null;
    setIsLiveCaptureActive(false);
  }, []);

  const startLiveCapture = useCallback(async () => {
    setOcrError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setOcrError(
        'Screen capture is not supported in this browser context. Use automatic TechSMS Account Sign-In in Overview or drop/paste a screenshot.',
      );
      setActiveTab('sync');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 5,
        },
        audio: false,
      });

      mediaStreamRef.current = stream;
      lastSignatureRef.current = null;
      lastOcrTimestampRef.current = 0;

      if (captureVideoRef.current) {
        captureVideoRef.current.srcObject = stream;
        await captureVideoRef.current.play();
      }
      if (previewVideoRef.current) {
        previewVideoRef.current.srcObject = stream;
        await previewVideoRef.current.play();
      }

      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          stopLiveCapture();
        });
      }

      setIsLiveCaptureActive(true);
      showNotice('Live tab OCR started');

      setTimeout(() => {
        runLiveFrameCapture(true);
      }, 600);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Unable to start tab capture.';
      setOcrError(
        msg.includes('disallowed') || msg.includes('permissions') || msg.includes('Permission')
          ? 'Tab screen capture was blocked by the embedded preview frame. Use 1-time TechSMS Sign-In in Overview so syncing runs automatically without screen sharing!'
          : msg,
      );
      setActiveTab('sync');
    }
  }, [runLiveFrameCapture, showNotice, stopLiveCapture]);

  useEffect(() => {
    if (!isLiveCaptureActive) return;
    const timer = setInterval(() => {
      runLiveFrameCapture(false);
    }, scanIntervalSec * 1000);
    return () => clearInterval(timer);
  }, [isLiveCaptureActive, scanIntervalSec, runLiveFrameCapture]);

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            const { base64, mimeType } = await readFileAsBase64(file);
            await submitOcrImage(base64, mimeType, 'paste');
            break;
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [submitOcrImage]);

  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        for (const track of mediaStreamRef.current.getTracks()) {
          track.stop();
        }
      }
    };
  }, []);

  const handleUploadScreenshotFile = async (file: File) => {
    try {
      const { base64, mimeType } = await readFileAsBase64(file);
      await submitOcrImage(base64, mimeType, 'upload');
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Failed to read image.');
    }
  };

  const handleScanAttachedSample = async () => {
    if (scanInFlightRef.current) return;
    scanInFlightRef.current = true;
    setIsScanning(true);
    setOcrError(null);
    try {
      const res = await fetch('/api/ocr/scan-attached', { method: 'POST' });
      const data = (await res.json()) as {
        error?: string;
        state?: MirrorState;
        totalExtractedMessages?: number;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to scan attached capture.');
      }
      if (data.state) applyIncomingState(data.state, false);
      showNotice(`Scanned Dashboard capture: ${data.totalExtractedMessages ?? 0} SMS extracted`);
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Failed to scan attached capture.');
    } finally {
      scanInFlightRef.current = false;
      setIsScanning(false);
    }
  };

  const handleScanMyNumbersSample = async () => {
    if (scanInFlightRef.current) return;
    scanInFlightRef.current = true;
    setIsScanning(true);
    setOcrError(null);
    try {
      const res = await fetch('/api/ocr/scan-my-numbers', { method: 'POST' });
      const data = (await res.json()) as {
        error?: string;
        state?: MirrorState;
        extracted?: { activeNumbers?: unknown[] };
      };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to scan My Numbers capture.');
      }
      if (data.state) applyIncomingState(data.state, false);
      const count = data.extracted?.activeNumbers?.length ?? 0;
      showNotice(`Scanned My Numbers capture: ${count} active numbers loaded`);
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Failed to scan My Numbers capture.');
    } finally {
      scanInFlightRef.current = false;
      setIsScanning(false);
    }
  };

  const handleConnectTechSms = async (
    email: string,
    password: string,
  ): Promise<boolean> => {
    setIsConnectingTechSms(true);
    setTechSmsAuthError(null);
    try {
      const res = await fetch('/api/techsms/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        state?: MirrorState;
        session?: { accountName: string };
      };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to connect TechSMS account.');
      }
      if (data.state) applyIncomingState(data.state, false);
      showNotice(
        `Connected ${data.session?.accountName || email} — auto-syncing every 4s`,
      );
      return true;
    } catch (err) {
      setTechSmsAuthError(
        err instanceof Error ? err.message : 'Failed to connect TechSMS account.',
      );
      return false;
    } finally {
      setIsConnectingTechSms(false);
    }
  };

  const handleSyncNow = async () => {
    setIsSyncingNow(true);
    try {
      const res = await fetch('/api/techsms/sync', { method: 'POST' });
      const data = (await res.json()) as { ok?: boolean; state?: MirrorState };
      if (!res.ok) throw new Error('Sync failed.');
      if (data.state) applyIncomingState(data.state, true);
      showNotice('Synced latest My Numbers & inbound SMS');
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setIsSyncingNow(false);
    }
  };

  const handleDisconnectTechSms = async () => {
    const res = await fetch('/api/techsms/disconnect', { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as { state?: MirrorState };
      if (data.state) applyIncomingState(data.state, false);
    }
    showNotice('Disconnected TechSMS auto-sync');
  };

  const handleSwitchAccount = async (accountKey: string) => {
    try {
      const res = await fetch('/api/account/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountKey }),
      });
      const data = (await res.json()) as { state?: MirrorState };
      if (!res.ok) {
        throw new Error('Failed to switch account.');
      }
      if (data.state) applyIncomingState(data.state, false);
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Failed to switch account.');
    }
  };

  const handleCreateBuyerLink = async (
    phoneNumber: string,
    buyerLabel: string,
    onlyAfterCreated: boolean,
  ): Promise<BuyerLink | null> => {
    try {
      const res = await fetch('/api/buyer-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber, buyerLabel, onlyAfterCreated }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        link?: BuyerLink;
        state?: MirrorState;
        error?: string;
      };
      if (!res.ok || !data.link) {
        throw new Error(data.error || 'Failed to create buyer link.');
      }
      if (data.state) applyIncomingState(data.state, false);
      showNotice(`Buyer OTP link copied for ${phoneNumber}`);
      return data.link;
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Failed to create buyer link.');
      return null;
    }
  };

  const handleToggleBuyerLink = async (token: string, active: boolean) => {
    try {
      const res = await fetch(`/api/buyer-links/${encodeURIComponent(token)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      const data = (await res.json()) as { state?: MirrorState };
      if (!res.ok) throw new Error('Failed to update buyer link.');
      if (data.state) applyIncomingState(data.state, false);
      showNotice(active ? 'Buyer OTP link resumed' : 'Buyer OTP link paused');
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Failed to update buyer link.');
    }
  };

  const handleDeleteBuyerLink = async (token: string) => {
    try {
      const res = await fetch(`/api/buyer-links/${encodeURIComponent(token)}`, {
        method: 'DELETE',
      });
      const data = (await res.json()) as { state?: MirrorState };
      if (!res.ok) throw new Error('Failed to delete buyer link.');
      if (data.state) applyIncomingState(data.state, false);
      showNotice('Buyer OTP link deleted');
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Failed to delete buyer link.');
    }
  };

  const handleClearHistory = async () => {
    try {
      const res = await fetch('/api/state/clear', { method: 'POST' });
      const data = (await res.json()) as { state?: MirrorState };
      if (data.state) applyIncomingState(data.state, false);
      showNotice('Synced mirror records cleared');
    } catch {
      setOcrError('Failed to clear stored records.');
    }
  };

  const handleViewSmsForNumber = (phoneNumber?: string) => {
    setSelectedNumberFilter(phoneNumber ?? null);
    setActiveTab('sms');
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      <video
        ref={captureVideoRef}
        autoPlay
        muted
        playsInline
        className="hidden"
      />

      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        isTechSmsConnected={Boolean(state.techsmsSync?.connected)}
        isSyncingNow={isSyncingNow}
        onPrimaryAction={() => {
          if (state.techsmsSync?.connected) {
            handleSyncNow();
          } else {
            setActiveTab('overview');
          }
        }}
      />

      {toastNotice && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-40 rounded-lg border border-slate-200 bg-slate-900 px-4 py-2.5 text-xs font-medium text-white shadow-lg"
        >
          {toastNotice}
        </div>
      )}

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {activeTab === 'overview' && (
          <OverviewSection
            state={state}
            sseConnected={sseConnected}
            isSyncingNow={isSyncingNow}
            isConnectingTechSms={isConnectingTechSms}
            techSmsAuthError={techSmsAuthError}
            onConnectTechSms={handleConnectTechSms}
            onSyncNow={handleSyncNow}
            onDisconnectTechSms={handleDisconnectTechSms}
            onSwitchAccount={handleSwitchAccount}
            onCreateBuyerLink={handleCreateBuyerLink}
            onOpenNumbersTab={() => setActiveTab('numbers')}
            onOpenSmsTab={handleViewSmsForNumber}
          />
        )}

        {activeTab === 'numbers' && (
          <ActiveNumbersView
            state={state}
            onViewNumberMessages={handleViewSmsForNumber}
            onOpenSyncTab={() => setActiveTab('sync')}
            onCreateBuyerLink={handleCreateBuyerLink}
            onToggleBuyerLink={handleToggleBuyerLink}
            onDeleteBuyerLink={handleDeleteBuyerLink}
          />
        )}

        {activeTab === 'sms' && (
          <SmsInboxView
            messages={state.messages}
            selectedNumberFilter={selectedNumberFilter}
            onClearNumberFilter={() => setSelectedNumberFilter(null)}
            soundEnabled={soundEnabled}
            onToggleSound={() => setSoundEnabled((v) => !v)}
          />
        )}

        {activeTab === 'sync' && (
          <OcrSyncPanel
            state={state}
            isLiveCaptureActive={isLiveCaptureActive}
            isScanning={isScanning}
            scanIntervalSec={scanIntervalSec}
            changeDetectionEnabled={changeDetectionEnabled}
            ocrError={ocrError}
            previewVideoRef={previewVideoRef}
            onStartLiveCapture={startLiveCapture}
            onStopLiveCapture={stopLiveCapture}
            onManualFrameCapture={() => runLiveFrameCapture(true)}
            onChangeInterval={setScanIntervalSec}
            onToggleChangeDetection={() => setChangeDetectionEnabled((v) => !v)}
            onUploadScreenshotFile={handleUploadScreenshotFile}
            onScanAttachedSample={handleScanAttachedSample}
            onScanMyNumbersSample={handleScanMyNumbersSample}
            onClearHistory={handleClearHistory}
          />
        )}
      </main>
    </div>
  );
}
