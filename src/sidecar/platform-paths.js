import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * Returns the path to Antigravity's DevToolsActivePort file across Windows, macOS, and Linux (Fedora/Ubuntu/etc.).
 * @returns {string} Path to DevToolsActivePort
 */
export function getDevToolsPortPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }

  if (process.platform === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const candidates = [
      path.join(configHome, 'Antigravity', 'DevToolsActivePort'),
      path.join(configHome, 'antigravity', 'DevToolsActivePort'),
      path.join(os.homedir(), '.gemini', 'antigravity', 'DevToolsActivePort')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return candidates[0];
  }

  // Windows fallback
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Antigravity',
    'DevToolsActivePort'
  );
}

/**
 * Returns the path to Antigravity's app_storage.json metadata file across all platforms.
 * @returns {string} Path to app_storage.json
 */
export function getAppStoragePath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'app_storage.json');
  }

  if (process.platform === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const candidates = [
      path.join(configHome, 'Antigravity', 'app_storage.json'),
      path.join(configHome, 'antigravity', 'app_storage.json'),
      path.join(os.homedir(), '.gemini', 'antigravity', 'app_storage.json')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return candidates[0];
  }

  // Windows fallback
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Antigravity',
    'app_storage.json'
  );
}

/**
 * Returns the path to antigravity-cli config/data directory.
 * @returns {string} Path to antigravity-cli directory
 */
export function getAgyCliDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Returns the path to the global plugin directory for antigravity-account-switcher.
 * @returns {string} Path to plugin directory
 */
export function getPluginDir() {
  return path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-account-switcher');
}

/**
 * Returns the path to the switcher vault directory.
 * @returns {string} Path to vault directory
 */
export function getVaultDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity-switcher', 'vault');
}
