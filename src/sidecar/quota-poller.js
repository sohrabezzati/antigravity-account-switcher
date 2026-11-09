import { listProfiles, updateProfileQuota } from './vault-manager.js';

/**
 * Calculates human-friendly countdown until resetTime.
 * Supports days, hours, and minutes.
 * @param {string|null} resetTimeIso 
 * @returns {{ text: string, isExpired: boolean, minutesLeft: number }}
 */
export function calculateResetCountdown(resetTimeIso) {
  if (!resetTimeIso) {
    return { text: 'Refreshed', isExpired: true, minutesLeft: 0 };
  }

  const resetDate = new Date(resetTimeIso);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();

  if (diffMs <= 0) {
    return { text: 'Ready (Refilled)', isExpired: true, minutesLeft: 0 };
  }

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;

  let text = '';
  if (days > 0) {
    text = `${days}d ${hours}h`;
  } else if (hours > 0) {
    text = `${hours}h ${mins}m`;
  } else {
    text = `${mins}m`;
  }

  return { text: `Resets in ${text}`, isExpired: false, minutesLeft: totalMinutes };
}

/**
 * Calls RetrieveUserQuotaSummary and GetUserStatus RPCs via CDP to retrieve 
 * the live active quota separated across Gemini, Claude/GPT 3rd-party, and Argon models.
 * @param {import('./cdp-bridge.js').CdpBridge} cdp 
 */
