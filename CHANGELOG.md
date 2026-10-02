# Changelog

All notable changes to az-axi are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

- `rg query`: Resource Graph queries with `--file`/stdin, skip-token paging, ID shortening and throttling hints.
- `api`: read/query escape hatch for any ARM, Log Analytics or Graph path; writes stay blocked with `WRITES_DISABLED`.
- Dashboard (`az-axi` with no arguments): profile, identity, subscriptions and write status; other sections arrive in Phase 4.
