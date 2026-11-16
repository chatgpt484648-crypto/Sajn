import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, Volume2, VolumeX, ShieldAlert, Clock } from 'lucide-react';
import { playNewSmsChime } from '../utils/frameCapture';
import type { BuyerPortalPayload } from '../types/mirror';

interface BuyerOtpPortalProps {
  token: string;
}

export const BuyerOtpPortal: React.FC<BuyerOtpPortalProps> = ({ token }) => {
  const [data, setData] = useState<BuyerPortalPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [sseConnected, setSseConnected] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const prevCountRef = useRef<number>(0);
  const soundRef = useRef<boolean>(soundEnabled);

  useEffect(() => {
    soundRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => {
    let active = true;

    fetch(`/api/buyer/${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((payload: BuyerPortalPayload) => {
        if (!active) return;
        prevCountRef.current = payload.messages.length;
        setData(payload);
        setLoading(false);
      })
      .catch(() => {
        if (active) setLoading(false);
      });

    const es = new EventSource(`/api/buyer/${encodeURIComponent(token)}/stream`);
    es.onopen = () => {
      if (active) setSseConnected(true);
    };
    es.onerror = () => {
      if (active) setSseConnected(false);
    };
    es.addEventListener('buyer', (event) => {
      if (!active) return;
      try {
        const nextPayload = JSON.parse(
          (event as MessageEvent).data,
        ) as BuyerPortalPayload;
        if (
          nextPayload.messages.length > prevCountRef.current &&
          prevCountRef.current >= 0 &&
          soundRef.current
        ) {
          playNewSmsChime();
        }
        prevCountRef.current = nextPayload.messages.length;
        setData(nextPayload);
        setLoading(false);
      } catch {
        // Ignore malformed SSE payload
      }
    });

    return () => {
      active = false;
      es.close();
    };
  }, [token]);

  const handleCopy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1500);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] text-slate-600 flex items-center justify-center p-6">
        <div className="text-sm">Loading OTP inbox...</div>
      </div>
    );
  }

  if (!data || !data.valid) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-xl border border-slate-200 bg-white p-8 text-center space-y-2">
          <ShieldAlert className="mx-auto h-7 w-7 text-rose-500" />
          <h1 className="text-base font-bold">Invalid Link</h1>
          <p className="text-xs text-slate-500">
            This number link is invalid or has been removed.
          </p>
        </div>
      </div>
    );
  }

  if (!data.active) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-xl border border-slate-200 bg-white p-8 text-center space-y-2">
          <ShieldAlert className="mx-auto h-7 w-7 text-amber-500" />
          <h1 className="text-base font-bold">Link Paused</h1>
          <p className="text-xs text-slate-500">
            OTP access for <span className="font-mono text-slate-800">{data.phoneNumber}</span> is currently paused.
          </p>
        </div>
      </div>
    );
  }

  const latestOtpMessage = data.messages.find((m) => Boolean(m.otpCode)) || data.messages[0];

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-6 px-6 py-4">
          <span className="text-base font-bold tracking-tight text-slate-900">
            OTP Inbox
          </span>

          <span className={`text-xs font-medium ${sseConnected ? 'text-emerald-700' : 'text-amber-700'}`}>
            {sseConnected ? 'Live' : 'Reconnecting'}
          </span>

          <button
            type="button"
            onClick={() => setSoundEnabled((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {soundEnabled ? (
              <Volume2 className="h-3.5 w-3.5" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" />
            )}
            {soundEnabled ? 'Sound On' : 'Sound Off'}
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 space-y-6">
        {/* Purchased Virtual Number */}
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium text-slate-500">
                Your Virtual Number{data.buyerLabel ? ` · ${data.buyerLabel}` : ''}
              </div>
              <div className="mt-1.5 font-mono text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 tabular-nums">
                {data.phoneNumber}
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleCopy('phone', data.phoneNumber)}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              {copiedKey === 'phone' ? (
                <>
                  <Check className="h-4 w-4" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy Number
                </>
              )}
            </button>
          </div>
        </section>

        {/* Latest OTP Spotlight */}
        {latestOtpMessage && latestOtpMessage.otpCode && (
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs text-slate-500">
                  Latest OTP · <span className="font-semibold text-slate-800">{latestOtpMessage.senderId}</span> ·{' '}
                  <span className="font-mono tabular-nums">{latestOtpMessage.time}</span>
                </div>
                <div className="mt-1.5 font-mono text-4xl font-bold tracking-widest text-slate-900 tabular-nums">
                  {latestOtpMessage.otpCode}
                </div>
              </div>

              <button
                type="button"
                onClick={() => handleCopy('latest-otp', latestOtpMessage.otpCode)}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-900 hover:bg-slate-100 whitespace-nowrap shrink-0"
              >
                {copiedKey === 'latest-otp' ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-600" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    Copy OTP
                  </>
                )}
              </button>
            </div>
          </section>
        )}

        {/* Received SMS */}
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
            <h2 className="text-sm font-semibold text-slate-900">
              Messages ({data.messages.length})
            </h2>
            <span className="text-xs text-slate-400">Updates automatically</span>
          </div>

          {data.messages.length === 0 ? (
            <div className="px-6 py-14 text-center space-y-2">
              <Clock className="mx-auto h-6 w-6 text-slate-400" />
              <p className="text-sm font-medium text-slate-800">
                Waiting for OTP...
              </p>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Keep this page open. New SMS sent to{' '}
                <span className="font-mono text-slate-800">{data.phoneNumber}</span> will appear here automatically.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="px-6 py-3 whitespace-nowrap">Time</th>
                    <th className="px-6 py-3 whitespace-nowrap">From</th>
                    <th className="px-6 py-3 whitespace-nowrap">OTP</th>
                    <th className="px-6 py-3">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.messages.map((msg) => (
                    <tr key={msg.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="px-6 py-3.5 font-mono text-xs text-slate-500 whitespace-nowrap tabular-nums">
                        {msg.time}
                      </td>
                      <td className="px-6 py-3.5 text-xs font-medium text-slate-800 whitespace-nowrap">
                        {msg.senderId}
                      </td>
                      <td className="px-6 py-3.5 whitespace-nowrap">
                        {msg.otpCode ? (
                          <button
                            type="button"
                            onClick={() => handleCopy(`row-${msg.id}`, msg.otpCode)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs font-semibold text-slate-900 hover:border-slate-400 tabular-nums"
                          >
                            {msg.otpCode}
                            {copiedKey === `row-${msg.id}` ? (
                              <Check className="h-3 w-3 text-emerald-600" />
                            ) : (
                              <Copy className="h-3 w-3 text-slate-400" />
                            )}
                          </button>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-6 py-3.5 text-xs text-slate-600 leading-relaxed min-w-[240px]">
                        {msg.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};
