/**
 * Static file serving for the built dashboard, with strict path-traversal
 * protection and an SPA fallback to index.html.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
});

export interface StaticFileServer {
  /** Attempt to serve a static file; returns false when nothing matched. */
  serve(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean;
}

export function createStaticFileServer(rootDir: string): StaticFileServer {
  const root = resolve(rootDir);

  const serveFile = (res: ServerResponse, filePath: string): boolean => {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return false;
    }
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      // Dashboard assets are content-hashed by the bundler; index.html is
      // never cached so new deployments are picked up immediately.
      'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(filePath).pipe(res);
    return true;
  };

  return {
    serve(req, res, urlPath): boolean {
      // Normalize and strictly confine resolution inside the root directory.
      const decoded = decodeURIComponent(urlPath);
      const normalized = normalize(decoded).replace(/^([/\\])+/, '');
      const candidate = resolve(root, normalized);
      if (candidate !== root && !candidate.startsWith(root + sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return true;
      }

      if (decoded === '/' || decoded === '') {
        return serveFile(res, join(root, 'index.html'));
      }
      if (serveFile(res, candidate)) {
        return true;
      }
      // SPA fallback: client-side routes resolve to index.html.
      if (req.method === 'GET' && !extname(decoded)) {
        return serveFile(res, join(root, 'index.html'));
      }
      return false;
    },
  };
}
