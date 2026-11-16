export interface CapturedFrame {
  base64: string;
  mimeType: string;
  signature: Uint8Array;
}

const DIFF_WIDTH = 128;
const DIFF_HEIGHT = 72;

export function captureVideoFrame(
  video: HTMLVideoElement,
  maxWidth = 1600,
): CapturedFrame | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const scale = vw > maxWidth ? maxWidth / vw : 1;
  const targetW = Math.round(vw * scale);
  const targetH = Math.round(vh * scale);

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, targetW, targetH);
  const dataUrl = canvas.toDataURL('image/png');

  // Compute high-resolution grayscale signature so single-digit KPI or 1-row SMS changes are caught
  const sigCanvas = document.createElement('canvas');
  sigCanvas.width = DIFF_WIDTH;
  sigCanvas.height = DIFF_HEIGHT;
  const sigCtx = sigCanvas.getContext('2d');
  if (!sigCtx) return null;

  sigCtx.drawImage(video, 0, 0, DIFF_WIDTH, DIFF_HEIGHT);
  const imgData = sigCtx.getImageData(0, 0, DIFF_WIDTH, DIFF_HEIGHT).data;
  const signature = new Uint8Array(DIFF_WIDTH * DIFF_HEIGHT);
  for (let i = 0; i < signature.length; i++) {
    const idx = i * 4;
    signature[i] = Math.round(
      0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2],
    );
  }

  return {
    base64: dataUrl,
    mimeType: 'image/png',
    signature,
  };
}

export function computeFrameDiffPercent(
  prev: Uint8Array | null,
  next: Uint8Array,
): number {
  if (!prev || prev.length !== next.length) return 100;

  let changedPixels = 0;
  for (let i = 0; i < next.length; i++) {
    if (Math.abs(next[i] - prev[i]) > 8) {
      changedPixels += 1;
    }
  }
  return (changedPixels / next.length) * 100;
}

export function readFileAsBase64(file: File): Promise<{
  base64: string;
  mimeType: string;
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Failed to read image file.'));
        return;
      }
      resolve({
        base64: reader.result,
        mimeType: file.type || 'image/png',
      });
    };
    reader.onerror = () => reject(new Error('Unable to read image file.'));
    reader.readAsDataURL(file);
  });
}

export function playNewSmsChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(740, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(987.77, ctx.currentTime + 0.09);

    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  } catch {
    // Ignore audio context restrictions if user hasn't interacted yet
  }
}
