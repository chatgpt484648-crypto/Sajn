import React, { useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Search,
  Link2,
  ExternalLink,
  Pause,
  Play,
  Trash2,
} from 'lucide-react';
import type { BuyerLink, MirrorState } from '../types/mirror';

interface ActiveNumbersViewProps {
  state: MirrorState;
  onViewNumberMessages: (phoneNumber: string) => void;
  onOpenSyncTab: () => void;
  onCreateBuyerLink: (
    phoneNumber: string,
    buyerLabel: string,
    onlyAfterCreated: boolean,
  ) => Promise<BuyerLink | null>;
  onToggleBuyerLink: (token: string, active: boolean) => Promise<void>;
  onDeleteBuyerLink: (token: string) => Promise<void>;
}

interface CombinedNumberEntry {
  number: string;
  range: string;
  expiresAt: string;
  status: string;
  smsCount: number;
}

type NumberFilterMode = 'unused' | 'all' | 'used';

export const ActiveNumbersView: React.FC<ActiveNumbersViewProps> = ({
  state,
  onViewNumberMessages,
  onOpenSyncTab,
  onCreateBuyerLink,
  onToggleBuyerLink,
  onDeleteBuyerLink,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<NumberFilterMode>('unused');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [manualNumber, setManualNumber] = useState('');
  const [manualLabel, setManualLabel] = useState('');
  const [onlyAfterSale, setOnlyAfterSale] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const allCombinedNumbers = useMemo<CombinedNumberEntry[]>(() => {
    const smsByNumber = new Map<string, number>();
    for (const msg of state.messages) {
      smsByNumber.set(
        msg.destination,
        (smsByNumber.get(msg.destination) || 0) + 1,
      );
    }

    const resultMap = new Map<string, CombinedNumberEntry>();

    for (const active of state.explicitActiveNumbers) {
      const count = smsByNumber.get(active.number) || 0;
      resultMap.set(active.number, {
        number: active.number,
        range: active.range || active.service || 'United Kingdom',
        expiresAt: active.expiresAt || '—',
        status: count === 0 ? 'Ready' : 'Used',
        smsCount: count,
      });
    }

    for (const [num, count] of smsByNumber.entries()) {
      if (!resultMap.has(num)) {
        resultMap.set(num, {
          number: num,
          range: 'United Kingdom',
          expiresAt: '—',
          status: 'Used',
          smsCount: count,
        });
      }
    }

    return Array.from(resultMap.values());
  }, [state.explicitActiveNumbers, state.messages]);

  const unusedCount = useMemo(
    () => allCombinedNumbers.filter((n) => n.smsCount === 0).length,
    [allCombinedNumbers],
  );
  const usedCount = useMemo(
    () => allCombinedNumbers.filter((n) => n.smsCount > 0).length,
    [allCombinedNumbers],
  );

  const filteredNumbers = useMemo(() => {
    return allCombinedNumbers.filter((item) => {
      if (filterMode === 'unused' && item.smsCount > 0) return false;
      if (filterMode === 'used' && item.smsCount === 0) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        item.number.toLowerCase().includes(q) ||
        item.range.toLowerCase().includes(q)
      );
    });
  }, [allCombinedNumbers, filterMode, searchQuery]);

  const buyerLinks = state.buyerLinks ?? [];

  const copyText = (key: string, value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  };

  const buildShareUrl = (token: string) =>
    `${window.location.origin}/?buyer=${encodeURIComponent(token)}`;

  const handleQuickShareNumber = async (phoneNumber: string) => {
    setIsCreating(true);
    try {
      const created = await onCreateBuyerLink(phoneNumber, '', onlyAfterSale);
      if (created) {
        copyText(`link-${created.token}`, buildShareUrl(created.token));
      }
    } finally {
      setIsCreating(false);
    }
  };

  const handleManualCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualNumber.trim()) return;
    setIsCreating(true);
    try {
      const created = await onCreateBuyerLink(
        manualNumber.trim(),
        manualLabel.trim(),
        onlyAfterSale,
      );
      if (created) {
        copyText(`link-${created.token}`, buildShareUrl(created.token));
        setManualNumber('');
        setManualLabel('');
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            Numbers ({allCombinedNumbers.length})
          </h1>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {unusedCount} ready (no OTP) · {usedCount} used
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
            <button
              type="button"
              onClick={() => setFilterMode('unused')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                filterMode === 'unused'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Ready ({unusedCount})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('all')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                filterMode === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All ({allCombinedNumbers.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('used')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                filterMode === 'used'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Used ({usedCount})
            </button>
          </div>

          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search number..."
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Simple Numbers Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {filteredNumbers.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-slate-600">
              {allCombinedNumbers.length === 0
                ? 'No numbers loaded yet.'
                : 'No numbers match your filter.'}
            </p>
            {allCombinedNumbers.length === 0 && (
              <button
                type="button"
                onClick={onOpenSyncTab}
                className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white"
              >
                Connect Account
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-6 py-3 whitespace-nowrap">Number</th>
                  <th className="px-6 py-3 whitespace-nowrap">Range</th>
                  <th className="px-6 py-3 whitespace-nowrap">Expires</th>
                  <th className="px-6 py-3 whitespace-nowrap">Status</th>
                  <th className="px-6 py-3 whitespace-nowrap text-right">SMS</th>
                  <th className="px-6 py-3 whitespace-nowrap text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredNumbers.map((item) => {
                  const existingLink = buyerLinks.find(
                    (l) => l.phoneNumber === item.number && l.active,
                  );
                  return (
                    <tr
                      key={item.number}
                      className="hover:bg-slate-50/70 transition-colors"
                    >
                      <td className="px-6 py-3.5 font-mono text-xs font-semibold text-slate-900 whitespace-nowrap tabular-nums">
                        {item.number}
                      </td>
                      <td className="px-6 py-3.5 text-xs text-slate-600 whitespace-nowrap">
                        {item.range}
                      </td>
                      <td className="px-6 py-3.5 font-mono text-xs text-slate-500 whitespace-nowrap tabular-nums">
                        {item.expiresAt}
                      </td>
                      <td className="px-6 py-3.5 text-xs font-medium whitespace-nowrap">
                        <span
                          className={
                            item.smsCount === 0 ? 'text-emerald-700' : 'text-slate-600'
                          }
                        >
                          {item.status}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 text-right font-mono text-xs font-semibold text-slate-900 whitespace-nowrap tabular-nums">
                        {item.smsCount}
                      </td>
                      <td className="px-6 py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => copyText(`num-${item.number}`, item.number)}
                            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1"
                          >
                            {copiedKey === `num-${item.number}` ? (
                              <>
                                <Check className="h-3 w-3 text-emerald-600" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" />
                                Copy
                              </>
                            )}
                          </button>

                          {existingLink ? (
                            <button
                              type="button"
                              onClick={() =>
                                copyText(
                                  `link-${existingLink.token}`,
                                  buildShareUrl(existingLink.token),
                                )
                              }
                              className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 inline-flex items-center gap-1"
                            >
                              <Link2 className="h-3 w-3" />
                              {copiedKey === `link-${existingLink.token}`
                                ? 'Link Copied'
                                : 'Copy Link'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleQuickShareNumber(item.number)}
                              disabled={isCreating}
                              className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 inline-flex items-center gap-1"
                            >
                              <Link2 className="h-3 w-3" />
                              Buyer Link
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => onViewNumberMessages(item.number)}
                            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            SMS
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Buyer Links Section */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-100 px-6 py-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Buyer OTP Links ({buyerLinks.length})
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Send a private link to your buyer so they can receive OTPs for their number directly.
            </p>
          </div>

          <form
            onSubmit={handleManualCreate}
            className="flex flex-col gap-2.5 lg:flex-row lg:items-center"
          >
            <input
              type="text"
              value={manualNumber}
              onChange={(e) => setManualNumber(e.target.value)}
              placeholder="Phone number (e.g. +447378178426)"
              className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:bg-white focus:outline-none"
            />
            <input
              type="text"
              value={manualLabel}
              onChange={(e) => setManualLabel(e.target.value)}
              placeholder="Buyer name (optional)"
              className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:bg-white focus:outline-none"
            />
            <label className="inline-flex items-center gap-2 text-xs text-slate-600 whitespace-nowrap cursor-pointer">
              <input
                type="checkbox"
                checked={onlyAfterSale}
                onChange={(e) => setOnlyAfterSale(e.target.checked)}
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              New SMS only
            </label>
            <button
              type="submit"
              disabled={isCreating || !manualNumber.trim()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              Create Link
            </button>
          </form>
        </div>

        {buyerLinks.length === 0 ? (
          <div className="px-6 py-8 text-center text-xs text-slate-500">
            No buyer links yet. Click &ldquo;Buyer Link&rdquo; on any number above.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-6 py-3 whitespace-nowrap">Number</th>
                  <th className="px-6 py-3 whitespace-nowrap">Buyer</th>
                  <th className="px-6 py-3 whitespace-nowrap">Status</th>
                  <th className="px-6 py-3 whitespace-nowrap text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {buyerLinks.map((link) => {
                  const shareUrl = buildShareUrl(link.token);
                  return (
                    <tr key={link.token} className="hover:bg-slate-50/70 transition-colors">
                      <td className="px-6 py-3.5 font-mono text-xs font-semibold text-slate-900 whitespace-nowrap tabular-nums">
                        {link.phoneNumber}
                      </td>
                      <td className="px-6 py-3.5 text-xs text-slate-600 whitespace-nowrap">
                        {link.buyerLabel || '—'}
                      </td>
                      <td className="px-6 py-3.5 text-xs font-medium whitespace-nowrap">
                        <span className={link.active ? 'text-emerald-700' : 'text-amber-700'}>
                          {link.active ? 'Active' : 'Paused'}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => copyText(`link-${link.token}`, shareUrl)}
                            className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 inline-flex items-center gap-1"
                          >
                            <Copy className="h-3 w-3" />
                            {copiedKey === `link-${link.token}` ? 'Copied' : 'Copy Link'}
                          </button>
                          <a
                            href={`/?buyer=${encodeURIComponent(link.token)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1"
                          >
                            Open
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          <button
                            type="button"
                            onClick={() => onToggleBuyerLink(link.token, !link.active)}
                            title={link.active ? 'Pause' : 'Resume'}
                            className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
                          >
                            {link.active ? (
                              <Pause className="h-3.5 w-3.5" />
                            ) : (
                              <Play className="h-3.5 w-3.5 text-emerald-600" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteBuyerLink(link.token)}
                            title="Delete"
                            className="rounded-md border border-slate-200 p-1.5 text-slate-400 hover:text-rose-600"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
