---
name: security-best-practices
description: Reference document for security best practices across all projects, especially open-source code facing AI-powered vulnerability scanning
tools: Read, Grep, Glob, Bash
---

# Security best practices for open-source projects

Assumes adversaries are using advanced AI to scan public code for vulnerabilities. The defense is not hiding the code — it's making the code correct.

## Core principles

**The code is public. Act accordingly.** Every line will be scanned by AI tools looking for patterns: hardcoded secrets, logic errors, crypto mistakes, race conditions, missing validation. The only defense is not having vulnerabilities, not hiding them.

**Minimize attack surface.** Every endpoint, parameter, config option, and dependency is a target. Features you don't build can't be exploited. Defer complexity. Remove dead code. Disable unused endpoints.

**Assume breach.** Design every layer so that compromise of one component doesn't cascade. The server should never be able to read user data. A stolen device should not compromise other devices. A compromised dependency should not get access to secrets.

**Make crypto boring.** Use well-audited libraries (libsodium/NaCl, Web Crypto API). Use standard algorithms (XChaCha20-Poly1305, Ed25519, Argon2id). Never roll custom crypto. AI scanners are excellent at spotting custom crypto mistakes — if you use the standard library the standard way, there's nothing to find.

## Pre-commit

- No secrets in code. Use environment variables or secret managers. Scan with `gitleaks` or `trufflehog` pre-commit.
- Validate all input at system boundaries. Internal code can trust internal types.
- Use parameterized queries / prepared statements. Never string-concatenate user input into queries or commands.
- Handle errors without leaking internals. No stack traces, no database errors, no file paths in responses.

## CI pipeline

Run these on every PR:

| Check | Tool | Purpose |
|---|---|---|
| Static analysis | ESLint security rules, Semgrep | Catch code-level vulnerabilities |
| Dependency audit | `npm audit`, Socket.dev | Known CVEs and supply chain risks |
| Secret scanning | gitleaks, trufflehog | Leaked credentials in code or history |
| License compliance | license-checker | Ensure dependencies have compatible licenses |
| AI security review | @security-reviewer agent | Catch logic errors, auth bypass, race conditions |

## Dependency management

- Pin exact versions in lockfiles. Review lockfile diffs in PRs.
- Use `npm audit signatures` to verify package provenance.
- Prefer packages with few dependencies. Deep dependency trees multiply supply chain risk.
- Monitor for typosquatting on your own package names.
- Enable Dependabot or Renovate for automated updates. Review before merging.
- Use Socket.dev or similar for supply chain analysis — detects suspicious package behavior (postinstall scripts, network calls, filesystem access).

## Cryptography checklist

- Use authenticated encryption (AEAD). Never encrypt without integrity checking.
- Use unique nonces/IVs for every encryption operation. Never reuse.
- Derive keys with a proper KDF (Argon2id for passwords, HKDF for key derivation).
- Use constant-time comparison for secrets (no `===` for tokens/hashes).
- Rotate keys on a documented schedule. Document the rotation procedure.
- Document what happens when a key is compromised — the recovery path must exist before you need it.

## Authentication and authorization

- Verify identity at every trust boundary. Don't assume internal calls are authenticated.
- Use challenge-response for registration. Never accept a public key alone as proof of identity.
- Rate-limit all authentication endpoints. Exponential backoff after failures.
- Make sessions short-lived. Require re-authentication for sensitive operations.
- Log all authentication events. Include enough context to detect anomalies (IP, device, timestamp) without logging secrets.

## API design

- Validate request size limits. Reject oversized payloads before parsing.
- Use strict typing. Reject unexpected fields rather than ignoring them.
- Return consistent error formats. Don't vary error detail by authentication state (information leak).
- Implement idempotency for state-changing operations. Prevents replay and retry issues.
- Use HTTPS everywhere. HSTS headers. No mixed content.

## Data handling

- Encrypt at rest and in transit. No exceptions.
- Classify data by sensitivity. Know what's PII, what's a secret, what's public.
- Implement data retention policies. Don't keep data longer than needed.
- Provide data export and deletion. Users must be able to leave with their data.
- Log access to sensitive data. Audit trail for who accessed what and when.

