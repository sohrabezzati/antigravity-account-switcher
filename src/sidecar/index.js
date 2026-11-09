import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CdpBridge } from './cdp-bridge.js';
import { initVault, listProfiles, switchProfile, snapshotCurrentSession, removeProfile, updateProfileLabel, syncActiveSession } from './vault-manager.js';
import { getAllAccountsQuotaSummary, fetchActiveQuota } from './quota-poller.js';
import { AutoSwitcher } from './auto-switcher.js';
import { checkForUpdates } from './update-checker.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSS_PATH = path.join(__dirname, '..', 'injector', 'modal.css');
const UI_JS_PATH = path.join(__dirname, '..', 'injector', 'modal-ui.js');

const PORT = 51444;
const HOST = '127.0.0.1';

let isSwitchingInProgress = false;
let savedRouteToRestore = null;

/**
 * Centralized, risk-free account switch pipeline:
 * 1. Mutex guard to prevent overlapping switches
 * 2. Preserves active conversation / project route so user never loses their chat view
 * 3. switchProfile(targetId) writes native credential storage & updates app_storage / vault
 * 4. Fast-path exit if target account is already active
 * 5. Early callback notification (onProfileSwitched) so HTTP clients get 200 OK
 * 6. Non-blocking LanguageServerService/Restart RPC to force daemon to load new credentials into memory
 * 7. Automatically restores saved route on new instance without blanking to /
 * 8. Always releases mutex in finally block
 */
export async function executeAccountSwitch(targetId, cdp, onProfileSwitched) {
  if (isSwitchingInProgress) {
    logger.warn('sidecar', `[SWITCH_REJECTED] Switch to ${targetId} rejected because another switch is in progress.`);
    throw new Error('A switch is already in progress. Please wait a moment.');
  }

  logger.info('sidecar', `[SWITCH_START] Switching to profile: ${targetId}`);
  isSwitchingInProgress = true;

  try {
    // Step 0: Capture active project & conversation route before any restarts
    if (cdp && cdp.isConnected) {
      try {
        const currentRoute = await cdp.evaluate('window.location.pathname + window.location.search + window.location.hash', true, 2000);
        if (currentRoute && currentRoute !== '/') {
          savedRouteToRestore = currentRoute;
          logger.info('sidecar', `[SWITCH_ROUTE] Preserving active conversation route: ${savedRouteToRestore}`);
        }
      } catch (err) {
        logger.warn('sidecar', `Could not capture active route: ${err.message}`);
      }
    }

    // Step 1: Write target credentials to system credential storage & update vault
    const switched = switchProfile(targetId);

    // Fast-path: Account is already active -> No restart or reload needed!
    if (switched.alreadyActive) {
      logger.info('sidecar', `[SWITCH_FASTPATH] Profile ${switched.email} is already active. Returning immediately.`);
      const result = { ok: true, alreadyActive: true, profile: switched };
      if (typeof onProfileSwitched === 'function') {
        try { onProfileSwitched(result); } catch {}
      }
      return result;
    }

    // Immediately notify caller that credentials have been written so HTTP connections
    // are completed cleanly before any process restarts or window reloads occur.
    if (typeof onProfileSwitched === 'function') {
      try { onProfileSwitched({ ok: true, profile: switched }); } catch {}
    }

    // Step 2: Restart Language Server to reload credentials into binary memory
    if (cdp && cdp.isConnected) {
      try {
        logger.info('sidecar', '[SWITCH_RESTART] Dispatching LanguageServer restart RPC to load new credentials');
        await cdp.evaluate(`(async () => {
          try {
            const port = window.location.port;
            const csrf = window.__APP_CONFIG__?.csrfToken || '';
            if (port) {
              const headers = {
                'Content-Type': 'application/json',
                'x-codeium-csrf-token': csrf
              };
              // Programmatically accept Terms of Service & skip onboarding
              try {
                await fetch('https://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/AcceptTermsOfService', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    metadata: { ide_name: 'antigravity', extension_name: 'antigravity', locale: 'en' },
                    version: '1.0'
                  })
                });
                await fetch('https://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/SkipOnboarding', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({})
                });
              } catch {}

              // Restart language_server daemon so it re-reads macOS Keychain with new credentials
              try {
                await fetch('https://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/Restart', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({}),
                  signal: AbortSignal.timeout(2000)
                });
              } catch (e) {
                console.warn('[switcher] Restart RPC caught:', e);
              }
            }
          } catch (e) {
            console.error('[switcher] Error in switch restart pipeline:', e);
          }
          // Note: We do NOT call window.location.reload() manually.
          // Antigravity Electron shell automatically reconnects to the new port,
          // and the sidecar seamlessly restores the saved conversation route.
        })()`, false, 2500);
      } catch (cdpErr) {
        logger.warn('sidecar', `CDP dispatch warning during restart: ${cdpErr.message}`);
      }
    } else {
      logger.warn('sidecar', '[SWITCH_NO_CDP] CDP bridge not connected, only credentials switched.');
    }

    return { ok: true, profile: switched };
  } finally {
    isSwitchingInProgress = false;
    logger.info('sidecar', '[SWITCH_COMPLETE] Switch lock released');
  }
}

