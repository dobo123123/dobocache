# Contributing to DoboCache

Thanks for taking the time to look at this project. DoboCache is a small,
free, open-source MCP server; it is not a commercial product and there is no
paid tier, so contributions are handled on a best-effort basis.

If you only want to **use** DoboCache, you do not need this file — see
[README.md](README.md).

## Before you open anything

- **Usage questions / setup help** → open a Discussion or a regular issue using
  the *Question* style labels. Please include your OS, Node.js version and MCP
  client.
- **Bugs** → use the bug report issue template. Include the version
  (`package.json` / `cf_report`), a minimal reproduction, and the exact tool
  call arguments that triggered it.
- **Security problems** → do **not** open a public issue. Follow
  [SECURITY.md](SECURITY.md) instead.
- **Feature requests** → use the feature request template, and read the scope
  rules below first, because this project deliberately stays narrow.

## Project scope (please read before proposing features)

The design goal is *small and sharp*, not *feature-complete*. Changes are much
more likely to be accepted when they:

- keep tool behaviour **deterministic** — the same input must produce a
  byte-identical output, because deterministic formatting is a core premise of
  caching;
- do not add new configuration knobs unless the default behaviour stays
  correct with zero configuration;
- do not increase the number of MCP tools without a strong reason (the tool
  count and tool descriptions are part of the public contract);
- do not add telemetry, network calls, analytics or any outbound traffic —
  DoboCache is local-only by design;
- keep the "white-box" report **off by default** and quiet by default.

Changes that are likely to be rejected:

- new dependencies that duplicate what the Node.js standard library already
  does;
- behaviour that only works on one OS without a documented fallback;
- anything that silently writes to a location outside the resolved log
  directory, or that deletes files the user did not ask to delete.

## Development

Requirements: Node.js >= 18 (CI uses 20).

```bash
npm ci             # install exactly what package-lock.json pins
npm run build      # tsc type-check + emit to dist/
npm run lint       # eslint over src/ and test/
npm test           # vitest, full suite
npm run check:docs # documentation/version consistency assertions
```

All four of `build`, `lint`, `test`, `check:docs` are expected to pass before a
pull request is reviewed. The same commands run in CI on Windows, Linux and
macOS; see `.github/workflows/ci.yml`.

If you touch anything that formats output (reports, cards, JSONL fields), add or
update a test that asserts the **exact** string, not just "contains". Regressions
in formatting are the most common way this project breaks.

## Pull requests

- Keep each pull request focused on one concern; unrelated refactors in the same
  PR make review slow and will usually be asked to split.
- Describe *why* the change is needed, not only *what* changed.
- Note any user-visible behaviour change explicitly (tool description, return
  shape, default value, file written). These must be called out in the PR body
  because they also have to be reflected in the public documentation.
- Do not bump the version number or create tags in a pull request; releases are
  cut separately.
- Do not include your own credentials, tokens, personal paths
  (`C:\Users\...`, `/home/...`) or personal contact details in code, comments,
  tests or docs. Redact log excerpts before pasting them into an issue or PR.

By submitting a pull request you agree that your contribution is licensed under
the Apache License 2.0, the same license as the project.

## Commit messages

Short imperative subject line, optionally with a scope prefix, then a body that
explains the reasoning when the change is not obvious:

```
fix(whitebox): keep card silent when no judged call exists

A report with zero judged calls previously printed "hitRate: 0.0%", which reads
as a measurement result. It now reports the value as undetermined and omits the
ratio line.
```

Please avoid mixing formatting-only churn with behavioural changes in one
commit.

## Reporting a bug that involves the white-box log

The log directory location is platform-dependent and is reported by
`cf_report` (`logDir` / `logDirSource`). When filing a bug, include those two
fields plus the relevant lines of the JSONL file **after** removing anything you
consider sensitive. Request and session identifiers in the log are hashed or
truncated, but prompt-derived text may still be recognisable, so review before
pasting.

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
