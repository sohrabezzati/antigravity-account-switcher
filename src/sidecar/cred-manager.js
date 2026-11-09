import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PS1_PATH = path.join(__dirname, 'wincred.ps1');

const TARGET_NAME = 'LegacyGeneric:target=gemini:antigravity';
const KEYRING_SERVICE = 'gemini';
const KEYRING_ACCOUNT = 'antigravity';

/**
 * Returns headless fallback credential file path for Linux/environments without keyring.
 */
function getLinuxFallbackFilePath() {
  const dir = path.join(os.homedir(), '.gemini', 'antigravity');
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  }
  return path.join(dir, 'credentials.json');
}

/**
 * Decodes keyring payload (handles both go-keyring-base64 prefix and raw JSON).
 * @param {string} raw 
 * @returns {object|null}
 */
function parseKeyringPayload(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  try {
    let b64 = trimmed;
    if (trimmed.startsWith('go-keyring-base64:')) {
      b64 = trimmed.slice('go-keyring-base64:'.length);
    }
    const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
}

/**
 * Encodes credential object into go-keyring-base64 payload format.
 * @param {object|string} credentialObj 
 * @returns {string}
 */
function formatKeyringPayload(credentialObj) {
  const rawJson = typeof credentialObj === 'string' ? credentialObj : JSON.stringify(credentialObj);
  const b64 = Buffer.from(rawJson, 'utf8').toString('base64');
  return 'go-keyring-base64:' + b64;
}

/**
 * Reads active Antigravity OAuth session from native system storage:
 * - macOS: macOS Keychain (service=gemini, account=antigravity)
 * - Linux (Fedora/Ubuntu): secret-tool, python3 keyring, or fallback credentials.json
 * - Windows: Windows Credential Manager via PowerShell wincred.ps1
 * 
 * @returns {object|null} Parsed credential object or null
 */
export function readActiveCredential() {
  // 1. macOS (Darwin)
  if (process.platform === 'darwin') {
    try {
      const output = execSync(`security find-generic-password -s "${KEYRING_SERVICE}" -a "${KEYRING_ACCOUNT}" -w`, {
        encoding: 'utf8',
        timeout: 10000
      }).trim();
      const parsed = parseKeyringPayload(output);
      if (parsed) {
        logger.debug('cred-manager', `Active credential read from macOS Keychain: ${parsed.id_token_email || 'unknown'}`);
        return parsed;
      }
    } catch (err) {
      logger.error('cred-manager', 'Error reading active credential from macOS Keychain', err);
      return null;
    }
  }

  // 2. Linux (Fedora, RHEL, Ubuntu, Arch, etc.)
  if (process.platform === 'linux') {
    // Attempt A: secret-tool (libsecret / GNOME Keyring / KWallet via DBus)
    try {
      const output = execSync(`secret-tool lookup service "${KEYRING_SERVICE}" account "${KEYRING_ACCOUNT}" 2>/dev/null`, {
        encoding: 'utf8',
        timeout: 6000
      }).trim();
      const parsed = parseKeyringPayload(output);
      if (parsed) {
        logger.debug('cred-manager', `Active credential read from Linux Secret Service (secret-tool): ${parsed.id_token_email || 'unknown'}`);
        return parsed;
      }
    } catch {}

    // Attempt B: python3 -m keyring fallback
    try {
      const pyCmd = `python3 -c "import keyring; val = keyring.get_password('${KEYRING_SERVICE}', '${KEYRING_ACCOUNT}'); print(val if val else '')" 2>/dev/null`;
      const output = execSync(pyCmd, { encoding: 'utf8', timeout: 6000 }).trim();
      const parsed = parseKeyringPayload(output);
      if (parsed) {
        logger.debug('cred-manager', `Active credential read from Linux python keyring: ${parsed.id_token_email || 'unknown'}`);
        return parsed;
      }
    } catch {}

    // Attempt C: Headless / Docker file fallback
    const fallbackPath = getLinuxFallbackFilePath();
    if (fs.existsSync(fallbackPath)) {
      try {
        const content = fs.readFileSync(fallbackPath, 'utf8');
        const parsed = parseKeyringPayload(content);
        if (parsed) {
          logger.debug('cred-manager', `Active credential read from Linux fallback file: ${parsed.id_token_email || 'unknown'}`);
          return parsed;
        }
      } catch (err) {
        logger.error('cred-manager', 'Error reading Linux fallback credential file', err);
      }
    }

    logger.warn('cred-manager', 'Linux active credential not found in secret-tool, python keyring, or fallback file.');
    return null;
  }

  // 3. Windows
  try {
    const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${PS1_PATH}" -Action read -Target "${TARGET_NAME}"`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();

    if (!output) return null;
    const jsonStr = Buffer.from(output, 'base64').toString('utf8');
    const parsed = JSON.parse(jsonStr);
    logger.debug('cred-manager', `Active credential read from Windows Credential Manager: ${parsed?.id_token_email || 'unknown'}`);
    return parsed;
  } catch (err) {
    logger.error('cred-manager', 'Error reading active credential from Windows Credential Manager', err);
    return null;
  }
}

/**
 * Writes an OAuth session into native system storage:
 * - macOS: macOS Keychain
 * - Linux (Fedora/Ubuntu): secret-tool, python3 keyring, or fallback credentials.json
 * - Windows: Windows Credential Manager
 * 
 * @param {object|string} credentialObj - The session JSON object or string
 * @param {string} userName - The username/email associated with the credential
 * @returns {boolean} True if successfully written
 */
export function writeActiveCredential(credentialObj, userName = 'antigravity') {
  // 1. macOS (Darwin)
  if (process.platform === 'darwin') {
    try {
      const payload = formatKeyringPayload(credentialObj);
      execSync(`security add-generic-password -U -s "${KEYRING_SERVICE}" -a "${KEYRING_ACCOUNT}" -w "${payload}"`, {
        encoding: 'utf8',
        timeout: 10000
      });
      logger.info('cred-manager', `Wrote active credential to macOS Keychain for ${userName}: success=true`);
      return true;
    } catch (err) {
      logger.error('cred-manager', 'Error writing active credential to macOS Keychain', err);
      return false;
    }
  }

  // 2. Linux (Fedora, RHEL, Ubuntu, Arch, etc.)
  if (process.platform === 'linux') {
    const payload = formatKeyringPayload(credentialObj);
    let written = false;

    // Attempt A: secret-tool
    try {
      execSync(`printf "%s" "${payload}" | secret-tool store --label="gemini" service "${KEYRING_SERVICE}" account "${KEYRING_ACCOUNT}" 2>/dev/null`, {
        encoding: 'utf8',
        timeout: 6000
      });
      written = true;
      logger.info('cred-manager', `Wrote active credential to Linux Secret Service (secret-tool) for ${userName}`);
    } catch {}

    // Attempt B: python3 keyring
    if (!written) {
      try {
        const pyScript = `import sys, keyring; keyring.set_password('${KEYRING_SERVICE}', '${KEYRING_ACCOUNT}', sys.stdin.read().strip())`;
        execSync(`printf "%s" "${payload}" | python3 -c "${pyScript}" 2>/dev/null`, {
          encoding: 'utf8',
          timeout: 6000
        });
        written = true;
        logger.info('cred-manager', `Wrote active credential via python keyring for ${userName}`);
      } catch {}
    }

    // Always mirror to fallback file with 0600 permissions for headless/CLI resilience
    try {
      const fallbackPath = getLinuxFallbackFilePath();
      const rawJson = typeof credentialObj === 'string' ? credentialObj : JSON.stringify(credentialObj, null, 2);
      fs.writeFileSync(fallbackPath, rawJson, { encoding: 'utf8', mode: 0o600 });
      written = true;
      logger.info('cred-manager', `Saved active credential to Linux fallback file (${fallbackPath})`);
    } catch (e) {
      logger.warn('cred-manager', `Failed to write Linux fallback file: ${e.message}`);
    }

    return written;
  }

  // 3. Windows
  try {
    const rawJson = typeof credentialObj === 'string' ? credentialObj : JSON.stringify(credentialObj);
    const b64 = Buffer.from(rawJson, 'utf8').toString('base64');
    const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${PS1_PATH}" -Action write -Target "${TARGET_NAME}" -UserName "${userName}" -Base64Payload "${b64}"`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();

    const ok = output.toLowerCase().includes('true');
    logger.info('cred-manager', `Wrote active credential to Windows Credential Manager for ${userName}: success=${ok}`);
    return ok;
  } catch (err) {
    logger.error('cred-manager', 'Error writing active credential to Windows Credential Manager', err);
    return false;
  }
}