export async function fetchActiveQuota(cdp) {
  try {
    const expr = `(async () => {
      try {
        const csrf = window.__APP_CONFIG__?.csrfToken || '';
        const port = window.location.port || '51339';
        const headers = {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrf
        };

        // 1. Fetch User Profile Info (name, email, plan, avatar)
        const statusRes = await fetch('https://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/GetUserStatus', {
          method: 'POST',
          headers,
          body: JSON.stringify({})
        });

        if (statusRes.status === 401 || statusRes.status === 403) {
          return { error: 'Unauthorized or session revoked', needsRelogin: true };
        }

        const statusData = statusRes.ok ? await statusRes.json() : {};
        const u = statusData.userStatus || {};

        if (!statusRes.ok || (!u.email && statusData.error)) {
          return { error: 'Failed to retrieve active session', needsRelogin: true };
        }

        // 2. Fetch Multi-Model Quota Summary (Gemini, Claude/GPT, and Argon)
        const modelQuotas = {
          gemini: {
            displayName: 'Gemini Models',
            description: 'Gemini Flash, Gemini Pro',
            fiveHourFraction: 1.0,
            fiveHourResetTime: null,
            fiveHourDesc: '',
            weeklyFraction: 1.0,
            weeklyResetTime: null,
            weeklyDesc: ''
          },
          claudeGpt: {
            displayName: 'Claude & GPT Models',
            description: 'Claude Opus, Claude Sonnet, GPT-OSS',
            fiveHourFraction: 1.0,
            fiveHourResetTime: null,
            fiveHourDesc: '',
            weeklyFraction: 1.0,
            weeklyResetTime: null,
            weeklyDesc: ''
          },
          argon: {
            displayName: 'Gemini 4 Argon',
            description: 'Argon WTU Deep Reasoning',
            weeklyFraction: 1.0,
            weeklyResetTime: null,
            weeklyDesc: '',
            fiveHourFraction: 1.0,
            fiveHourResetTime: null,
            fiveHourDesc: ''
          }
        };

        try {
          const quotaRes = await fetch('https://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', {
            method: 'POST',
            headers,
            body: JSON.stringify({})
          });

          if (quotaRes.ok) {
            const quotaData = await quotaRes.json();
            const groups = quotaData.response?.groups || [];

            for (const g of groups) {
              const dName = (g.displayName || '').toLowerCase();
              const buckets = g.buckets || [];
              const weeklyBucket = buckets.find(b => b.window === 'weekly' || (b.bucketId && b.bucketId.includes('weekly')));
              const fiveHourBucket = buckets.find(b => b.window === '5h' || (b.bucketId && b.bucketId.includes('5h')));

              if (dName.includes('argon')) {
                if (g.displayName) modelQuotas.argon.displayName = g.displayName;
                if (g.description) modelQuotas.argon.description = g.description;
                if (weeklyBucket) {
                  modelQuotas.argon.weeklyFraction = typeof weeklyBucket.remainingFraction === 'number' ? weeklyBucket.remainingFraction : 1.0;
                  modelQuotas.argon.weeklyResetTime = weeklyBucket.resetTime || null;
                  modelQuotas.argon.weeklyDesc = weeklyBucket.description || '';
                }
                if (fiveHourBucket) {
                  modelQuotas.argon.fiveHourFraction = typeof fiveHourBucket.remainingFraction === 'number' ? fiveHourBucket.remainingFraction : 1.0;
                  modelQuotas.argon.fiveHourResetTime = fiveHourBucket.resetTime || null;
                  modelQuotas.argon.fiveHourDesc = fiveHourBucket.description || '';
                }
              } else if (dName.includes('claude') || dName.includes('gpt') || dName.includes('3p')) {
                if (g.displayName) modelQuotas.claudeGpt.displayName = g.displayName;
                if (g.description) modelQuotas.claudeGpt.description = g.description;
                if (weeklyBucket) {
                  modelQuotas.claudeGpt.weeklyFraction = typeof weeklyBucket.remainingFraction === 'number' ? weeklyBucket.remainingFraction : 1.0;
                  modelQuotas.claudeGpt.weeklyResetTime = weeklyBucket.resetTime || null;
                  modelQuotas.claudeGpt.weeklyDesc = weeklyBucket.description || '';
                }
                if (fiveHourBucket) {
                  modelQuotas.claudeGpt.fiveHourFraction = typeof fiveHourBucket.remainingFraction === 'number' ? fiveHourBucket.remainingFraction : 1.0;
                  modelQuotas.claudeGpt.fiveHourResetTime = fiveHourBucket.resetTime || null;
                  modelQuotas.claudeGpt.fiveHourDesc = fiveHourBucket.description || '';
                }
              } else if (dName.includes('gemini')) {
                if (g.displayName) modelQuotas.gemini.displayName = g.displayName;
                if (g.description) modelQuotas.gemini.description = g.description;
                if (weeklyBucket) {
                  modelQuotas.gemini.weeklyFraction = typeof weeklyBucket.remainingFraction === 'number' ? weeklyBucket.remainingFraction : 1.0;
                  modelQuotas.gemini.weeklyResetTime = weeklyBucket.resetTime || null;
                  modelQuotas.gemini.weeklyDesc = weeklyBucket.description || '';
                }
                if (fiveHourBucket) {
                  modelQuotas.gemini.fiveHourFraction = typeof fiveHourBucket.remainingFraction === 'number' ? fiveHourBucket.remainingFraction : 1.0;
                  modelQuotas.gemini.fiveHourResetTime = fiveHourBucket.resetTime || null;
                  modelQuotas.gemini.fiveHourDesc = fiveHourBucket.description || '';
                }
              }
            }
          }
        } catch (eQuota) {
          console.warn('[quota-poller] RetrieveUserQuotaSummary failed, falling back to clientModelConfigs:', eQuota);
        }

        // Fallback to clientModelConfigs if RetrieveUserQuotaSummary didn't provide buckets
        if (modelQuotas.gemini.fiveHourResetTime === null && modelQuotas.gemini.weeklyResetTime === null) {
          const configs = u.cascadeModelConfigData?.clientModelConfigs || [];
          const flashModel = configs.find(c => c.modelId && c.modelId.includes('flash') && c.quotaInfo && typeof c.quotaInfo.remainingFraction === 'number')
                          || configs.find(c => c.quotaInfo && typeof c.quotaInfo.remainingFraction === 'number');
          const weeklyModel = configs.find(c => c.modelId && (c.modelId.includes('claude') || c.modelId.includes('thinking') || c.modelId.includes('sonnet')) && c.quotaInfo && typeof c.quotaInfo.remainingFraction === 'number');

          if (flashModel && flashModel.quotaInfo) {
            modelQuotas.gemini.fiveHourFraction = flashModel.quotaInfo.remainingFraction;
            modelQuotas.gemini.fiveHourResetTime = flashModel.quotaInfo.resetTime || null;
          }
          if (weeklyModel && weeklyModel.quotaInfo) {
            modelQuotas.gemini.weeklyFraction = weeklyModel.quotaInfo.remainingFraction;
            modelQuotas.gemini.weeklyResetTime = weeklyModel.quotaInfo.resetTime || null;
          }
        }

        // Extract exact plan from Google RPC (e.g. Pro, Free, Teams)
        const tier = u.planStatus?.planInfo?.teamsTier || '';
        let plan = u.planStatus?.planInfo?.planName || '';
        if (!plan) {
          if (tier.includes('PRO') || tier.includes('PLUS')) plan = 'Pro';
          else if (tier.includes('TEAMS')) plan = 'Teams';
          else if (tier.includes('ENTERPRISE')) plan = 'Enterprise';
          else plan = 'Free';
        }

        return {
          email: u.email || '',
          name: u.name || '',
          plan,
          profilePictureUrl: u.profilePictureUrl || '',
          fiveHourQuota: modelQuotas.gemini.fiveHourFraction,
          fiveHourResetTime: modelQuotas.gemini.fiveHourResetTime,
          fiveHourDesc: modelQuotas.gemini.fiveHourDesc,
          weeklyQuota: modelQuotas.gemini.weeklyFraction,
          weeklyResetTime: modelQuotas.gemini.weeklyResetTime,
          weeklyDesc: modelQuotas.gemini.weeklyDesc,
          modelQuotas
        };
      } catch (e) {
        return { error: e.message };
      }
    })()`;

    const result = await cdp.evaluate(expr);
    if (!result || result.error) {
      console.warn('[quota-poller] Live quota check returned error:', result?.error);
      if (result?.needsRelogin) {
        const profiles = listProfiles();
        const activeProfile = profiles.find(p => p.isActive);
        if (activeProfile) {
          updateProfileQuota(
            activeProfile.email,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true // needsRelogin
          );
        }
      }
      return null;
    }

    // Update active profile in vault
    if (result.email) {
      updateProfileQuota(
        result.email,
        result.fiveHourQuota,
        result.fiveHourResetTime,
        result.plan,
        result.profilePictureUrl,
        result.name,
        result.weeklyQuota,
        result.weeklyResetTime,
        result.fiveHourDesc,
        result.weeklyDesc,
        false, // session is active & valid
        result.modelQuotas
      );
    }

    return result;
  } catch (err) {
    console.error('[quota-poller] Failed to query live quota:', err.message);
    return null;
  }
}

