import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, Search, Volume2, VolumeX, X } from 'lucide-react';
import type { SmsRecord } from '../types/mirror';

interface SmsInboxViewProps {
  messages: SmsRecord[];
  selectedNumberFilter: string | null;
  onClearNumberFilter: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
}

export const SmsInboxView: React.FC<SmsInboxViewProps> = ({
  messages,
  selectedNumberFilter,
  onClearNumberFilter,
  soundEnabled,
  onToggleSound,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [senderFilter, setSenderFilter] = useState<string>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const topSenders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const msg of messages) {
      counts.set(msg.senderId, (counts.get(msg.senderId) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sender]) => sender);
  }, [messages]);

  const filteredMessages = useMemo(() => {
    return messages.filter((msg) => {
      if (selectedNumberFilter && msg.destination !== selectedNumberFilter) {
        return false;
      }
      if (senderFilter !== 'all' && msg.senderId !== senderFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          msg.destination.toLowerCase().includes(q) ||
          msg.senderId.toLowerCase().includes(q) ||
          msg.message.toLowerCase().includes(q) ||
          msg.otpCode.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [messages, selectedNumberFilter, senderFilter, searchQuery]);

  const handleCopy = (id: string, value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 1500);
  };

  const handleExportCsv = () => {
    const headers = ['Time', 'Number', 'From', 'OTP', 'Message'];
    const escapeCsv = (val: string) => `"${val.replace(/"/g, '""')}"`;
    const rows = filteredMessages.map((m) =>
      [m.time, m.destination, m.senderId, m.otpCode, m.message].map(escapeCsv).join(','),
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `messages-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            Messages ({filteredMessages.length})
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            All inbound SMS received on your account numbers
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative w-full sm:w-60">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search number, OTP..."
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
            />
          </div>

          <button
            type="button"
            onClick={onToggleSound}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
              soundEnabled
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:text-slate-900'
            }`}
          >
            {soundEnabled ? (
              <Volume2 className="h-3.5 w-3.5" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" />
            )}
            {soundEnabled ? 'Sound On' : 'Sound Off'}
          </button>

          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filteredMessages.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => setSenderFilter('all')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
              senderFilter === 'all'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All
          </button>
          {topSenders.map((sender) => (
            <button
              key={sender}
              type="button"
              onClick={() => setSenderFilter(sender)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                senderFilter === sender
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {sender}
            </button>
          ))}
        </div>

        {selectedNumberFilter && (
          <button
            type="button"
            onClick={onClearNumberFilter}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs text-slate-800 hover:bg-slate-50"
          >
            {selectedNumberFilter}
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Simple Messages Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {filteredMessages.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-500">
            No messages match your filter.
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
                {filteredMessages.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-6 py-3.5 font-mono text-xs text-slate-500 whitespace-nowrap tabular-nums">
                      {row.time}
                    </td>
                    <td className="px-6 py-3.5 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleCopy(`dest-${row.id}`, row.destination)}
                        className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-slate-900 hover:underline tabular-nums"
                        title="Copy number"
                      >
                        {row.destination}
                        {copiedId === `dest-${row.id}` && (
                          <Check className="h-3 w-3 text-emerald-600" />
                        )}
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
                          {copiedId === `otp-${row.id}` ? (
                            <Check className="h-3 w-3 text-emerald-600" />
                          ) : (
                            <Copy className="h-3 w-3 text-slate-400" />
                          )}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3.5 text-xs text-slate-600 leading-relaxed min-w-[260px]">
                      {row.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
