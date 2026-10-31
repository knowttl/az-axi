# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/knowttl/az-axi/security/advisories/new).
If that form is unavailable, open a minimal issue asking for a private reporting channel without disclosing the vulnerability or sensitive details.
Include the affected version, expected and observed behavior, and a minimal reproduction using synthetic data.
Never include tokens, credentials, tenant or subscription identifiers, private hostnames, live captures or unsanitized logs.

Use the latest published version when checking whether an issue still occurs.
This project does not promise fixes for older versions or a response deadline.

## Security boundaries and testing

az-axi is read-only by default and supports explicitly gated writes.
See the reference for [write safeguards](docs/safety.md#writes), [authentication](docs/configuration.md#authentication) and [metadata security boundaries](docs/safety.md#metadata-reads-and-security-boundaries).
Redaction recognizes defined secret patterns; it is not a guarantee that arbitrary output is safe to share.
Inspect and sanitize diagnostics before disclosure.

Contributions must preserve Azure test isolation, synthetic fixtures and the public-repository identifier guard.
See [local validation](CONTRIBUTING.md#local-validation) for package-install network requirements.
Do not test against real Azure services, capture tenant data or execute writes without the resource owner's explicit authorization.
Owner-only benchmark and live-smoke procedures, including destructive checks, are in [CONTRIBUTING.md](CONTRIBUTING.md).
Upstream notices are retained in [NOTICE.md](NOTICE.md) and [UPSTREAM.md](UPSTREAM.md).