/**
 * Returns formatted quota summary for all vaulted profiles with separate limits
 * for Gemini (5h + weekly), Claude & GPT (5h + weekly), and Argon (weekly/5h).
 * @param {import('./cdp-bridge.js').CdpBridge} [cdp] 
 */
export async function getAllAccountsQuotaSummary(cdp) {
  // If CDP is available, ensure connection and refresh active account quota live
  if (cdp) {
    if (!cdp.isConnected && !cdp.isConnecting) {
      try {
        await cdp.connect();
      } catch (e) {
        console.warn('[quota-poller] Reconnect attempt failed:', e.message);
      }
    }
    if (cdp.isConnected) {
      await fetchActiveQuota(cdp);
    }
  }

  const profiles = listProfiles();
  return profiles.map(p => {
    // 1. Gemini Models Quota
    let fiveHourFraction = typeof p.fiveHourQuota === 'number' ? p.fiveHourQuota : (typeof p.lastQuota === 'number' ? p.lastQuota : 1.0);
    const fiveHourReset = p.fiveHourResetTime || p.resetTime;
    const fiveHourCountdown = calculateResetCountdown(fiveHourReset);
    if (fiveHourCountdown.isExpired && fiveHourReset && fiveHourFraction < 1.0) {
      fiveHourFraction = 1.0;
    }
    const fiveHourPercent = Math.round(fiveHourFraction * 100);

    let weeklyFraction = typeof p.weeklyQuota === 'number' ? p.weeklyQuota : 1.0;
    const weeklyCountdown = calculateResetCountdown(p.weeklyResetTime);
    if (weeklyCountdown.isExpired && p.weeklyResetTime && weeklyFraction < 1.0) {
      weeklyFraction = 1.0;
    }
    const weeklyPercent = Math.round(weeklyFraction * 100);

    // 2. Claude & GPT 3rd-Party Models Quota
    const rawClaude = p.modelQuotas?.claudeGpt || {};
    let claude5hFraction = typeof rawClaude.fiveHourFraction === 'number' ? rawClaude.fiveHourFraction : 1.0;
    const claude5hCountdown = calculateResetCountdown(rawClaude.fiveHourResetTime);
    if (claude5hCountdown.isExpired && rawClaude.fiveHourResetTime && claude5hFraction < 1.0) claude5hFraction = 1.0;
    const claude5hPercent = Math.round(claude5hFraction * 100);

    let claudeWeeklyFraction = typeof rawClaude.weeklyFraction === 'number' ? rawClaude.weeklyFraction : 1.0;
    const claudeWeeklyCountdown = calculateResetCountdown(rawClaude.weeklyResetTime);
    if (claudeWeeklyCountdown.isExpired && rawClaude.weeklyResetTime && claudeWeeklyFraction < 1.0) claudeWeeklyFraction = 1.0;
    const claudeWeeklyPercent = Math.round(claudeWeeklyFraction * 100);

    // 3. Gemini 4 Argon Models Quota
    const rawArgon = p.modelQuotas?.argon || {};
    let argonWeeklyFraction = typeof rawArgon.weeklyFraction === 'number' ? rawArgon.weeklyFraction : 1.0;
    const argonWeeklyCountdown = calculateResetCountdown(rawArgon.weeklyResetTime);
    if (argonWeeklyCountdown.isExpired && rawArgon.weeklyResetTime && argonWeeklyFraction < 1.0) argonWeeklyFraction = 1.0;
    const argonWeeklyPercent = Math.round(argonWeeklyFraction * 100);

    let argon5hFraction = typeof rawArgon.fiveHourFraction === 'number' ? rawArgon.fiveHourFraction : 1.0;
    const argon5hCountdown = calculateResetCountdown(rawArgon.fiveHourResetTime);
    if (argon5hCountdown.isExpired && rawArgon.fiveHourResetTime && argon5hFraction < 1.0) argon5hFraction = 1.0;
    const argon5hPercent = Math.round(argon5hFraction * 100);

    // Classification status
    let status = 'ready';
    if (p.needsRelogin) {
      status = 'needs_relogin';
    } else if (p.isActive) {
      status = 'active';
    } else if (
      fiveHourPercent === 0 || 
      (!fiveHourCountdown.isExpired && fiveHourPercent < 10) ||
      weeklyPercent === 0 || 
      (!weeklyCountdown.isExpired && weeklyPercent < 10)
    ) {
      status = 'cooldown';
    }

    return {
      id: p.id,
      label: p.label,
      email: p.email,
      name: p.name || '',
      profilePictureUrl: p.profilePictureUrl || '',
      plan: p.plan || 'Free',
      isActive: !!p.isActive,

      // Default / Gemini Limit Properties (Backwards compatibility)
      fiveHourFraction,
      fiveHourPercent,
      fiveHourCountdownText: fiveHourCountdown.text,
      fiveHourDesc: p.fiveHourDesc || '',
      weeklyFraction,
      weeklyPercent,
      weeklyCountdownText: weeklyCountdown.text,
      weeklyDesc: p.weeklyDesc || '',

      // Separate structured model quotas (Gemini, Claude & GPT, Argon)
      modelQuotas: {
        gemini: {
          displayName: rawClaude.displayName || 'Gemini Models',
          models: 'Gemini Flash, Gemini Pro',
          fiveHourFraction,
          fiveHourPercent,
          fiveHourCountdownText: fiveHourCountdown.text,
          fiveHourDesc: p.fiveHourDesc || '',
          weeklyFraction,
          weeklyPercent,
          weeklyCountdownText: weeklyCountdown.text,
          weeklyDesc: p.weeklyDesc || ''
        },
        claudeGpt: {
          displayName: rawClaude.displayName || 'Claude & GPT Models',
          models: rawClaude.description || 'Claude Opus, Claude Sonnet, GPT-OSS',
          fiveHourFraction: claude5hFraction,
          fiveHourPercent: claude5hPercent,
          fiveHourCountdownText: claude5hCountdown.text,
          weeklyFraction: claudeWeeklyFraction,
          weeklyPercent: claudeWeeklyPercent,
          weeklyCountdownText: claudeWeeklyCountdown.text
        },
        argon: {
          displayName: rawArgon.displayName || 'Gemini 4 Argon',
          models: rawArgon.description || 'Argon WTU Deep Reasoning',
          weeklyFraction: argonWeeklyFraction,
          weeklyPercent: argonWeeklyPercent,
          weeklyCountdownText: argonWeeklyCountdown.text,
          fiveHourFraction: argon5hFraction,
          fiveHourPercent: argon5hPercent,
          fiveHourCountdownText: argon5hCountdown.text
        }
      },

      // Legacy mappings
      remainingFraction: fiveHourFraction,
      remainingPercent: fiveHourPercent,
      resetCountdownText: fiveHourCountdown.text,
      status: status
    };
  });
}