async function main() {
  logger.info('sidecar', '==================================================');
  logger.info('sidecar', '🚀 Antigravity Account Switcher Sidecar Starting...');
  logger.info('sidecar', '==================================================');

  // 1. Initialize vault and sync active session
  try {
    initVault();
    syncActiveSession();
  } catch (err) {
    logger.error('sidecar', 'Error during initial vault/session sync', err);
  }

  // 2. Initialize CDP Bridge
  const cdp = new CdpBridge();
  const autoSwitcher = new AutoSwitcher(cdp);

  // 3. Start local HTTP API for in-DOM UI communication
  const server = http.createServer(async (req, res) => {
    // Enable CORS for localhost renderer
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    let body = {};
    if (req.method === 'POST') {
      try {
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        const text = Buffer.concat(buffers).toString('utf8');
        if (text) body = JSON.parse(text);
      } catch {}
    }

    try {
      if (pathname === '/logo.png' || pathname === '/assets/logo.png') {
        const p = path.join(__dirname, '..', '..', 'assets', 'logo.png');
        if (fs.existsSync(p)) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
          fs.createReadStream(p).pipe(res);
          return;
        }
      }

      if (pathname === '/logo.svg' || pathname === '/assets/logo.svg') {
        const p = path.join(__dirname, '..', '..', 'assets', 'logo.svg');
        if (fs.existsSync(p)) {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
          fs.createReadStream(p).pipe(res);
          return;
        }
      }

      if (pathname === '/api/accounts' && req.method === 'GET') {
        const summary = await getAllAccountsQuotaSummary(cdp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accounts: summary, autoSwitch: autoSwitcher.isEnabled }));
        return;
      }

      if (pathname === '/api/refresh' && req.method === 'POST') {
        try { syncActiveSession(); } catch (err) { logger.error('sidecar', 'Error during refresh sync', err); }
        const summary = await getAllAccountsQuotaSummary(cdp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accounts: summary, autoSwitch: autoSwitcher.isEnabled }));
        return;
      }

      if (pathname === '/api/logs' && req.method === 'GET') {
        const lines = parseInt(url.searchParams.get('lines') || '100', 10);
        const recent = logger.getRecentLogs(lines);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, logFile: logger.getLogFilePath(), logs: recent }));
        return;
      }

      if (pathname === '/api/toggle-auto-switch' && req.method === 'POST') {
        autoSwitcher.setEnabled(body.enabled);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, autoSwitch: autoSwitcher.isEnabled }));
        return;
      }

      if (pathname === '/api/switch' && req.method === 'POST') {
        const { id } = body;
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing account id' }));
          return;
        }

        try {
          let hasResponded = false;
          const sendResponse = (payload, statusCode = 200) => {
            if (!hasResponded) {
              hasResponded = true;
              res.writeHead(statusCode, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(payload));
            }
          };

          const result = await executeAccountSwitch(id, cdp, (earlyResult) => {
            sendResponse(earlyResult, 200);
          });
          sendResponse(result, 200);
        } catch (switchErr) {
          const statusCode = switchErr.message.includes('already in progress') ? 409 : 500;
          logger.error('sidecar', '[SWITCH_ERROR]', switchErr);
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: switchErr.message }));
        }
        return;
      }

      if (pathname === '/api/add-account' && req.method === 'POST') {
        logger.info('sidecar', 'User requested Add Account flow.');
        // 1. Snapshot current active session to ensure it is not lost
        snapshotCurrentSession();

        // 2. Instruct renderer to log out and show login page
        await cdp.evaluate(`(async () => {
          try {
            const csrf = window.__APP_CONFIG__?.csrfToken || '';
            const port = window.location.port;
            if (!port) return;
            await fetch('https://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/AuthLogout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
              body: JSON.stringify({})
            });
            window.location.reload();
          } catch (e) {
            console.error('Logout error:', e);
          }
        })()`, false, 4000);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Logged out. Please log in with the new account.' }));
        return;
      }

      if (pathname === '/api/delete-account' && req.method === 'POST') {
        const { id } = body;
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing account id' }));
          return;
        }

        try {
          removeProfile(id);
          logger.info('sidecar', `Account deleted: ${id}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (delErr) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: delErr.message }));
        }
        return;
      }

      if (pathname === '/api/rename-account' && req.method === 'POST') {
        const { id, label } = body;
        if (!id || !label) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing account id or label' }));
          return;
        }

        const updated = updateProfileLabel(id, label);
        if (!updated) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Account not found' }));
          return;
        }

        logger.info('sidecar', `Account ${id} renamed to "${label}"`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, profile: updated }));
        return;
      }

      if (pathname === '/api/check-update' && req.method === 'GET') {
        const force = url.searchParams.get('force') === 'true';
        const info = await checkForUpdates(force);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
        return;
      }

      // 404 fallback
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    } catch (err) {
      logger.error('sidecar', 'API error', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(PORT, HOST, () => {
    logger.info('sidecar', `Local API Server listening on http://${HOST}:${PORT}`);
  });

  // 4. Inject UI into renderer window
  async function injectUI() {
    try {
      const cssContent = fs.readFileSync(CSS_PATH, 'utf8');
      const uiJsContent = fs.readFileSync(UI_JS_PATH, 'utf8');

      // Inject UI Engine script
      await cdp.evaluate(uiJsContent, false, 5000);

      // Initialize UI Engine with styles
      const initExpr = `if (window.__AGY_SWITCHER__) { window.__AGY_SWITCHER__.init(${JSON.stringify(cssContent)}); }`;
      await cdp.evaluate(initExpr, false, 5000);

      logger.info('sidecar', 'Successfully injected Account Switcher UI into Antigravity sidebar.');
    } catch (err) {
      logger.error('sidecar', 'Failed to inject UI', err);
    }
  }

  async function restorePreservedRoute() {
    if (savedRouteToRestore && savedRouteToRestore !== '/') {
      const targetRoute = savedRouteToRestore;
      savedRouteToRestore = null;
      try {
        logger.info('sidecar', `Restoring preserved conversation route: ${targetRoute}`);
        await cdp.evaluate(`(() => {
          if (window.location.pathname + window.location.search === '/') {
            window.location.replace(window.location.origin + ${JSON.stringify(targetRoute)});
          }
        })()`, false, 2000);
      } catch (e) {
        logger.warn('sidecar', `Could not restore preserved route: ${e.message}`);
      }
    }
  }

  cdp.on('connected', async () => {
    // Wait briefly for DOM to be ready
    setTimeout(async () => {
      await restorePreservedRoute();
      await injectUI();
    }, 1200);
  });

  // Watch for page reloads to re-inject UI & sync active session
  let pageLoadDebounce = null;
  cdp.on('event', async (data) => {
    // Only listen for real Page.loadEventFired (never spam with Page.navigatedWithinDocument)
    if (data.method === 'Page.loadEventFired') {
      if (pageLoadDebounce) clearTimeout(pageLoadDebounce);
      pageLoadDebounce = setTimeout(async () => {
        logger.info('sidecar', 'Page loadEventFired detected. Restoring route, syncing session & injecting UI.');
        await restorePreservedRoute();
        try { syncActiveSession(); } catch {}
        await injectUI();
      }, 1000);
    }
  });

  // Watchdog: Ensure UI is injected even if page loaded before connection
  setInterval(async () => {
    if (cdp.isConnected && !isSwitchingInProgress) {
      try {
        const injected = await cdp.evaluate('!!document.getElementById("agy-avatar-trigger-btn")', true, 2000);
        if (!injected) {
          await injectUI();
        }
      } catch {}
    }
  }, 4000);

  // Connect CDP
  await cdp.connect();
}

// Only run main() when not under test harness
if (!process.env.NODE_TEST_CONTEXT && !process.argv.some(a => a.includes('test'))) {
  main().catch(err => {
    logger.error('sidecar', 'Fatal error', err);
    process.exit(1);
  });
}
