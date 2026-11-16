import path from 'node:path';
import express from 'express';
import dotenv from 'dotenv';
import { configureApiRoutes } from './server/app.ts';
import { startBackgroundPoller } from './server/techsmsClient.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();

  configureApiRoutes(app);

  if (!IS_PRODUCTION) {
    const { createServer: createViteServer } = await import('vite');
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
