import fs from 'fs';
import path from 'path';
import os from 'os';
import { readActiveCredential, writeActiveCredential } from './cred-manager.js';
import { getAppStoragePath, getVaultDir } from './platform-paths.js';
import { logger } from './logger.js';

const VAULT_DIR = getVaultDir();
const PROFILES_INDEX = path.join(VAULT_DIR, 'profiles.json');
const SESSIONS_DIR = path.join(VAULT_DIR, 'sessions');

/**
 * Initializes the Vault directory and registers the current active account if empty.
 */
export function initVault() {
  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  let index = [];
  if (fs.existsSync(PROFILES_INDEX)) {
    try {
      index = JSON.parse(fs.readFileSync(PROFILES_INDEX, 'utf8'));
    } catch {
      index = [];
    }
  }

  // If vault is completely empty, automatically capture current active account
  if (index.length === 0) {
    const cred = readActiveCredential();
    const activeEmail = cred?.id_token_email || getActiveEmailFromAppStorage() || 'primary@google.com';
    const initialId = 'acc_' + Date.now();
    const profile = {
      id: initialId,
      label: activeEmail,
      email: activeEmail,
      plan: 'Free',
      isActive: true,
      lastQuota: 1.0,
      resetTime: null,
      fiveHourQuota: 1.0,
      weeklyQuota: 1.0,
      fiveHourResetTime: null,
      weeklyResetTime: null,
      modelQuotas: {
        gemini: { fiveHourPercent: 100, weeklyPercent: 100, fiveHourCountdownText: 'Refreshed', weeklyCountdownText: 'Refreshed' },
        claudeGpt: { fiveHourPercent: 100, weeklyPercent: 100, fiveHourCountdownText: 'Refreshed', weeklyCountdownText: 'Refreshed' },
        argon: { weeklyPercent: 100, weeklyCountdownText: 'Refreshed' }
      },
      addedAt: new Date().toISOString()
    };
    
    if (cred) {
      fs.writeFileSync(path.join(SESSIONS_DIR, `${initialId}.json`), JSON.stringify(cred, null, 2), 'utf8');
    }
    index.push(profile);
    fs.writeFileSync(PROFILES_INDEX, JSON.stringify(index, null, 2), 'utf8');
  }

  return index;
}

/**
 * Reads user email from app_storage.json as fallback.
 */
