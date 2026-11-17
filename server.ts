import 'dotenv/config';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './server/db.ts';
import { apiRouter } from './server/routes.ts';

export async function startServer(port = Number(process.env.PORT || 3000)) {
  initDatabase();

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use('/api', apiRouter);

  const isProd = process.env.NODE_ENV === 'production';
  let viteServer: Awaited<ReturnType<typeof createViteServer>> | null = null;
  if (!isProd) {
    viteServer = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false
      },
      appType: 'spa'
    });
    app.use(viteServer.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return new Promise<{ app: express.Express; server: ReturnType<express.Express['listen']> }>((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`CivicLedger server listening on http://0.0.0.0:${port} (mode=${isProd ? 'production' : 'development'})`);
      resolve({ app, server });
    });
    server.on('close', () => {
      if (viteServer) {
        viteServer.close().catch(() => {});
        viteServer = null;
      }
    });
  });
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
