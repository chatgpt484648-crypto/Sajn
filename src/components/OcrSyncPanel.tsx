import React, { useRef, useState } from 'react';
import {
  Camera,
  MonitorPlay,
  Square,
  Upload,
  ScanLine,
  Trash2,
  AlertCircle,
} from 'lucide-react';
import type { MirrorState } from '../types/mirror';

interface OcrSyncPanelProps {
  state: MirrorState;
  isLiveCaptureActive: boolean;
  isScanning: boolean;
  scanIntervalSec: number;
  changeDetectionEnabled: boolean;
  ocrError: string | null;
  previewVideoRef: React.RefObject<HTMLVideoElement | null>;
  onStartLiveCapture: () => void;
  onStopLiveCapture: () => void;
  onManualFrameCapture: () => void;
  onChangeInterval: (sec: number) => void;
  onToggleChangeDetection: () => void;
  onUploadScreenshotFile: (file: File) => void;
  onScanAttachedSample: () => void;
  onScanMyNumbersSample: () => void;
  onClearHistory: () => void;
}

const INTERVAL_OPTIONS = [2, 3, 5, 10];

export const OcrSyncPanel: React.FC<OcrSyncPanelProps> = ({
  state,
  isLiveCaptureActive,
  isScanning,
  scanIntervalSec,
  changeDetectionEnabled,
  ocrError,
  previewVideoRef,
  onStartLiveCapture,
  onStopLiveCapture,
  onManualFrameCapture,
  onChangeInterval,
  onToggleChangeDetection,
  onUploadScreenshotFile,
  onScanAttachedSample,
  onScanMyNumbersSample,
  onClearHistory,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadScreenshotFile(file);
      e.target.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      onUploadScreenshotFile(file);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          Screenshot &amp; Screen OCR Tools
        </h1>
        <p className="mt-1 text-xs text-slate-500">
          Optional tools to import screenshots (upload or Ctrl+V) or capture a live browser tab. For automatic 24/7 sync, sign in once on the Home tab.
        </p>
      </div>

      {ocrError && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-5 py-4 text-xs text-rose-800">
          <AlertCircle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Notice</p>
            <p className="mt-0.5">{ocrError}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Upload / Paste / Sample Scans */}
        <section className="lg:col-span-6 rounded-xl border border-slate-200 bg-white p-6 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Upload or Paste Screenshot (Ctrl+V)
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Drop any screenshot of TechSMS to extract numbers and messages.
            </p>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`flex flex-col items-center justify-center rounded-lg border border-dashed px-4 py-8 text-center transition-colors ${
              isDragging
                ? 'border-slate-900 bg-slate-50'
                : 'border-slate-300 bg-slate-50/50'
            }`}
          >
            <Upload className="h-5 w-5 text-slate-400" />
            <p className="mt-2 text-xs font-medium text-slate-700">
              Drop PNG/JPG screenshot here or press Ctrl+V
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isScanning}
              className="mt-3 rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              {isScanning ? 'Reading...' : 'Browse File'}
            </button>
          </div>

          <div className="border-t border-slate-100 pt-4 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-600 font-medium">
              Re-scan uploaded captures:
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onScanAttachedSample}
                disabled={isScanning}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <ScanLine className="h-3.5 w-3.5" />
                Dashboard SMS
              </button>
              <button
                type="button"
                onClick={onScanMyNumbersSample}
                disabled={isScanning}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <ScanLine className="h-3.5 w-3.5" />
                My Numbers
              </button>
            </div>
          </div>

          {state.messages.length > 0 && (
            <div className="border-t border-slate-100 pt-4 flex justify-end">
              <button
                type="button"
                onClick={onClearHistory}
                className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-rose-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear Stored Data
              </button>
            </div>
          )}
        </section>

        {/* Optional Live Tab Screen Capture */}
        <section className="lg:col-span-6 rounded-xl border border-slate-200 bg-white p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Optional Live Tab Screen OCR
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Only needed if you prefer screen-sharing a browser tab.
              </p>
            </div>

            {isLiveCaptureActive ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onManualFrameCapture}
                  disabled={isScanning}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Camera className="h-3.5 w-3.5" />
                  Scan Now
                </button>
                <button
                  type="button"
                  onClick={onStopLiveCapture}
                  className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500"
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={onStartLiveCapture}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
              >
                <MonitorPlay className="h-3.5 w-3.5" />
                Select Tab
              </button>
            )}
          </div>

          <div className="aspect-video w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
            <video
              ref={previewVideoRef}
              autoPlay
              muted
              playsInline
              className={`h-full w-full object-contain ${
                isLiveCaptureActive ? 'block' : 'hidden'
              }`}
            />
            {!isLiveCaptureActive && (
              <div className="flex h-full items-center justify-center p-6 text-center text-xs text-slate-400">
                No tab screen selected
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">Interval:</span>
              {INTERVAL_OPTIONS.map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => onChangeInterval(sec)}
                  className={`rounded-md px-2 py-1 font-mono text-xs ${
                    scanIntervalSec === sec
                      ? 'bg-slate-900 text-white'
                      : 'border border-slate-200 text-slate-600'
                  }`}
                >
                  {sec}s
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={onToggleChangeDetection}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              Change-Only: {changeDetectionEnabled ? 'On' : 'Off'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
