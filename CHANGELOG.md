# Changelog

All notable changes to az-axi are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

- `rg query`: Resource Graph queries with `--file`/stdin, skip-token paging, ID shortening and throttling hints.
- `api`: read/query escape hatch for any ARM, Log Analytics or Graph path; writes stay blocked with `WRITES_DISABLED`.
- Dashboard (`az-axi` with no arguments): profile, identity, subscriptions and write status.
- `defender alerts|assessments|score`: Defender for Cloud alerts (list and get), grouped recommendations and per-subscription secure scores.
- `exposure`: canned Resource Graph checks for attached public IPs, open management ports and any-any NSG rules, with `--show-query`.
- Dashboard (`az-axi` with no arguments): active alerts by severity, secure score average and lowest subscription, and exposure counts. A failed section degrades to a hint.
