import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import dotenv from 'dotenv';
import { parseCookieHeader, sealJson, unsealJson } from './cryptoVault.ts';
import { runDashboardOcr } from './ocrService.ts';
import {
  addBuyerSseClient,
  addSseClient,
  clearMirrorState,
  createBuyerLink,
  deleteBuyerLink,
  ensureStoreLoaded,
  flushPersistence,
  getBuyerLinksForCookie,
  getBuyerPortalData,
  getMirrorState,
  mergeBuyerLinksFromCookie,
  mergeOcrResult,
  removeBuyerSseClient,
  removeSseClient,
  switchActiveAccount,
  unsealBuyerToken,
  updateBuyerLink,
} from './stateStore.ts';
import {
  consumeUpdatedSessionCookieValue,
  disconnectTechSmsAccount,
  ensureFreshSync,
  ensureFreshSyncForBuyer,
  getActiveSessionMeta,
  getSealedSessionCookieValue,
  loginTechSmsAccount,
  restoreSessionIfNeeded,
  syncTechSmsNow,
} from './techsmsClient.ts';
import type { BuyerLink, ScanLogEntry } from '../src/types/mirror.ts';

dotenv.config();

const SESSION_COOKIE_NAME = 'tsms_sess';
const LINKS_COOKIE_NAME = 'tsms_links';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0].trim() === 'https';
  }
  return false;
}

function appendCookie(
  res: Response,
  req: Request,
  name: string,
  value: string,
  maxAgeSec = COOKIE_MAX_AGE_SEC,
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecureRequest(req)) {
    parts.push('Secure');
  }
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res: Response, req: Request, name: string): void {
  appendCookie(res, req, name, '', 0);
}

function syncBuyerLinksCookie(res: Response, req: Request): void {
  const links = getBuyerLinksForCookie();
  if (links.length === 0) {
    clearCookie(res, req, LINKS_COOKIE_NAME);
    return;
  }
  const sealed = sealJson(links);
  if (sealed.length <= 3600) {
    appendCookie(res, req, LINKS_COOKIE_NAME, sealed);
  }
}

function resolvePublicAssetPath(fileName: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'public', 'assets', 'aistudio', fileName),
    path.resolve(process.cwd(), 'dist', 'assets', 'aistudio', fileName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function configureApiRoutes(app: Express): void {
  app.use(express.json({ limit: '15mb' }));

  // Hydrate store, remote/cookie TechSMS session, and seller buyer-links on every API call
  app.use('/api', async (req, _res, next) => {
    try {
      await ensureStoreLoaded();
      const cookies = parseCookieHeader(req.headers.cookie);
      await restoreSessionIfNeeded(cookies[SESSION_COOKIE_NAME]);

      if (cookies[LINKS_COOKIE_NAME]) {
        const cookieLinks = unsealJson<BuyerLink[]>(cookies[LINKS_COOKIE_NAME]);
        if (Array.isArray(cookieLinks)) {
          mergeBuyerLinksFromCookie(cookieLinks);
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  app.get('/api/state', async (req, res) => {
    if (req.query.live === '1') {
      await ensureFreshSync(3000);
      const refreshedCookie = consumeUpdatedSessionCookieValue();
      if (refreshedCookie) {
        appendCookie(res, req, SESSION_COOKIE_NAME, refreshedCookie);
      }
    }
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
      await flushPersistence();
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
      const attachedPath = resolvePublicAssetPath('image_017222d5.png');

      if (!attachedPath) {
        res.status(404).json({
          error: 'Attached dashboard capture file not found on server.',
        });
        return;
      }

      const fileBuffer = fs.readFileSync(attachedPath);
      const base64 = fileBuffer.toString('base64');
      const extracted = await runDashboardOcr(base64, 'image/png');
      const result = mergeOcrResult(extracted, 'attached-capture');
      await flushPersistence();
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
      const myNumbersPath = resolvePublicAssetPath('image_a6ffb5b7.png');

      if (!myNumbersPath) {
        res.status(404).json({
          error: 'Attached My Numbers capture file not found on server.',
        });
        return;
      }

      const fileBuffer = fs.readFileSync(myNumbersPath);
      const base64 = fileBuffer.toString('base64');
      const extracted = await runDashboardOcr(base64, 'image/png');
      const result = mergeOcrResult(extracted, 'attached-capture');
      await flushPersistence();
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
      const sealedCookie = getSealedSessionCookieValue();
      if (sealedCookie) {
        appendCookie(res, req, SESSION_COOKIE_NAME, sealedCookie);
      }
      res.json({ ok: true, session, state: getMirrorState() });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to connect TechSMS account.';
      res.status(401).json({ error: message });
    }
  });

  app.post('/api/techsms/sync', async (req, res) => {
    try {
      await syncTechSmsNow(true);
      await flushPersistence();
      const sealedCookie = getSealedSessionCookieValue();
      if (sealedCookie) {
        appendCookie(res, req, SESSION_COOKIE_NAME, sealedCookie);
      }
      res.json({ ok: true, state: getMirrorState() });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Sync failed.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/techsms/disconnect', async (req, res) => {
    await disconnectTechSmsAccount();
    clearCookie(res, req, SESSION_COOKIE_NAME);
    res.json({ ok: true, state: getMirrorState() });
  });

  app.post('/api/state/clear', async (_req, res) => {
    const cleared = clearMirrorState();
    await flushPersistence();
    res.json({ ok: true, state: cleared });
  });

  app.post('/api/account/switch', async (req, res) => {
    const { accountKey } = req.body as { accountKey?: string };
    if (!accountKey || typeof accountKey !== 'string') {
      res.status(400).json({ error: 'Missing accountKey.' });
      return;
    }
    const updated = switchActiveAccount(accountKey);
    await flushPersistence();
    res.json({ ok: true, state: updated });
  });

  // Seller: create / update / delete buyer self-service OTP links
  app.post('/api/buyer-links', async (req, res) => {
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
      getActiveSessionMeta(),
    );
    await flushPersistence();
    syncBuyerLinksCookie(res, req);
    res.json({ ok: true, link, state: getMirrorState() });
  });

  app.patch('/api/buyer-links/:token', async (req, res) => {
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
    await flushPersistence();
    syncBuyerLinksCookie(res, req);
    res.json({ ok: true, link: updated, state: getMirrorState() });
  });

  app.delete('/api/buyer-links/:token', async (req, res) => {
    const { token } = req.params;
    const deleted = deleteBuyerLink(token);
    if (!deleted) {
      res.status(404).json({ error: 'Buyer link not found.' });
      return;
    }
    await flushPersistence();
    syncBuyerLinksCookie(res, req);
    res.json({ ok: true, state: getMirrorState() });
  });

  // Public Buyer OTP Portal: isolated to the single purchased number
  app.get('/api/buyer/:token', async (req, res) => {
    const { token } = req.params;
    if (req.query.live === '1') {
      const unsealed = unsealBuyerToken(token);
      if (unsealed) {
        await ensureFreshSyncForBuyer(unsealed, 3000);
      } else {
        await ensureFreshSync(3000);
      }
    }

    const payload = getBuyerPortalData(token);
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
}
