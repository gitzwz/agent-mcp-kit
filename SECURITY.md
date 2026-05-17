# Security Policy

If you discover a vulnerability in this project, do not publish exploit details immediately.

Please report security issues privately to the maintainer through a private channel first, including:
- affected version / commit
- impact summary
- reproduction steps
- suggested mitigation if available

Sensitive areas in this project include:
- mTLS identity verification
- workspace confinement and path traversal
- archive extraction safety
- remote job execution boundaries
- secret handling for Telegram and other agent integrations

Until a dedicated disclosure address is added, coordinate directly with the maintainer before public disclosure.
