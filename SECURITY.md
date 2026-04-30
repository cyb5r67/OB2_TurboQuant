# Security Policy

## Reporting a vulnerability

Email: <insert contact here before going public>

Expect acknowledgment within 3 business days. We target:
- 30 days to ship a fix for Critical issues
- 90 days for High
- Best-effort for Medium / Low

## In scope

- Server components (`server/**`)
- Deployed Docker images
- The dashboard frontend
- Reset / invite / email-recovery flows

## Out of scope

- Third-party SMTP providers' infrastructure
- Issues requiring physical access to the host
- Rate-limit tuning suggestions without a working bypass proof of concept
- Vulnerabilities in out-of-tree dependencies that have upstream fixes

See [docs/security.md](docs/security.md) for the threat model + hardening guide.
