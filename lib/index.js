// Host half of dsh-api-hub.
//
// The panel is a browser plugin; its data comes from this host half, which
// mounts the request handler from ./server.mjs on DSH's own web server at
// /api-hub. Nothing listens on a port of its own and no child process runs.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';

const SERVER_SCRIPT = fileURLToPath(new URL('./server.mjs', import.meta.url));

const ROUTE_PREFIX = '/api-hub';

// The backend is imported lazily and re-imported whenever server.mjs changes, so
// backend edits take effect on a page refresh instead of a DSH restart. Each
// revision gets its own module instance (cache-busting query).
let handlerPromise = null;
let handlerMtime = 0;
let handlerModule = null;

// The credential service this profile composed, if any. Held here so it can be
// handed to every new revision of the backend module.
let credentialService = null;

/**
 * Hand the credential service to the backend. Missing service, an older backend
 * revision without the hook, or a profile that never composed the service are
 * all fine: the backend falls back to writing the YAML file itself.
 */
function attachCredentials(mod) {
  try {
    mod?.useCredentialService?.(credentialService);
  } catch (error) {
    console.warn('[api-hub] credential service not accepted by the panel backend:', error?.message ?? error);
  }
}

function loadHandler() {
  const mtime = statSync(SERVER_SCRIPT).mtimeMs;
  if (!handlerPromise || mtime !== handlerMtime) {
    handlerMtime = mtime;
    const url = pathToFileURL(SERVER_SCRIPT).href + '?mtime=' + encodeURIComponent(String(mtime));
    handlerPromise = import(url).then((mod) => {
      handlerModule = mod;
      attachCredentials(mod);
      return mod.handleRequest;
    });
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

  mountCredentialBridge(ctx);
}

/**
 * Route key edits through DSH's own credential store instead of writing
 * `~/.dsh/.credentials.yaml` behind its back: the service owns that file, takes a
 * lock for it and announces each change, so its in-memory copy and every listener
 * stay in step with what the panel wrote.
 *
 * Injected separately from `webServer` on purpose — a profile without the
 * credentials service simply never calls back, and the backend keeps using its
 * file writer.
 */
function mountCredentialBridge(ctx) {
  try {
    ctx.inject(['credentials'], (host) => {
      const service = host.credentials;
      if (!service || typeof service.set !== 'function') return;
      credentialService = {
        set: (ref, value) => service.set(ref, value),
        unset: (ref) => (typeof service.unset === 'function' ? service.unset(ref) : Promise.resolve()),
      };
      if (handlerModule) attachCredentials(handlerModule);
      ctx.effect(() => () => {
        credentialService = null;
        if (handlerModule) attachCredentials(handlerModule);
      }, 'api-hub: credential bridge');
    });
  } catch (error) {
    console.warn('[api-hub] credential service unavailable:', error?.message ?? error);
  }
}