## Incident response

- Document the response plan before you need it. Include: who to contact, how to revoke keys, how to notify users.
- Maintain a security contact (security@domain or SECURITY.md in repo).
- Have a bug bounty or responsible disclosure policy. Even informal ("email us, we'll respond within 48 hours") is better than nothing.
- Practice key compromise scenarios. Can you actually revoke and re-encrypt under pressure?

## AI-specific threats

- **Prompt injection via agent guides.** If your product uses agent-readable documentation, an attacker who compromises the hosting could inject malicious instructions. Use integrity hashes or signatures.
- **Model-assisted fuzzing.** AI can generate sophisticated fuzzing inputs that bypass validation. Test with adversarial inputs, not just happy paths.
- **Automated vulnerability discovery.** AI tools will find your vulnerabilities faster than humans. Run the same tools defensively — scan your own code before shipping.
- **Social engineering via AI.** Attackers can use AI to craft convincing phishing, impersonate maintainers, or submit plausible-looking malicious PRs. Verify identity through out-of-band channels for sensitive operations.

## GitHub repository security features

When reviewing a project hosted on GitHub, check which of these features are active and recommend enabling any that are missing. Use `gh api` to inspect settings programmatically.

### Features to check

| Feature | How to check | What it does |
|---|---|---|
| **Dependabot alerts** | `gh api repos/{owner}/{repo}/vulnerability-alerts` (204 = enabled) | Alerts on known CVEs in dependencies |
| **Dependabot security updates** | Settings > Code security | Auto-opens PRs to fix vulnerable dependencies |
| **Code scanning (CodeQL)** | `gh api repos/{owner}/{repo}/code-scanning/alerts` | SAST analysis on every push/PR |
| **Secret scanning** | `gh api repos/{owner}/{repo}/secret-scanning/alerts` | Detects committed secrets (API keys, tokens, passwords) |
| **Secret scanning push protection** | Settings > Code security | Blocks pushes containing detected secrets before they enter history |
| **Private vulnerability reporting** | Settings > Code security | Lets researchers report vulnerabilities privately via GitHub |
| **Branch protection rules** | `gh api repos/{owner}/{repo}/branches/main/protection` | Enforces PR reviews, status checks, signed commits |
| **Rulesets** | `gh api repos/{owner}/{repo}/rulesets` | Modern replacement for branch protection with more granular control |
| **SECURITY.md** | Check repo root or `.github/` | Documents how to report vulnerabilities |
| **CODEOWNERS** | Check repo root or `.github/` | Ensures security-sensitive paths require specific reviewers |

### Recommended minimum configuration

For any public repository:
1. **Dependabot alerts + security updates** — enabled
2. **Code scanning with CodeQL** — enabled on default branch and PRs
3. **Secret scanning + push protection** — enabled
4. **Branch protection on main** — require PR reviews, require status checks to pass, require signed commits if team supports it
5. **SECURITY.md** — present with disclosure instructions and response timeline
6. **Private vulnerability reporting** — enabled

For private repositories, additionally:
- Enable **Dependabot version updates** to keep dependencies current
- Configure **required reviewers** for security-sensitive paths via CODEOWNERS
- Enable **audit log streaming** if on GitHub Enterprise

### Workflow for security reviews

When the `@security-reviewer` agent runs on a GitHub-hosted project:
1. Detect GitHub hosting (`git remote -v` or `.git/config`)
2. Use `gh api` to enumerate which security features are active
3. Include a "GitHub Security Configuration" section in the review output
4. Flag any missing recommended features as findings
5. Provide the exact `gh` commands or settings paths to enable each missing feature

## Periodic review

- Security review every major feature before merge.
- Full audit of authentication and authorization quarterly.
- Dependency audit monthly (automated) with human review of flagged items.
- Penetration testing annually or after major architecture changes.
- Threat model review when attack surface changes (new endpoints, new integrations, new trust relationships).
