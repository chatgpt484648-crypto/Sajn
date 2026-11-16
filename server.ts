import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { runDashboardOcr } from './server/ocrService.ts';
import {
  addBuyerSseClient,
  addSseClient,
  clearMirrorState,
  createBuyerLink,
  deleteBuyerLink,
  getBuyerPortalData,
  getMirrorState,
  mergeOcrResult,
  removeBuyerSseClient,
  removeSseClient,
  switchActiveAccount,
  updateBuyerLink,
} from './server/stateStore.ts';
import {
  disconnectTechSmsAccount,
  loginTechSmsAccount,
  startBackgroundPoller,
  syncTechSmsNow,
} from './server/techsmsClient.ts';
import type { ScanLogEntry } from './src/types/mirror.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', hasGeminiKey: Boolean(process.env.GEMINI_API_KEY) });
  });

  app.get('/api/state', (_req, res) => {
    res.json(getMirrorState());
  });

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    addSseClient(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeSseClient(res);
    });
  });

  app.post('/api/ocr/extract', async (req, res) => {
    try {
      const { imageBase64, mimeType, sourceMode } = req.body as {
        imageBase64?: string;
        mimeType?: string;
        sourceMode?: ScanLogEntry['sourceMode'];
      };

      if (!imageBase64 || typeof imageBase64 !== 'string') {
        res.status(400).json({ error: 'Missing imageBase64 payload.' });
        return;
      }

      const mode: ScanLogEntry['sourceMode'] =
        sourceMode === 'live-tab' ||
        sourceMode === 'paste' ||
        sourceMode === 'attached-capture'
          ? sourceMode
          : 'upload';

      const extracted = await runDashboardOcr(imageBase64, mimeType || 'image/png');
      const result = mergeOcrResult(extracted, mode);
      res.json({
        ok: true,
        extracted,
        ...result,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'OCR extraction failed.';
      console.error('OCR extract error:', err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/ocr/scan-attached', async (_req, res) => {
    try {
      const attachedPath = path.resolve(
        process.cwd(),
        'public',
        'assets',
        'aistudio',
        'image_017222d5.png',
      );

      if (!fs.existsSync(attachedPath)) {
        res.status(404).json({
          error: 'Attached dashboard capture file not found on server.',
        });
        return;
      }

      const fileBuffer = fs.readFileSync(attachedPath);
      const base64 = fileBuffer.toString('base64');
      const extracted = await runDashboardOcr(base64, 'image/png');
      const result = mergeOcrResult(extracted, 'attached-capture');
      res.json({
        ok: true,
        extracted,
        ...result,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'OCR extraction failed.';
      console.error('Attached capture OCR error:', err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/ocr/scan-my-numbers', async (_req, res) => {
    try {
      const myNumbersPath = path.resolve(
        process.cwd(),
        'public',
        'assets',
        'aistudio',
        'image_a6ffb5b7.png',
      );

      if (!fs.existsSync(myNumbersPath)) {
        res.status(404).json({
          error: 'Attached My Numbers capture file not found on server.',
        });
        return;
      }

      const fileBuffer = fs.readFileSync(myNumbersPath);
      const base64 = fileBuffer.toString('base64');
      const extracted = await runDashboardOcr(base64, 'image/png');
      const result = mergeOcrResult(extracted, 'attached-capture');
      res.json({
        ok: true,
        extracted,
        ...result,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'OCR extraction failed.';
      console.error('My Numbers OCR error:', err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/techsms/login', async (req, res) => {
    try {
      const { email, password } = req.body as {
        email?: string;
        password?: string;
      };
      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required.' });
        return;
      }
      const session = await loginTechSmsAccount(email, password);
      res.json({ ok: true, session, state: getMirrorState() });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to connect TechSMS account.';
      res.status(401).json({ error: message });
    }
  });

  app.post('/api/techsms/sync', async (_req, res) => {
    try {
      await syncTechSmsNow(true);
      res.json({ ok: true, state: getMirrorState() });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Sync failed.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/techsms/disconnect', (_req, res) => {
    disconnectTechSmsAccount();
    res.json({ ok: true, state: getMirrorState() });
  });

  app.post('/api/state/clear', (_req, res) => {
    const cleared = clearMirrorState();
    res.json({ ok: true, state: cleared });
  });

  app.post('/api/account/switch', (req, res) => {
    const { accountKey } = req.body as { accountKey?: string };
    if (!accountKey || typeof accountKey !== 'string') {
      res.status(400).json({ error: 'Missing accountKey.' });
      return;
    }
    const updated = switchActiveAccount(accountKey);
    res.json({ ok: true, state: updated });
  });

  // Seller: create / update / delete buyer self-service OTP links
  app.post('/api/buyer-links', (req, res) => {
    const { phoneNumber, buyerLabel, onlyAfterCreated } = req.body as {
      phoneNumber?: string;
      buyerLabel?: string;
      onlyAfterCreated?: boolean;
    };
    if (!phoneNumber || typeof phoneNumber !== 'string' || !phoneNumber.trim()) {
      res.status(400).json({ error: 'Phone number is required.' });
      return;
    }
    const link = createBuyerLink(
      phoneNumber,
      buyerLabel || '',
      Boolean(onlyAfterCreated),
    );
    res.json({ ok: true, link });
  });

  app.patch('/api/buyer-links/:token', (req, res) => {
    const { token } = req.params;
    const { active, onlyAfterCreated, buyerLabel } = req.body as {
      active?: boolean;
      onlyAfterCreated?: boolean;
      buyerLabel?: string;
    };
    const updated = updateBuyerLink(token, {
      active,
      onlyAfterCreated,
      buyerLabel,
    });
    if (!updated) {
      res.status(404).json({ error: 'Buyer link not found.' });
      return;
    }
    res.json({ ok: true, link: updated });
  });

  app.delete('/api/buyer-links/:token', (req, res) => {
    const { token } = req.params;
    const deleted = deleteBuyerLink(token);
    if (!deleted) {
      res.status(404).json({ error: 'Buyer link not found.' });
      return;
    }
    res.json({ ok: true });
  });

  // Public Buyer OTP Portal: isolated to the single purchased number
  app.get('/api/buyer/:token', (req, res) => {
    const payload = getBuyerPortalData(req.params.token);
    if (!payload.valid) {
      res.status(404).json(payload);
      return;
    }
    res.json(payload);
  });

  app.get('/api/buyer/:token/stream', (req, res) => {
    const { token } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    addBuyerSseClient(token, res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeBuyerSseClient(token, res);
    });
  });

  if (!IS_PRODUCTION) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TechSMS OCR Mirror running on http://0.0.0.0:${PORT}`);
    startBackgroundPoller();
  });
}

startServer().catch((err) => {
  console.error('Server startup error:', err);
  process.exit(1);
});