function getActiveEmailFromAppStorage() {
  const appStoragePath = getAppStoragePath();
  if (!fs.existsSync(appStoragePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
    return data['jetski.onboarding.lastLoginUsername'] || null;
  } catch {
    return null;
  }
}

/**
 * Updates user email in app_storage.json upon switch.
 */
function updateAppStorageEmail(email) {
  const appStoragePath = getAppStoragePath();
  if (!fs.existsSync(appStoragePath) || !email) return false;
  try {
    const data = JSON.parse(fs.readFileSync(appStoragePath, 'utf8'));
    data['jetski.onboarding.lastLoginUsername'] = email;
    fs.writeFileSync(appStoragePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    logger.warn('vault-manager', `Error updating app_storage.json: ${err.message}`);
    return false;
  }
}

/**
 * Automatically synchronizes the currently active system session with the vault:
 * 1. If active credential exists and is NOT in profiles.json, adds it as a new profile and saves its session.
 * 2. If it is already in profiles.json, ensures isActive=true and updates its session file with latest tokens.
 */
export function syncActiveSession() {
  initVault();
  const cred = readActiveCredential();
  if (!cred || !cred.token) return listProfilesDirect();

  const activeEmail = (cred.id_token_email || getActiveEmailFromAppStorage() || '').trim();
  if (!activeEmail) return listProfilesDirect();

  let index = [];
  try {
    index = JSON.parse(fs.readFileSync(PROFILES_INDEX, 'utf8'));
  } catch {
    index = [];
  }

  const existingIndex = index.findIndex(p => p.email && p.email.toLowerCase() === activeEmail.toLowerCase());

  if (existingIndex !== -1) {
    const existing = index[existingIndex];
    // Save fresh tokens to session file
    try {
      fs.writeFileSync(path.join(SESSIONS_DIR, `${existing.id}.json`), JSON.stringify(cred, null, 2), 'utf8');
    } catch {}

    // Ensure active flag is accurate
    let changed = false;
    index.forEach(p => {
      const shouldBeActive = (p.id === existing.id);
      if (p.isActive !== shouldBeActive) {
        p.isActive = shouldBeActive;
        changed = true;
      }
    });

    if (changed) {
      fs.writeFileSync(PROFILES_INDEX, JSON.stringify(index, null, 2), 'utf8');
    }
  } else {
    // New account logged into Antigravity!
    logger.info('vault-manager', `New active account detected: ${activeEmail}. Registering into vault.`);
    const newId = 'acc_' + Date.now();
    const newProfile = {
      id: newId,
      label: activeEmail,
      email: activeEmail,
      plan: 'Free',
      isActive: true,
      lastQuota: 1.0,
      resetTime: null,
      fiveHourQuota: 1.0,
      weeklyQuota: 1.0,
      fiveHourResetTime: null,
      weeklyResetTime: null,
      modelQuotas: {
        gemini: { fiveHourPercent: 100, weeklyPercent: 100, fiveHourCountdownText: 'Refreshed', weeklyCountdownText: 'Refreshed' },
        claudeGpt: { fiveHourPercent: 100, weeklyPercent: 100, fiveHourCountdownText: 'Refreshed', weeklyCountdownText: 'Refreshed' },
        argon: { weeklyPercent: 100, weeklyCountdownText: 'Refreshed' }
      },
      addedAt: new Date().toISOString()
    };

    index.forEach(p => { p.isActive = false; });
    index.push(newProfile);

    try {
      fs.writeFileSync(path.join(SESSIONS_DIR, `${newId}.json`), JSON.stringify(cred, null, 2), 'utf8');
      fs.writeFileSync(PROFILES_INDEX, JSON.stringify(index, null, 2), 'utf8');
      logger.info('vault-manager', `Successfully saved new account ${newId} (${activeEmail})`);
    } catch (err) {
      logger.error('vault-manager', `Error registering new account: ${err.message}`);
    }
  }

  return index;
}

/**
 * Direct file read of profiles index without sync loop.
 */
export function listProfilesDirect() {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_INDEX, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Lists all profiles with their active state and quotas.
 */
export function listProfiles() {
  initVault();
  return listProfilesDirect();
}

/**
 * Captures current active session into vault as a new profile or updates existing.
 */
export function snapshotCurrentSession(label) {
  initVault();
  const cred = readActiveCredential();
  if (!cred) {
    throw new Error('No active Google session found in system credential storage.');
  }

  const email = cred.id_token_email || getActiveEmailFromAppStorage() || 'account@google.com';
  let index = listProfiles();

  // Check if profile with this email already exists
  let profile = index.find(p => p.email.toLowerCase() === email.toLowerCase());
  const id = profile ? profile.id : 'acc_' + Date.now();

  if (!profile) {
    profile = {
      id,
      label: email,
      email,
      plan: 'Free',
      isActive: true,
      lastQuota: 1.0,
      resetTime: null,
      fiveHourQuota: 1.0,
      weeklyQuota: 1.0,
      fiveHourResetTime: null,
      weeklyResetTime: null,
      addedAt: new Date().toISOString()
    };
    // Mark others as inactive
    index.forEach(p => p.isActive = false);
    index.push(profile);
  } else {
    if (label) profile.label = label;
    profile.isActive = true;
    index.forEach(p => { if (p.id !== id) p.isActive = false; });
  }

  fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify(cred, null, 2), 'utf8');
  fs.writeFileSync(PROFILES_INDEX, JSON.stringify(index, null, 2), 'utf8');

  return profile;
}

/**
 * Updates profile metadata (e.g. quota, resetTime, plan, session status, separate model quotas).
 */
export function updateProfileQuota(
  email,
  quotaFraction,
  resetTime,
  planName,
  profilePictureUrl,
  name,
  weeklyQuota,
  weeklyResetTime,
  fiveHourDesc,
  weeklyDesc,
  needsRelogin,
  modelQuotas
) {
  let index = listProfiles();
  let changed = false;

  let target = index.find(p => p.email && p.email.toLowerCase() === email.toLowerCase());
  if (!target) {
    const newId = 'acc_' + Date.now();
    target = {
      id: newId,
      label: email,
      email: email,
      plan: planName || 'Free',
      isActive: true,
      lastQuota: quotaFraction ?? 1.0,
      resetTime: resetTime || null,
      fiveHourQuota: quotaFraction ?? 1.0,
      weeklyQuota: weeklyQuota ?? 1.0,
      addedAt: new Date().toISOString()
    };
    index.forEach(p => { p.isActive = false; });
    index.push(target);
    changed = true;
  }

  for (const p of index) {
    if (p.email.toLowerCase() === email.toLowerCase()) {
      if (typeof quotaFraction === 'number') {
        p.lastQuota = quotaFraction;
        p.fiveHourQuota = quotaFraction;
      }
      if (resetTime !== undefined) {
        p.resetTime = resetTime;
        p.fiveHourResetTime = resetTime;
      }
      if (typeof weeklyQuota === 'number') {
        p.weeklyQuota = weeklyQuota;
      }
      if (weeklyResetTime !== undefined) {
        p.weeklyResetTime = weeklyResetTime;
      }
      if (fiveHourDesc !== undefined) {
        p.fiveHourDesc = fiveHourDesc;
      }
      if (weeklyDesc !== undefined) {
        p.weeklyDesc = weeklyDesc;
      }
      if (planName) p.plan = planName;
      if (profilePictureUrl) p.profilePictureUrl = profilePictureUrl;
      if (name) p.name = name;
      if (needsRelogin !== undefined) p.needsRelogin = !!needsRelogin;
      if (modelQuotas !== undefined) p.modelQuotas = modelQuotas;
      p.lastQuotaCheck = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(PROFILES_INDEX, JSON.stringify(index, null, 2), 'utf8');
  }
  return index;
}

/**
 * Updates an account's user-facing label.
 */
export function updateProfileLabel(id, newLabel) {
  let index = listProfiles();
  const profile = index.find(p => p.id === id);
  if (!profile) return false;
  profile.label = newLabel.trim() || profile.label;
  fs.writeFileSync(PROFILES_INDEX, JSON.stringify(index, null, 2), 'utf8');
  return profile;
}

/**
 * Performs atomic switch to target profile.
 * Writes credentials, updates app_storage, updates active flag.
 */
export function switchProfile(targetId) {
  initVault();
  let index = listProfiles();
  const targetProfile = index.find(p => p.id === targetId);

  if (!targetProfile) {
    throw new Error(`Profile ${targetId} not found in vault.`);
  }

  // Fast-path: If the selected account is already active, avoid unnecessary writes and reloads
  const currentActive = index.find(p => p.isActive);
  if (currentActive && currentActive.id === targetId) {
    logger.info('vault-manager', `Profile ${targetProfile.email} (${targetId}) is already active. Returning fast-path.`);
    return { ...targetProfile, alreadyActive: true };
  }

  const sessionFile = path.join(SESSIONS_DIR, `${targetId}.json`);
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`Session file for profile ${targetId} missing.`);
  }

  // 1. Snapshot current active session before switching (prevent cross-account pollution)
  if (currentActive) {
    const currentCred = readActiveCredential();
    if (currentCred) {
      const activeCredEmail = (currentCred.id_token_email || '').trim().toLowerCase();
      const currentActiveEmail = (currentActive.email || '').trim().toLowerCase();
      if (currentActiveEmail && activeCredEmail === currentActiveEmail) {
        fs.writeFileSync(path.join(SESSIONS_DIR, `${currentActive.id}.json`), JSON.stringify(currentCred, null, 2), 'utf8');
        logger.info('vault-manager', `Updated session backup for outgoing profile: ${currentActive.email}`);
      } else {
        logger.warn('vault-manager', `Skipped session backup for outgoing profile ${currentActive.email} because active credential belongs to "${activeCredEmail || 'unknown'}"`);
      }
    }
  }

  // 2. Load target session
  const targetCred = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

  // 3. Write target session to system credential storage
  const written = writeActiveCredential(targetCred, 'antigravity');
  if (!written) {
    logger.error('vault-manager', 'Failed to write target session to system credential storage');
    throw new Error('Failed to write target session to system credential storage.');
  }

  // 4. Update app_storage.json with new email
  updateAppStorageEmail(targetProfile.email);

  // 5. Update active status in profiles.json
  index.forEach(p => {
    p.isActive = (p.id === targetId);
  });
  fs.writeFileSync(PROFILES_INDEX, JSON.stringify(index, null, 2), 'utf8');

  logger.info('vault-manager', `Switched successfully to ${targetProfile.label} (${targetProfile.email})`);
  return targetProfile;
}

/**
 * Removes an account from the vault (cannot remove active account).
 */
export function removeProfile(id) {
  let index = listProfiles();
  const target = index.find(p => p.id === id);
  if (!target) return false;
  if (target.isActive) {
    throw new Error('Cannot delete currently active account. Switch to another account first.');
  }

  index = index.filter(p => p.id !== id);
  fs.writeFileSync(PROFILES_INDEX, JSON.stringify(index, null, 2), 'utf8');

  const sessionFile = path.join(SESSIONS_DIR, `${id}.json`);
  if (fs.existsSync(sessionFile)) {
    try { fs.unlinkSync(sessionFile); } catch {}
  }

  return true;
}
