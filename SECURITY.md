# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | Yes       |
| < 0.4   | No        |

Security fixes are released on the latest 0.4.x line. Older versions are not
patched.

## Reporting a Vulnerability

Please report security issues **privately**. Do not open a public issue, and do
not disclose the vulnerability in public channels, social posts, or chat rooms
before a fix has been released.

- Preferred channel: GitHub Security Advisories ("Report a vulnerability") on the
  project repository.
- No public email address is listed for this project, deliberately: a personal
  mailbox is a single point of failure for spam, credential-stuffing and
  social-engineering attempts. If you cannot use GitHub Security Advisories
  (for example you have no GitHub account), open a public issue whose text is
  **only** "requesting a private contact channel for a security report" and
  contains **no** vulnerability details; a private channel will then be arranged.

When reporting, please include as much of the following as you can:

- A description of the issue and its potential impact
- The DoboCache version and the runtime environment (OS, Node.js version)
- The MCP client used, if the issue is client-dependent
- Minimal reproduction steps, and whether the issue requires a malicious
  configuration or a malicious MCP client to trigger
- Any relevant log excerpts, with secrets and personal data removed

Please do **not** attach real credentials, tokens, customer data, or production
prompt content. Redacted samples are sufficient.

## Response Targets

These are good-faith targets, not contractual guarantees:

| Stage | Target |
|-------|--------|
| Acknowledgement of report | within 5 business days |
| Initial assessment and severity triage | within 10 business days |
| Fix or documented mitigation for High/Critical issues | within 60 days of triage |
| Public disclosure | coordinated with the reporter, after a fix or mitigation is available |

If a report is out of scope or will not be fixed, we will explain why.

## Scope

In scope:

- The DoboCache MCP server code and its published package contents
- Credential or prompt-content leakage in the local white-box log
- Path traversal, arbitrary file write or delete, or command execution reachable
  through MCP tool arguments
- Dependency vulnerabilities that are exploitable through DoboCache's own code path

Out of scope:

- Vulnerabilities in third-party MCP clients, model providers, or model APIs
- Issues that require an already fully compromised local machine or a malicious
  local administrator
- Reports that only demonstrate the documented behavior of the tool (for example
  that the local log file is written to disk, or that token accounting estimates
  are estimates)
- Missing hardening that has no demonstrated security impact
- Social engineering, spam, or physical access scenarios

## Handling of Reporters

- Reporters are credited by name or handle on request; anonymous reports are accepted.
- We will not pursue legal action against researchers who act in good faith,
  stay within the scope above, avoid privacy violations and data destruction,
  and give us reasonable time to fix the issue before public disclosure.

## Security Notes for Operators

- DoboCache writes a local JSONL log for its white-box report. Log entries are
  designed to contain request and session identifiers in hashed or truncated
  form rather than raw prompt text; still, treat the log directory as sensitive
  and restrict its filesystem permissions.
- Run the server with the least privilege necessary. Do not expose the stdio
  transport to untrusted processes.
- Keep Node.js and dependencies patched; run your dependency audit tooling on a
  regular schedule.
