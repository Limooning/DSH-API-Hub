// Host half of dsh-api-hub.
//
// The panel is a browser plugin; its data comes from this host half, which
// mounts the request handler from ../../server.mjs on DSH's own web server at
// /api-hub. Nothing listens on a port of its own and no child process runs.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';

// lib/ lives inside <api-hub>/plugin, so the panel backend sits two levels up.
const SERVER_SCRIPT = fileURLToPath(new URL('../../server.mjs', import.meta.url));

const ROUTE_PREFIX = '/api-hub';

// The backend is imported lazily and re-imported whenever server.mjs changes, so
// backend edits take effect on a page refresh instead of a DSH restart. Each
// revision gets its own module instance (cache-busting query).
let handlerPromise = null;
let handlerMtime = 0;

function loadHandler() {
  const mtime = statSync(SERVER_SCRIPT).mtimeMs;
  if (!handlerPromise || mtime !== handlerMtime) {
    handlerMtime = mtime;
    const url = pathToFileURL(SERVER_SCRIPT).href + '?mtime=' + encodeURIComponent(String(mtime));
    handlerPromise = import(url).then((mod) => mod.handleRequest);
  }
  return handlerPromise;
}

function mountRoutes(ctx) {
  ctx.inject(['webServer'], (host) => {
    ctx.effect(() => {
      const dispose = host.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (request, response) => {
          try {
            const handle = await loadHandler();
            await handle(request, response, ROUTE_PREFIX);
          } catch (error) {
            try {
              response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              response.end(JSON.stringify({ error: 'panel handler failed: ' + (error?.message ?? String(error)) }));
            } catch { /* response already gone */ }
          }
        },
      });
      return () => {
        try { dispose?.(); } catch { /* already gone */ }
      };
    }, 'api-hub: panel routes');
  });
}

/**
 * Publish the server origin as a page global before browser plugins activate.
 * The Electron shell loads the client from a non-http origin, so the client
 * half cannot derive the panel URL from `location` alone.
 */
function publishOrigin(ctx, getOrigin) {
  ctx.on('webserver/index-inject', (table) => {
    const origin = getOrigin();
    if (origin) table.push({ kind: 'global', name: '__API_HUB_ORIGIN__', value: origin });
  });
}

export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    const readOrigin = () => {
      try { return String(host.webServer.getOrigin() ?? ''); } catch { return ''; }
    };
    try {
      publishOrigin(ctx, readOrigin);
    } catch (error) {
      console.warn('[api-hub] origin injection unavailable:', error?.message ?? error);
    }
  });

  try {
    mountRoutes(ctx);
  } catch (error) {
    console.warn('[api-hub] mounting on the DSH web server failed:', error?.message ?? error);
  }
}
