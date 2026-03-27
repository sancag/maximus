# Credential Vault

## Overview

The credential vault stores secrets encrypted at rest using AES-256-GCM. Agents never have access to credentials directly. The vault key lives in the tool executor process. When a tool needs credentials, the infrastructure resolves them from the vault and injects them into the API call.

This architecture ensures that even if an agent's context is leaked or logged, no secrets are exposed.

## How It Works

The credential vault uses a proxy pattern to keep secrets out of agent context:

```
Agent
  -> tool("create_issue", { repo, title })
    -> Tool Executor
      -> Vault.resolve("github_token")
        -> HTTP call with token
          -> sanitized result
            -> Agent
```

The agent only sees: business parameters in, sanitized result out. At no point does the agent have access to the GitHub token, API key, or any other credential. The entire credential lifecycle happens in the tool executor layer.

## Setup

### Environment Variable

Set `MAXIMUS_VAULT_KEY` as an environment variable. This is the master key used to derive the encryption key (via scrypt) for encrypting and decrypting credentials.

```bash
# Linux/macOS
export MAXIMUS_VAULT_KEY="your-secure-vault-key-here"

# Or in a .env file (never commit to git)
MAXIMUS_VAULT_KEY=your-secure-vault-key-here
```

Store the vault key securely:
- **Local development:** `.env` file (add to `.gitignore`) or export in shell profile
- **Production:** systemd environment, Docker secrets, or a secrets manager
- **CI/CD:** Environment variable in your CI platform's secrets store

### Interactive Fallback

For local development, if the `MAXIMUS_VAULT_KEY` environment variable is not set and the process is running in an interactive terminal (TTY), the engine will prompt for the vault key:

```
Enter vault key (MAXIMUS_VAULT_KEY): _
```

This fallback is disabled in non-interactive environments (CI, background processes) where `stdin.isTTY` is false.

## Adding Credentials

Use the `CredentialVault` API to add credentials programmatically:

```typescript
import { CredentialVault } from "@maximus/vault";

// Create or open a vault
const vault = new CredentialVault(process.env.MAXIMUS_VAULT_KEY!);

// Add credentials
vault.set("github_token", "ghp_your_token_here", {
  description: "GitHub PAT with repo scope",
});

vault.set("slack_webhook", "https://hooks.slack.com/services/T00/B00/xxx", {
  description: "Slack webhook for #engineering channel",
});

// Save encrypted vault to disk
vault.save("config/credentials.enc");
```

To load an existing vault:

```typescript
const vault = CredentialVault.load("config/credentials.enc", process.env.MAXIMUS_VAULT_KEY!);

// List stored credentials (metadata only, no values)
const creds = vault.list();
// [{ name: "github_token", description: "GitHub PAT with repo scope", createdAt: "...", updatedAt: "..." }]

// Check if a credential exists
vault.has("github_token"); // true

// Remove a credential
vault.delete("github_token");
```

## Referencing in Skills

Skills reference credentials by name. The `ref` must match the name used in `vault.set()`:

```yaml
# In a skill YAML file
credentials:
  - ref: github_token
    inject_as: GITHUB_TOKEN

tools:
  - name: github_create_issue
    credentials:
      - ref: github_token
        inject_as: GITHUB_TOKEN
    action:
      type: http
      method: POST
      url: "https://api.github.com/repos/{{repo}}/issues"
      headers:
        Authorization: "Bearer {{GITHUB_TOKEN}}"
```

At tool execution time, `{{GITHUB_TOKEN}}` is replaced with the decrypted value of the `github_token` credential from the vault. The agent never sees the actual token value.

## Output Sanitization

Tool output is automatically sanitized to strip leaked secrets before being returned to the agent. The sanitizer runs as a `PostToolUse` hook on every SDK session.

Patterns detected and redacted:

| Pattern | Replacement | Example |
|---------|-------------|---------|
| Anthropic API keys (`sk-ant-...`) | `[REDACTED_ANTHROPIC_KEY]` | `sk-ant-abc123...` |
| OpenAI API keys (`sk-...`) | `[REDACTED_API_KEY]` | `sk-proj-abc123...` |
| GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) | `[REDACTED_GH_TOKEN]` | `ghp_abc123...` |
| AWS access keys (`AKIA...`) | `[REDACTED_AWS_KEY]` | `AKIAIOSFODNN7EXAMPLE` |
| Bearer/token/key assignments | `[REDACTED]` | `Bearer eyJ...`, `api_key=abc...` |
| Connection strings | `[REDACTED_CONN_STRING]` | `postgres://user:pass@host/db` |
| Authorization headers | `Authorization: [REDACTED]` | `Authorization: Basic abc...` |
| Long hex strings (40+ chars) | `[REDACTED_HASH]` | SHA hashes, hex-encoded tokens |

The sanitizer uses a regex pipeline ordered from specific patterns to generic patterns to minimize false positives.

## Security Model

The credential vault implements a three-layer defense:

### Layer 1: Encryption at Rest

Credentials are encrypted using AES-256-GCM with a key derived from the vault key via scrypt (with a random salt). Each credential gets its own random IV, preventing identical plaintext from producing identical ciphertext. The authentication tag (GCM) ensures tamper detection.

### Layer 2: Proxy Pattern (Runtime Isolation)

Credentials are never present in the agent's context. The `CredentialProxy` resolves credentials from the vault only at tool execution time, in the tool executor process. The vault key itself is blocked from the SDK subprocess environment via `filterEnvForSdk`, which strips `MAXIMUS_VAULT_KEY`, `VAULT_KEY`, `ENCRYPTION_KEY`, and `MASTER_KEY` from the environment before spawning agent processes.

### Layer 3: Output Sanitization

Even if a credential somehow appears in a tool's output (e.g., an error message containing a token), the `PostToolUse` sanitizer hook catches and redacts it before the output reaches the agent.

Together, these three layers ensure that credentials remain secure throughout the entire agent lifecycle: at rest, during execution, and in output.
