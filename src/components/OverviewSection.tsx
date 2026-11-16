import React, { useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Search,
  ExternalLink,
  Link2,
  RefreshCw,
} from 'lucide-react';
import type { BuyerLink, MirrorState } from '../types/mirror';

interface OverviewSectionProps {
  state: MirrorState;
  sseConnected: boolean;
  isSyncingNow: boolean;
  isConnectingTechSms: boolean;
  techSmsAuthError: string | null;
  onConnectTechSms: (email: string, password: string) => Promise<boolean>;
  onSyncNow: () => void;
  onDisconnectTechSms: () => void;
  onSwitchAccount: (accountKey: string) => void;
  onCreateBuyerLink: (
    phoneNumber: string,
    buyerLabel: string,
    onlyAfterCreated: boolean,
  ) => Promise<BuyerLink | null>;
  onOpenNumbersTab: () => void;
  onOpenSmsTab: (filterNumber?: string) => void;
}

export const OverviewSection: React.FC<OverviewSectionProps> = ({
  state,
  sseConnected,
  isSyncingNow,
  isConnectingTechSms,
  techSmsAuthError,
  onConnectTechSms,
  onSyncNow,
  onDisconnectTechSms,
  onSwitchAccount,
  onCreateBuyerLink,
  onOpenNumbersTab,
  onOpenSmsTab,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [tableSearch, setTableSearch] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');

  const { freshNumbers, totalNumbersCount } = useMemo(() => {
    const smsCountByNumber = new Map<string, number>();
    for (const msg of state.messages) {
      smsCountByNumber.set(
        msg.destination,
        (smsCountByNumber.get(msg.destination) || 0) + 1,
      );
    }

    const allNumbersMap = new Map<
      string,
      { number: string; range: string; smsCount: number }
    >();

    for (const n of state.explicitActiveNumbers) {
      allNumbersMap.set(n.number, {
        number: n.number,
        range: n.range || n.service || 'United Kingdom',
        smsCount: smsCountByNumber.get(n.number) || 0,
      });
    }

    for (const [num, count] of smsCountByNumber.entries()) {
      if (!allNumbersMap.has(num)) {
        allNumbersMap.set(num, {
          number: num,
          range: 'United Kingdom',
          smsCount: count,
        });
      }
    }

    const allList = Array.from(allNumbersMap.values());
    return {
      freshNumbers: allList.filter((item) => item.smsCount === 0),
      totalNumbersCount: allList.length,
    };
  }, [state.explicitActiveNumbers, state.messages]);

  const activeNumbersDisplay =
    state.explicitActiveNumbers.length > 0
      ? state.explicitActiveNumbers.length
      : state.reportedActiveNumbersCount ?? totalNumbersCount;

  const visibleMessages = useMemo(() => {
    if (!tableSearch.trim()) return state.messages;
    const q = tableSearch.toLowerCase();
    return state.messages.filter(
      (msg) =>
        msg.destination.toLowerCase().includes(q) ||
        msg.senderId.toLowerCase().includes(q) ||
        msg.message.toLowerCase().includes(q) ||
        msg.otpCode.toLowerCase().includes(q),
    );
  }, [state.messages, tableSearch]);

  const buyerLinks = state.buyerLinks ?? [];

  const handleCopy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1500);
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailInput.trim() || !passwordInput) return;
    const ok = await onConnectTechSms(emailInput.trim(), passwordInput);
    if (ok) {
      setPasswordInput('');
    }
  };

  const isAutoConnected = Boolean(state.techsmsSync?.connected);

  return (
    <div className="space-y-8">
      {/* Simple Header */}
      <section className="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {state.accountName || 'Ahmad Amir'}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
            <span>{activeNumbersDisplay} Numbers</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-700 font-medium">
              {freshNumbers.length} Ready (No OTP)
            </span>
            <span aria-hidden="true">·</span>
            <span>{state.messages.length} Messages</span>
            <span aria-hidden="true">·</span>
            <span className={sseConnected ? 'text-emerald-700' : 'text-amber-700'}>
              {sseConnected ? 'Live' : 'Connecting'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {state.knownAccounts && state.knownAccounts.length > 1 && (
            <select
              aria-label="Switch account"
              value={state.accountKey || ''}
              onChange={(e) => onSwitchAccount(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 focus:border-slate-900 focus:outline-none"
            >
              {state.knownAccounts.map((acc) => (
                <option key={acc.key} value={acc.key}>
                  {acc.accountName} ({acc.messageCount} SMS)
                </option>
              ))}
            </select>
          )}

          {isAutoConnected && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-emerald-700 font-medium">
                Auto-syncing ({state.techsmsSync?.email})
              </span>
              <button
                type="button"
                onClick={onSyncNow}
                disabled={isSyncingNow}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-3 w-3 ${isSyncingNow ? 'animate-spin' : ''}`} />
                Sync
              </button>
              <button
                type="button"
                onClick={onDisconnectTechSms}
                className="rounded-lg px-2.5 py-1.5 text-slate-500 hover:text-rose-600"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Compact 1-line Connect Account Bar when not auto-connected */}
      {!isAutoConnected && (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Connect your TechSMS account for automatic live OTPs
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Sign in once so new OTPs appear automatically here and on your buyers&apos; links.
              </p>
            </div>

            <form
              onSubmit={handleLoginSubmit}
              className="flex flex-col gap-2 sm:flex-row sm:items-center shrink-0"
            >
              <input
                type="email"
                required
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="TechSMS email"
                className="w-full sm:w-48 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:bg-white focus:outline-none"
              />
              <input
                type="password"
                required
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Password"
                className="w-full sm:w-36 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:bg-white focus:outline-none"
              />
              <button
                type="submit"
                disabled={isConnectingTechSms}
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                {isConnectingTechSms ? 'Connecting...' : 'Connect'}
              </button>
            </form>
          </div>
          {techSmsAuthError && (
            <p className="mt-2.5 text-xs text-rose-600">{techSmsAuthError}</p>
          )}
        </section>
      )}

      {/* Ready Numbers to Sell (Clean simple list) */}
      {freshNumbers.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Ready Numbers ({freshNumbers.length})
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Unused numbers with no OTP yet — pick one and copy its Buyer Link
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenNumbersTab}
              className="text-xs font-semibold text-slate-900 hover:underline whitespace-nowrap"
            >
              View all {activeNumbersDisplay}
            </button>
          </div>

          <div className="grid grid-cols-1 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0 sm:divide-x lg:grid-cols-3">
            {freshNumbers.slice(0, 9).map((item) => {
              const existingLink = buyerLinks.find(
                (l) => l.phoneNumber === item.number && l.active,
              );
              const shareUrl = existingLink
                ? `${window.location.origin}/?buyer=${encodeURIComponent(existingLink.token)}`
                : null;

              return (
                <div
                  key={item.number}
                  className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-100"
                >
                  <button
                    type="button"
                    onClick={() => onOpenSmsTab(item.number)}
                    className="font-mono text-sm font-semibold text-slate-900 hover:text-sky-700 tabular-nums truncate"
                  >
                    {item.number}
                  </button>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {shareUrl && existingLink ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleCopy(`share-${item.number}`, shareUrl)}
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 transition-colors"
                        >
                          {copiedKey === `share-${item.number}` ? (
                            <>
                              <Check className="h-3 w-3" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Link2 className="h-3 w-3" />
                              Copy Link
                            </>
                          )}
                        </button>
                        <a
                          href={`/?buyer=${encodeURIComponent(existingLink.token)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open buyer link"
                          className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          const created = await onCreateBuyerLink(item.number, '', false);
                          if (created) {
                            const url = `${window.location.origin}/?buyer=${encodeURIComponent(created.token)}`;
                            handleCopy(`share-${item.number}`, url);
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors"
                      >
                        <Link2 className="h-3 w-3" />
                        Buyer Link
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleCopy(`num-${item.number}`, item.number)}
                      title="Copy number"
                      className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                    >
                      {copiedKey === `num-${item.number}` ? (
                        <Check className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Simple Messages Table */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            Recent Messages ({visibleMessages.length})
          </h2>

          <div className="flex items-center gap-3">
            <div className="relative w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                placeholder="Search number or OTP..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:bg-white focus:outline-none"
              />
            </div>

            <button
              type="button"
              onClick={() => onOpenSmsTab()}
              className="text-xs font-semibold text-slate-900 hover:underline whitespace-nowrap"
            >
              All Messages
            </button>
          </div>
        </div>

        {visibleMessages.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-500">
            No messages found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-6 py-3 whitespace-nowrap">Time</th>
                  <th className="px-6 py-3 whitespace-nowrap">Number</th>
                  <th className="px-6 py-3 whitespace-nowrap">From</th>
                  <th className="px-6 py-3 whitespace-nowrap">OTP</th>
                  <th className="px-6 py-3">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleMessages.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-6 py-3.5 font-mono text-xs text-slate-500 whitespace-nowrap tabular-nums">
                      {row.time}
                    </td>
                    <td className="px-6 py-3.5 font-mono text-xs font-semibold text-slate-900 whitespace-nowrap tabular-nums">
                      <button
                        type="button"
                        onClick={() => onOpenSmsTab(row.destination)}
                        className="hover:underline"
                      >
                        {row.destination}
                      </button>
                    </td>
                    <td className="px-6 py-3.5 text-xs font-medium text-slate-700 whitespace-nowrap">
                      {row.senderId}
                    </td>
                    <td className="px-6 py-3.5 whitespace-nowrap">
                      {row.otpCode ? (
                        <button
                          type="button"
                          onClick={() => handleCopy(`otp-${row.id}`, row.otpCode)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs font-semibold text-slate-900 hover:border-slate-400 tabular-nums"
                        >
                          {row.otpCode}
                          {copiedKey === `otp-${row.id}` ? (
                            <Check className="h-3 w-3 text-emerald-600" />
                          ) : (
                            <Copy className="h-3 w-3 text-slate-400" />
                          )}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3.5 text-xs text-slate-600 min-w-[260px]">
                      {row.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
