#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { listProfiles, switchProfile, snapshotCurrentSession } from '../src/sidecar/vault-manager.js';
import { getAllAccountsQuotaSummary } from '../src/sidecar/quota-poller.js';
import { checkForUpdates, compareSemver, getCurrentVersion } from '../src/sidecar/update-checker.js';
import { install, triggerLiveReload, getInstalledVersion } from '../scripts/install-plugin.js';
import { readActiveCredential } from '../src/sidecar/cred-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const command = args[0];

function makeAsciiBar(pct, width = 14) {
  const safePct = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((safePct / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Retrieves freshest live accounts list (queries sidecar API first if online, else falls back to local poller).
 */
async function getAccountsLive() {
  try {
    const res = await fetch('http://127.0.0.1:51444/api/accounts', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      if (data.accounts && data.accounts.length > 0) {
        return data.accounts;
      }
    }
  } catch {}
  return await getAllAccountsQuotaSummary();
}

/**
 * Prints the live three-model quota summary (Gemini, Claude/GPT, Argon) for an account.
 */
function printThreeModelQuotas(active) {
  if (!active) return;
  const g = active.modelQuotas?.gemini || { fiveHourPercent: active.fiveHourPercent ?? 100, weeklyPercent: active.weeklyPercent ?? 100 };
  const c = active.modelQuotas?.claudeGpt || { fiveHourPercent: 100, weeklyPercent: 100 };
  const ar = active.modelQuotas?.argon || { weeklyPercent: 100 };

  console.log('\n📊 Live Model Quotas:');
  console.log(`  🔷 Gemini (Flash / Pro):    [${makeAsciiBar(g.fiveHourPercent)}] 5H: ${String(g.fiveHourPercent).padStart(3)}%  |  [${makeAsciiBar(g.weeklyPercent)}] Weekly: ${String(g.weeklyPercent).padStart(3)}% (${g.weeklyCountdownText || 'Active'})`);
  console.log(`  🟣 Claude & GPT 3rd-Party:  [${makeAsciiBar(c.fiveHourPercent ?? 100)}] 5H: ${String(c.fiveHourPercent ?? 100).padStart(3)}%  |  [${makeAsciiBar(c.weeklyPercent)}] Weekly: ${String(c.weeklyPercent).padStart(3)}% (${c.weeklyCountdownText || 'Active'})`);
  console.log(`  ⚡ Gemini 4 Argon:          [${makeAsciiBar(ar.weeklyPercent)}] Weekly: ${String(ar.weeklyPercent).padStart(3)}% (${ar.weeklyCountdownText || 'Active'})`);
}

/**
 * Zero-config smart runner:
 * - If not installed -> installs automatically and hot-reloads Antigravity.
 * - If installed & outdated -> updates automatically and hot-reloads Antigravity.
 * - If installed & up-to-date -> displays live multi-model quotas and confirms status.
 */
async function dispatchSmart() {
  const currentCliVer = getCurrentVersion();
  const installedVer = getInstalledVersion();

  console.log(`\n🪐 Antigravity Account Switcher (v${currentCliVer})`);
  console.log('────────────────────────────────────────────────────────────────────────');

  if (!installedVer) {
    console.log('📦 Plugin is not installed yet. Installing into Antigravity...');
    await install();
    console.log(`\n✅ Installed successfully (v${currentCliVer})!`);
    console.log('💡 Open Antigravity to see your new Account Switcher in the sidebar.\n');
    process.exit(0);
  }

  const comparison = compareSemver(currentCliVer, installedVer);
  if (comparison > 0) {
    console.log(`⚡ Updating plugin: v${installedVer} ➔ v${currentCliVer}...`);
    await install();
    console.log(`\n🎉 Successfully updated to v${currentCliVer}!`);
    console.log('⚡ Live hot-reload triggered directly in Antigravity.\n');
    process.exit(0);
  }

  const accounts = await getAccountsLive();
  const active = accounts.find(a => a.isActive) || accounts[0];

  console.log(`Active Account: ${active ? `${active.label} (${active.email}) [Plan: ${active.plan || 'Free'}]` : 'None'}`);
  printThreeModelQuotas(active);

  console.log('\n💡 Quick commands:');
  console.log('  • antigravity-account-switcher list     (Table view of all vault accounts)');
  console.log('  • antigravity-account-switcher quota    (Detailed ASCII meters by model)');
  console.log('  • antigravity-account-switcher switch   (Switch active account)');
  console.log('────────────────────────────────────────────────────────────────────────\n');
  process.exit(0);
}

async function run() {
  if (!command || command === 'run' || command === 'install' || command === 'update') {
    await dispatchSmart();
    return;
  }

  switch (command) {
    case 'start':
      console.log('🚀 Starting Antigravity Account Switcher Sidecar...');
      await import('../src/sidecar/index.js');
      break;

    case 'uninstall': {
      console.log('🗑️ Uninstalling Antigravity Account Switcher plugin...');
      await import('../scripts/uninstall-plugin.js');
      break;
    }

    case 'status': {
      console.log('\n=================== Antigravity Switcher Status ===================');
      try {
        const updateInfo = await checkForUpdates(true);
        console.log(`Version:        v${updateInfo.currentVersion}`);
        if (updateInfo.hasUpdate) {
          console.log(`📢 Update:      v${updateInfo.latestVersion} AVAILABLE! (Run: ${updateInfo.updateCommand})`);
        } else {
          console.log(`Latest Release: Up-to-date (v${updateInfo.latestVersion})`);
        }
      } catch {}

      // Test local sidecar connection
      let sidecarOnline = false;
      try {
        const res = await fetch('http://127.0.0.1:51444/api/accounts', { signal: AbortSignal.timeout(1500) });
        if (res.ok) sidecarOnline = true;
      } catch {}

      console.log(`Platform:       ${process.platform} (${process.arch})`);
      console.log(`Sidecar Server: ${sidecarOnline ? '🟢 ONLINE (Port 51444)' : '⚪ OFFLINE'}`);

      const accounts = await getAccountsLive();
      console.log(`Vault Accounts: ${accounts.length} registered`);
      const active = accounts.find(p => p.isActive);
      if (active) {
        console.log(`Active Account: ${active.label} (${active.email}) [${active.plan || 'Pro'}]`);
        printThreeModelQuotas(active);
      }
      console.log('===================================================================\n');
      return;
    }

    case 'logs': {
      const { logger } = await import('../src/sidecar/logger.js');
      const lines = parseInt(args[1] || '60', 10);
      console.log(`\n📜 Antigravity Switcher Logs (Last ${lines} lines) [${logger.getLogFilePath()}]:`);
      console.log('───────────────────────────────────────────────────────────────────');
      const logs = logger.getRecentLogs(lines);
      if (logs.length === 0) {
        console.log('No log entries found yet.');
      } else {
        logs.forEach(l => console.log(l));
      }
      console.log('───────────────────────────────────────────────────────────────────\n');
      process.exit(0);
      break;
    }

    case 'check-update': {
      console.log('🔍 Checking for latest releases...');
      const info = await checkForUpdates(true);
      console.log(`Current version: v${info.currentVersion}`);
      console.log(`Latest version:  v${info.latestVersion}`);
      if (info.hasUpdate) {
        console.log(`\n🎉 New update available: v${info.latestVersion}`);
        console.log(`Run: ${info.updateCommand}\n`);
      } else {
        console.log('\n✅ You are running the latest version.\n');
      }
      process.exit(0);
      break;
    }

    case 'list': {
      const accounts = await getAccountsLive();
      console.log('\n====================================== Antigravity Accounts ======================================');
      console.table(accounts.map(a => {
        const g = a.modelQuotas?.gemini || {};
        const c = a.modelQuotas?.claudeGpt || {};
        const ar = a.modelQuotas?.argon || {};
        const gemini5h = g.fiveHourPercent ?? a.fiveHourPercent ?? 100;
        const geminiWk = g.weeklyPercent ?? a.weeklyPercent ?? 100;
        const claude5h = c.fiveHourPercent ?? 100;
        const claudeWk = c.weeklyPercent ?? 100;
        const argonWk = ar.weeklyPercent ?? 100;

        return {
          ID: a.id,
          Label: a.label,
          Email: a.email,
          Plan: a.plan,
          'Gemini (5h/Wk)': `${gemini5h}% / ${geminiWk}%`,
          'Claude & GPT (5h/Wk)': `${claude5h}% / ${claudeWk}%`,
          'Argon (Wk)': `${argonWk}%`,
          Status: a.isActive ? 'ACTIVE' : a.status.toUpperCase(),
          Reset: a.fiveHourCountdownText || a.resetCountdownText
        };
      }));
      console.log('==================================================================================================\n');
      process.exit(0);
      break;
    }

    case 'quota':
    case 'quotas': {
      const accounts = await getAccountsLive();
      const active = accounts.find(a => a.isActive) || accounts[0];

      if (!active) {
        console.log('No registered accounts in vault. Use "antigravity-account-switcher snapshot" to add current session.');
        process.exit(0);
      }

      const g = active.modelQuotas?.gemini || { fiveHourPercent: active.fiveHourPercent ?? 100, weeklyPercent: active.weeklyPercent ?? 100 };
      const c = active.modelQuotas?.claudeGpt || { fiveHourPercent: 100, weeklyPercent: 100 };
      const ar = active.modelQuotas?.argon || { weeklyPercent: 100 };

      console.log('\n====================== Active Account Live Quotas ======================');
      console.log(`Account: ${active.label} (${active.email}) [Plan: ${active.plan || 'Free'}]`);
      console.log('────────────────────────────────────────────────────────────────────────');

      console.log('\n🔷 GEMINI MODELS (Gemini 2.5 Flash, Gemini 2.5 Pro)');
      console.log(`  • 5-Hour Session: [${makeAsciiBar(g.fiveHourPercent, 20)}] ${String(g.fiveHourPercent).padStart(3)}%  (${g.fiveHourCountdownText || active.fiveHourCountdownText || 'Ready'})`);
      console.log(`  • Weekly Pool:    [${makeAsciiBar(g.weeklyPercent, 20)}] ${String(g.weeklyPercent).padStart(3)}%  (${g.weeklyCountdownText || active.weeklyCountdownText || 'Active'})`);

      console.log('\n🟣 CLAUDE & GPT MODELS (Claude 3.7 Sonnet, Claude 3.5 Opus, GPT-OSS)');
      console.log(`  • 5-Hour Session: [${makeAsciiBar(c.fiveHourPercent ?? 100, 20)}] ${String(c.fiveHourPercent ?? 100).padStart(3)}%  (${c.fiveHourCountdownText || 'Ready'})`);
      console.log(`  • Weekly Pool:    [${makeAsciiBar(c.weeklyPercent, 20)}] ${String(c.weeklyPercent).padStart(3)}%  (${c.weeklyCountdownText || 'Active'})`);

      console.log('\n⚡ GEMINI 4 ARGON (Dedicated Deep Reasoning WTU)');
      console.log(`  • Weekly Limit:   [${makeAsciiBar(ar.weeklyPercent, 20)}] ${String(ar.weeklyPercent).padStart(3)}%  (${ar.weeklyCountdownText || 'Active'})`);
      if (ar.fiveHourPercent !== undefined && ar.fiveHourPercent < 100) {
        console.log(`  • 5-Hour Limit:   [${makeAsciiBar(ar.fiveHourPercent, 20)}] ${String(ar.fiveHourPercent).padStart(3)}%  (${ar.fiveHourCountdownText || 'Ready'})`);
      }

      console.log('\n========================================================================\n');
      process.exit(0);
      break;
    }

    case 'cli':
    case 'agy': {
      console.log('\n=================== Antigravity CLI (agy) Integration ===================');
      const { execSync } = await import('child_process');
      let agyPath = null;
      try {
        const which = execSync('which agy 2>/dev/null || true', { encoding: 'utf8' }).trim();
        if (which) agyPath = which;
      } catch {}

      if (!agyPath) {
        const def = path.join(os.homedir(), '.gemini', 'bin', 'agy');
        if (fs.existsSync(def)) agyPath = def;
      }

      const activeCred = readActiveCredential();
      console.log(`CLI Binary:     ${agyPath || 'Not found in PATH'}`);
      console.log(`Active Account: ${activeCred?.id_token_email || 'Not logged in'}`);
      console.log(`Keyring Target: gemini:antigravity (OS: ${process.platform})`);

      let isRunning = false;
      try {
        const ps = execSync('pgrep -fl "agy" 2>/dev/null || true', { encoding: 'utf8' }).trim();
        isRunning = ps.includes('agy');
      } catch {}

      console.log(`Running Daemon: ${isRunning ? '🟢 Active background agy process detected' : '⚪ Idle'}`);
      console.log('\n💡 Tip: When you run "switch <id>", the credential vault automatically');
      console.log('updates the native keyring, allowing agy to immediately use the switched account.');
      console.log('=========================================================================\n');
      process.exit(0);
      break;
    }

    case 'switch': {
      const target = args[1];
      if (!target) {
        console.error('Usage: antigravity-switcher switch <account-id-or-email>');
        process.exit(1);
      }
      const profiles = listProfiles();
      const match = profiles.find(p => p.id === target || (p.email && p.email.toLowerCase() === target.toLowerCase()));
      if (!match) {
        console.error(`Error: No account found matching "${target}"`);
        process.exit(1);
      }

      // If sidecar is online, dispatch POST /api/switch for live Language Server restart and window reload
      let sidecarHandled = false;
      try {
        const sidecarRes = await fetch('http://127.0.0.1:51444/api/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: match.id }),
          signal: AbortSignal.timeout(15000)
        });

        sidecarHandled = true;
        const data = await sidecarRes.json().catch(() => ({}));

        if (sidecarRes.ok) {
          if (data.alreadyActive) {
            console.log(`Account ${match.label} (${match.email}) is already active.`);
          } else {
            console.log(`Successfully switched active account to ${match.label} (${match.email}) via Sidecar (Language Server restarted & window reloaded).`);
          }
          return;
        } else {
          console.error(`Error: Switch failed on sidecar: ${data.error || sidecarRes.statusText}`);
          process.exit(1);
        }
      } catch (err) {
        if (sidecarHandled) {
          console.error(`Error: Switch failed on sidecar: ${err.message}`);
          process.exit(1);
        }
      }

      // Fallback only if sidecar is truly offline
      const res = switchProfile(match.id);
      if (res.alreadyActive) {
        console.log(`Account ${match.label} (${match.email}) is already active.`);
      } else {
        console.log(`Switched active account to ${match.label} (${match.email}) in vault (Sidecar offline; restart Antigravity/agy to apply).`);
      }
      return;
    }

    case 'snapshot': {
      const label = args[1] || 'Saved Account';
      const snap = snapshotCurrentSession(label);
      console.log(`Snapshot saved: ${snap.label} (${snap.email})`);
      process.exit(0);
      break;
    }

    case '--help':
    case '-h':
    case 'help':
    default:
      console.log(`
Antigravity Account Switcher CLI (Cross-Platform: Windows, macOS, Linux/Fedora)

Zero-Config Usage:
  antigravity-account-switcher                  Shows active account & live multi-model quotas

Subcommands:
  antigravity-account-switcher list             Display all accounts with Gemini, Claude/GPT, and Argon quotas
  antigravity-account-switcher quota            Detailed ASCII meter breakdown by model family
  antigravity-account-switcher status           Check daemon status & live model quotas
  antigravity-account-switcher switch <id>      Switch active Google account
  antigravity-account-switcher snapshot         Save current Google session to vault
  antigravity-account-switcher agy              Inspect antigravity-cli integration status
  antigravity-account-switcher check-update     Check if newer release exists
  antigravity-account-switcher start            Start background sidecar server
  antigravity-account-switcher uninstall        Uninstall plugin from Antigravity
`);
      process.exit(0);
  }
}

run().catch(err => {
  console.error('Error running CLI:', err.message);
  process.exit(1);
});
