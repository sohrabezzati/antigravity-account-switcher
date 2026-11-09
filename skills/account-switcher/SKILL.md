---
name: account-switcher
description: >
  Manage multiple Google Antigravity accounts and inspect real-time quotas across
  Gemini Models (Flash & Pro), Claude & GPT Models (Sonnet, Opus, GPT-OSS), and
  Gemini 4 Argon (Reasoning). Switch active accounts with zero downtime on macOS,
  Linux (Fedora/Ubuntu), and Windows.
argument-hint: "[list|quota|switch <account-or-email>|status|snapshot]"
license: MIT
---

# Antigravity Multi-Account & Live Quota Switcher

Use this skill when the user hits rolling rate limits (HTTP 429 / `RESOURCE_EXHAUSTED`), wants to check model quotas (Gemini, Claude/GPT, or Argon), or asks to switch between multiple Google accounts in Antigravity or `antigravity-cli` (`agy`).

## Available Actions

### 1. View Live Quotas Across Models
Show real-time quota remaining for Gemini (5-hour and weekly), Claude & GPT, and Gemini 4 Argon:
```bash
npx antigravity-account-switcher quota
```

### 2. List All Registered Accounts in Vault
Display all accounts, their active status, plan tier, and model quotas:
```bash
npx antigravity-account-switcher list
```

### 3. Switch Active Account
Switch the active account by email or vault ID:
```bash
npx antigravity-account-switcher switch <account-id-or-email>
```
*Note: This automatically swaps the credential in the system credential manager (macOS Keychain, Linux Secret Service / Keyring, or Windows Credential Manager). If Antigravity desktop is running, Language Server is restarted and the window reloads automatically.*

### 4. Snapshot Current Session
Save the current Google account into the vault:
```bash
npx antigravity-account-switcher snapshot "Label (e.g. Work or Personal)"
```

### 5. Check Integration & Status
```bash
npx antigravity-account-switcher status
npx antigravity-account-switcher agy
```

## Supported Environments
- **Operating Systems**: macOS (Keychain), Linux Fedora / Ubuntu (Secret Service / `secret-tool`), Windows (Credential Manager)
- **Clients**: Antigravity Desktop App, Antigravity IDE, and `antigravity-cli` (`agy`)
