# DoboCache v0.4.7

> **Cache hits you can see — and a white-box report for every step.**

DoboCache is an **MCP server mounted over stdio**. It sits between your coding CLI / agent client and the model vendor's API, and turns each request's context into a **stable, reusable prefix that is automatically topped up when it falls below the vendor's minimum cache threshold**. Whether the cache hit, how much it hit, and what DoboCache changed along the way are all written to a local white-box log you can read at any time.

---

> **Official source**
> The only official repository for DoboCache is <https://github.com/dobo123123/dobocache>, and official releases are published only on its Releases page. Same-named projects, services, or paid editions found elsewhere are not ours. This project is free and is not sold through any third-party platform.

> **First time here?**
> - Step-by-step setup, absolute beginner level (Chinese): [零基础三分钟上手.md](零基础三分钟上手.md) — six steps from installing Node to verifying success.
> - Hit an error while installing? Search your exact error message in the [FAQ troubleshooting section](FAQ-使用须知.md) (Chinese).
>
> Cannot install or configure it? Ask in [Discussions](https://github.com/dobo123123/dobocache/discussions) — setup questions do not need an Issue.

## Platform support status (read before installing)

DoboCache is a pure-JavaScript stdio MCP server. The release bundle contains **no native binaries at all** (`.node` / `.exe` / `.dll` counts are 0), so there is no ABI-level lock-in. But "**runs**" and "**verified**" are two different claims, so this release labels each platform by how far it was actually verified:

| Platform | Status | How far it was verified |
|---|---|---|
| **Windows 10 / 11 (x64)** | ✅ **Primary platform, verified on real hardware** | End-to-end on a real machine: this 20-request controlled run (real MCP client mount + provider `usage` verification), unzip-and-run smoke test of the portable bundle, full **79** tests passing, log location observed as `%LOCALAPPDATA%\DoboCache\logs` |
| **Linux (x86_64)** | 🟡 **Verified inside a Linux container** (not a desktop machine) | On 2026-11-04 the released bundle was actually executed on Docker `linux/amd64` with the official Node Linux image: unzip-and-run, valid `initialize` / `tools/list`, all 9 tools present, `cf_judge` hitting, `cf_inject` returning `prefixReady=true`, log written to `~/.local/state/dobocache`, `XDG_STATE_HOME` honoured, `DOBOCACHE_LOG_DIR` taking highest priority, read-only directory degrading without a crash, and Node 16 aborting with `exit 1`. **Desktop Linux with a GUI client mount, and arm64, remain unverified** (details in `兼容性说明.md`, Appendix A) |
| **macOS (Intel / Apple Silicon)** | ⚠️ **Not verified on real hardware** (expected to work) | **Unit tests only**: `~/Library/Logs/DoboCache` path resolution plus the same test batch. The full chain **has never been run on a real Mac** |

**We would rather state the boundary than overclaim:**

1. Windows is the primary platform and the **only** one verified end-to-end on real hardware (real client mount + provider `usage` read-back);
2. Linux has been actually executed in a `linux/amd64` container (protocol chain, logging, read-only degradation, Node version self-check), but **a desktop distribution with a GUI client mount, and arm64, are still unverified**; macOS **has never been run on a real Mac**. So macOS is labelled "not verified" and Linux only "verified in container" — neither is labelled "fully supported". We have no real success-rate data and will not quote a percentage;
3. **Feedback welcome, and we will fix what the feedback shows**: whether it works or breaks on Linux / macOS, please tell us.

**Where to send feedback**

| Channel | How |
|---|---|
| GitHub Issues (preferred) | Prefix the title with `[platform: macOS]` or `[platform: linux]`; include `node -v`, `uname -a` (`sw_vers` on macOS), the `logDir` / `logDirSource` values from `cf_report`, and the full error text |
| The channel you got this bundle from | Until the repository is public, reply in the same channel with the same information |
| Self-check first | `FAQ-使用须知.md` §3 (where the log lives) and §7 (`prefixReady=false`) answer most "it looks like nothing happened" cases |

> **Do not paste your prompt text into an issue**: the log is already sanitised (`req-<hash>` / `sid-<hash>`); a log excerpt is enough to locate the problem.

---

## 1. The problem it addresses

Every major vendor API offers prompt caching: if the beginning of a request is byte-identical to a previous one, that portion is billed as cached instead of recomputed at full rate. In real conversations the prefix is almost never identical:

- system prompt ordering drifts, prompt concatenation order changes between requests;
- history trimming leaves the prefix misaligned with cache block boundaries (commonly 128 tokens);
- the prefix is shorter than the vendor's minimum cacheable length, so it never enters the cache at all;
- duplicated instructions and repeated document blocks make the prefix longer but dirtier.

Any single mismatch invalidates the whole cached prefix — **you believe you are using the cache while every request is recomputed at full rate**. DoboCache fixes these "almost identical" gaps one by one, and **records the reason for every adjustment**, so you can verify the work instead of trusting a single good-looking number.

## 2. The nine tools you can call (8 business tools + `ping`)

The server exposes **8 business tools plus one health check (`ping`)**. All of them run locally over stdio — no network calls, no uploads:

| Tool | Purpose | Writes to disk |
|---|---|---|
| `cf_judge` | **Hit decision**: tiered keyword matching (entity anchors / intent modifiers) → three-layer match → recency decay → negative filtering, with explainable evidence (`hit` / `score` / `evidence` / `matched`) | White-box log |
| `cf_tier` | **Value-tier admission**: distill → grade A/B/C → fill by budget from high to low, returning the admitted list and what was dropped | No |
| `cf_inject` | **Distilled memory injection**: builds a stable prefix (dedup → 128-token alignment → threshold top-up) and returns `prefix` / `tail` ready to send | White-box log; freezes session prefix (in memory) |
| `cf_warmup` | **Warm-up**: call once before the first real request to build a minimal placeholder request from the frozen prefix and trigger the vendor's prefix cache (costs a little; you must send that prompt to the LLM yourself) | No |
| `cf_report` | Cumulative white-box statistics: hit rate, raw/optimised tokens, per-session aggregation (`per_session`), plus the actual log location `logDir` / `logDirSource`; with `source="disk"` it **re-aggregates from the local log files** (survives restarts, spans days), and `days=<n>` limits the window | No (reads log) |
| `cf_meter` | Metering snapshot (token counts and relative cost ratios, never request text) | No |
| `cf_prune` | Deterministic pruning of tool output: dedup lines, collapse whitespace, char/line caps, returns the volume ratio | No |
| `cf_normalize` | Deterministic normalisation of structured results: field whitelist + stable ordering, returns a content-free key (`nk-<16-hex>`) | No |

Typical call: `cf_inject(reset=true, sessionId=<your-session>, minPrefixTokens=<vendor threshold>)`.

> Parameters are type- and range-checked at the protocol layer (e.g. `threshold ≥ 0`, `topK ≥ 1`, `maxChars ≥ 1`, `maxTokens > 0`). Out-of-range values return a standard `-32602` validation error naming the field instead of being silently accepted.

## 3. Release notes (read this first)

**v0.4.7 = bounded logs + statistics that survive restarts + one tool told straight. Automatic log rotation and retention, `cf_report` re-aggregating from disk via `source="disk"`, and a corrected `cf_prune` description; the caching core is untouched and cache behaviour is byte-identical to v0.4.4.**

| Item | Detail |
|---|---|
| Inherited | v0.4.4's `minPrefixTokens` fix (the line v0.4.3 added) and the log privacy work (`requestId` → `req-<8-hex>`, `sessionId` → `sid-<8-hex>`, `cf_normalize` key → `nk-<16-hex>`) are all kept |
| New in this version | ① **Logs now have bounds**: a file rolls at 10MB into `.1` with at most 3 copies, and entries older than 7 days are pruned on the first write of the day (`DOBOCACHE_LOG_MAX_MB` / `DOBOCACHE_LOG_KEEP_DAYS` are tunable). Only files named by this module are touched — your own files in the same directory are never deleted; failures are skipped silently, and `cf_report` exposes `logPolicy` / `logMaintenance` for self-checks. ② **`cf_report` gains `source="disk"`**: it re-aggregates from the local log files (`days=<n>` sets the window), so history no longer resets when the MCP client restarts; the semantics match the in-memory view (`hitRate` averages judged rows only and stays `null` when nothing was judged), and malformed lines count toward `skippedLines` instead of breaking the aggregate. ③ **`cf_prune` told straight**: it trims only the `text` you pass in, never reads or deletes any file on disk, and never touches the white-box log |
| Hit-related code | The caching core (prefix freezing / alignment / tiered admission / judge logic) is unchanged from v0.4.4 — this release touches no algorithm; in the default mode `cf_judge` / `cf_inject` return **one JSON block with no card** |
| Smoke test | MCP stdio smoke passed: `serverInfo.version = 0.4.7`, 9 tools present, no card in the default mode, card only on the first call with `once`, every call with `always`, and `cf_report.cardMode` matching the setting |
| Tests | **95 / 95 passing**; `tsc --noEmit` clean; `eslint src test` clean |
| Platform verification | **Windows verified end-to-end on real hardware**; **Linux actually executed inside a `linux/amd64` container** (protocol chain / 9 tools / log branches / read-only degradation / Node version self-check — see "Platform support status" and `兼容性说明.md` Appendix A); macOS covered by unit tests only, **never run on a real machine** |
| **Not claimed** | This is **not** a performance release. Hit rates match v0.4.4; please do not read any number below as "the new version is higher" |

> Why v0.4.3 exists: in the v0.4.2 release build, step 4 of `injectIncremental` called `topUpPrefixToMin(...)` but was missing the `prefix = topUp.prefix;` assignment, so the top-up never took effect and the parameter was effectively inert. Vendor D's default threshold is low (295), and normal prefixes are already longer than that, so the bug stayed hidden; Vendor G's real threshold is 1806+, where top-up is mandatory — the moment it fails, the bug shows. That is why the regression was run against Vendor G. v0.4.3 added the missing assignment.

## 4. Measured results (20 consecutive requests, controlled)

This run: one progressive 20-request conversation. The requesting side was "a common coding CLI tool" wired to a provider referred to as vendor G; the whitebox engine mounted DoboCache over stdio MCP. Same machine, same model, same parameters — the only difference is mounted vs. not mounted.

> **Three reading conventions, up front**: ① "Vendor D" / "Vendor G" and "a common coding CLI tool" are anonymous labels — we do not attach third-party product names to our measurements. ② The three requesting sides are referred to by the codes **WBX** (self-built whitebox, direct) / **DXH** (official Harness, headless) / **COD-X** (common coding CLI); each code is an abbreviation of the requesting side's *type*, not of any specific product, and contains no third-party trademark. ③ Only **hit rates and relative ratios** are reported; no monetary amounts. Cost-related fields are relative values converted with the price coefficients described in section 6.

![Control vs. mounted hit rate](hitrate-comparison.png)

| Metric | Control (not mounted) | Mounted (DoboCache) |
|---|---|---|
| Mean hit rate over 20 requests | **0.00%** (all 20 requests at zero) | **98.59%** |
| Range | — | **96.08% – 99.79%** |
| Zero-hit requests | 20 / 20 | **0 / 20** |
| Prefix ready (`prefixReady=true`) | — | **20 / 20** |
| Effective threshold `effectiveMinPrefixTokens` | — | **3450** (= 3000 × 1.15, config applied) |

How to read this — all three points matter together:

1. **The control arm received different random noise at the head of every request**, deliberately drifting the prefix, which is why all 20 requests were zero. This is not "the control is bad"; it is what happens when a prefix changes and the vendor's prefix cache is invalidated wholesale.
2. **The mounted arm hit on all 20 requests**, with `prefixTokens` stable in the 3456–4480 range and `prefixReady` true on every request.
3. **A hit rate is the cached share inside that request's own input, not an absolute token saving.** The two arms have different input volumes (control grows from 39 to 2738 tokens across requests; mounted stays at "prefix + tail"), so the two must not be converted into absolute token counts, and numbers must not be mixed across experiments.

**Zoom out one level: not-mounted is not always 0%.** The hit rate is not decided by "mounted or not" alone — how the requesting side builds its requests sets the control arm's starting point. The same mounting logic was run for 20 requests under three requesting-side forms:

**First, what each requesting side actually is — this is the whole reason the control baselines differ:**

| Form | Who the requesting side is | Does it do any prefix handling itself? | Why the control arm reads what it reads |
|---|---|---|---|
| A · WBX whitebox self-built, direct | **DoboCache's own whitebox test base** — a direct client we wrote ourselves for these experiments, not any official client | **No, none at all**: no prefix construction, no cache warm-up, no session reuse; each round sends only "task text + random noise" | 0 / 28,846 tokens over 20 requests. With nothing reusable in hand, the baseline is structurally **0.00%** — a **structural zero baseline**, not a cache that "collapsed" |
| B · DXH official Harness, headless | Vendor D's official client (headless mode) | **Yes, guaranteed by both client and provider**: every new session carries ~2,560 tokens of provider-side global system prefix | 51,200 / 77,576 tokens over 20 requests = **66.00%**; 51,200 is exactly 2,560 × 20, so you can verify that all of that 66% comes from the official prefix and owes nothing to DoboCache |
| C · COD-X common coding CLI | A commercial coding client (vendor G side) | **Not fixed**: no global system prefix; hits only when long-history prefixes happen to stay stable | Group 8: zero on all 20; group 7: only R10 / R20 hit naturally, per-request mean 9.87% |

In one sentence: **A's 0% means "this client has no prefix to hit in the first place" (our own base, deliberately doing nothing, used to measure a zero baseline); B's 66% means "the official client already has a prefix underneath". Neither figure is a DoboCache result.** Both starting points say the same thing: the control arm's height is set by **how much prefix handling the requesting side does itself**. Read this table horizontally, "mounted vs not mounted" within one form — never vertically as "whose control arm is higher", and never subtract percentages across forms to claim a gain.


![Three requesting-side forms: not mounted vs mounted](hitrate-comparison-platforms.png)

| Requesting-side form | Version · source run | Control (not mounted) | Mounted (DoboCache) | Notes |
|---|---|---|---|---|
| A · WBX whitebox self-built, direct | v0.4.0 · exp 031 | 0.00% | 93.09% | Our own whitebox base, no prefix handling at all (structural zero baseline) |
| A · WBX whitebox self-built, direct | v0.4.2 · exp 032 | 0.00% | 91.89% | Same |
| B · DXH official Harness, headless | v0.4.0 · exp 033 | 66.00% | 96.85% | The requesting side ships ~2,560 tokens of global system-prefix cache; the control arm degrades 84.27% → 54.54% as noise accumulates |
| B · DXH official Harness, headless | v0.4.2 · exp 034 | 68.09% | 95.91% | Control baseline comes from the same provider-side system-prefix cache; the mounted arm holds per-round misses down to 135–426 tokens |
| C · COD-X common coding CLI (vendor G) | v0.4.2 candidate fix build · group 7 | 9.87% | 90.58% | Control arm measured zero on 18/20 requests; R10/R20 hit naturally via long-history prefixes |
| C · COD-X common coding CLI (vendor G) | v0.4.3 · group 8 | 0.00% | 98.59% | The main dataset in the table above |

Three points to read:

1. **Form B's 66%–68% is not credit to DoboCache, and it does not mean "the gain is small"** — the requesting side brings its own global system-prefix cache, giving the control arm a head start; that arm degrading 84.27% → 54.54% as noise accumulates shows its cache is just as fragile.
2. **Control-arm starting points span 0% to 68% across the three forms; the difference lies entirely in how the requesting side builds requests, so cross-form control values must not be compared.** Only "mounted vs not mounted" within the same form is comparable.
3. **Once mounted, all three forms land at 90%–98%**, which shows static prefix reuse is independent of the requesting-side form rather than a quirk of one client.
4. **A caveat on the denominator, which matters more than the numbers**: forms A / B are reported on an **aggregate basis over the 20 requests** (total cached tokens ÷ total prompt tokens), while form C is the **mean of the 20 per-request hit rates** — two different estimators, so compare orders of magnitude across forms, never add or subtract their percentages. Only "mounted vs not mounted" inside the same form is same-basis.

**A closer look at the COD-X pair (groups 7 and 8) — this is the cell most likely to be misread:**

Both runs share the same form, the same 20-request task set and the same control-arm construction (a *different* random-noise marker injected at the head of every control request, deliberately drifting the prefix); the only difference is the mounted version. The control arm mounts nothing, so it is independent of the version — the gap between "9.87% (group 7)" and "0.00% (group 8)" is **not** "newer version, worse baseline", it is the randomness of the injected noise:

- In group 7, requests R10 and R20 came after 10 and 19 rounds of accumulated history. The long-history prefix was long enough for the provider-side cache to match on its own, so those two requests read **99.27% / 98.10%**; the other 18 were broken up by the noise and read 0, which averages out to 9.87% over 20 requests;
- In group 8, the noise broke the prefix on all 20 requests, so every reading was 0 and the mean is 0.00%.

**Read the other way round, these two figures prove something that is *not* to this tool's credit: the provider's built-in cache is already good — as long as the prefix stays stable it can hit close to 99%.** Prefix stability is the only bottleneck throughout. What DoboCache does is make the prefix stable and keep it stable on every request; it does not conjure hits out of nothing. So "0%–9.87% unmounted" is a reading under **stress conditions** — it does not mean "the provider's cache is bad", and it must not be read as "mount it and you gain 98 points".

Group 7's mounted mean of 90.58% has the same explanation: R9, R13 and R16 hit provider-side jitter (53.08% / 85.53% / 0.00%). Excluding those three, the remaining 17 average **98.41%**, only 0.16pp from group 8's 98.57% on the same basis — the two versions agree on the stable segment, so there is no "8-point gain from the upgrade". Per-request comparison: `testdata/hitrate-regression-report-20261103.md`, section 6.

Unified reading: **not mounted ≈ 0%–68% (form-dependent), mounted 90%–98%.** Every row above maps to a recorded run (experiments 031 / 032 / 033 / 034 and groups 7 / 8) and to the `source_exp` / `recompute_file` fields of the summary CSV: `testdata/hitrate-multi-platform-summary-20261105.csv` — for forms A / B the numerators and denominators ship as token columns in the same row, while form C is a per-request mean whose per-request files sit in the same folder, so any cell can be recomputed. Per-request charts and the replot script: `scripts/hitrate-comparison.py`. No cell in this table is an estimate or a rounded-up guess.

### On the size of this test set: an honest note

The numbers come from 8 controlled groups, 20 consecutive requests per formal group, plus two earlier threshold-probing groups (5 and 10 requests).

First, the boundary: **the individual requests here are all small** — every round feeds the same AI-news-roundup topic, prefixes run from a few hundred to a few thousand tokens, and both the task texts and the per-request usage ship in `testdata/`, so anyone can redo the arithmetic.

**We did not test genuinely long tasks**: single requests in the tens of thousands of tokens, whole-codebase analysis, sessions dozens of turns deep — none of that is in the sample. Whether static prefix reuse holds at that scale is untested here, and we will not claim either way.

If you happen to have work like that, mount it, run it, and tell us what you see — recorded per-request usage beats any promise we could make. That is exactly why the per-request data, the task texts and the replay steps all ship in the package: **so you can check us instead of trusting us.**

## 5. The white-box report: every step visible

After each `cf_judge` / `cf_inject`, the log records what the step did, why, and with what effect. This record is a **v0.4.7-format sample** — field names, numbers and identifiers follow the current schema; the `label` / `note` strings are **translated here for readability** — the file itself stores the original Chinese text, and the untranslated record is in `README.zh.md` §5:

```json
{
  "requestId": "req-1b0ff98f",
  "ts": 1793709231484,
  "reqIndex": 2,
  "promptChars": 36,
  "rawTokens": 201,
  "optimizedTokens": 4096,
  "hitRate": null,
  "savedTokens": null,
  "savedPct": null,
  "changes": [
    {"kind": "align128", "label": "128-token prefix alignment", "detail": "appended 98 alignment blocks"},
    {"kind": "topup",    "label": "threshold top-up", "detail": "added 63 blocks (high-value fragments / doc chunks)"},
    {"kind": "scenario", "label": "first request / empty cache: lightweight constraints"}
  ],
  "note": "cf_inject: 201 raw tokens -> 4096 optimized tokens (prefix 4096 + tail); effective threshold 3450 tokens.",
  "sessionId": "sid-b6ca1662",
  "scenario": "first",
  "mode": "rebuild",
  "alignBlocks": 98,
  "prefixTokens": 4096
}
```

Three comparison capabilities survive sanitisation: **which request** (`reqIndex`), **whether it is the same prompt** (equal `req-...` values), and **what changed** (`changes[]` + `note`). The content itself is never written.

> `hitRate: null` means **not determined for this request**, not "0% hit". `cf_inject` runs at the *injection* stage — the request hasn't been sent yet, and DoboCache never sees the provider response unless you hand it over, so it writes `null` (undetermined) instead of pretending `0`. Up to v0.4.4 it wrote `0`, which read like a zero hit rate and contradicted the CSV figures that come from provider `usage`; that ambiguity is what v0.4.6 removes. To get a real hit rate recorded, pass `hitTokens` / `missTokens` (taken from the provider's `usage`) to the call. Cumulative stats come from `cf_report`. See §1 of `FAQ-使用须知.md`.

### White-box cards are off by default (v0.4.6)

The white-box report card is written **into the conversation context**, which costs tokens (roughly 300+ tokens per card, and every tool call could carry one). Since v0.4.6:

- **Default (`quiet`)**: the report is written to the local log only, is **not returned** with the tool result, and costs no conversation tokens;
- **Want cumulative numbers**: call `cf_report` — it reads the local log and costs nothing extra;
- **Want per-call detail**: set `DOBOCACHE_WHITEBOX=` `once` (next call returns one report, then falls back to `quiet` automatically) or `always` (every call returns a report — that is the ~300+ tokens per call);
- **First run**: a one-time notice pointing at the log path and the switch; it never repeats.

| Mode | Report returned with the call | Conversation tokens | When to use |
|---|---|:---:|---|
| `quiet` (default) | No — local log only | none | everyday use |
| `once` | Once, then auto-back to `quiet` | one-off | "did it actually work?" |
| `always` | Every call | ~300+ each | running controlled experiments and reading every request |

## 6. Install and mount (three launch modes)

1. Unzip `dobocache-v0.4.7-portable.zip` (bundles `dist` and a **production-only** `node_modules`; no `npm install` needed, and no native `.node` binaries, so a different machine or OS will not fail on an ABI mismatch);
2. Add a **stdio** MCP server in your client's config (pick one of the three modes below);
3. Restart the client and confirm **9 tools** appear (`ping` plus `cf_judge` / `cf_tier` / `cf_inject` / `cf_warmup` / `cf_report` / `cf_meter` / `cf_prune` / `cf_normalize`). A missing tool means the server did not start — check the client log for the server's stderr.

> **Prerequisite**: Node.js **18 or newer**. The process self-checks at startup and, if the version is too old, prints one plain-language message and exits (no silent failure).
> **General advice**: always put **absolute paths** in the config. Clients do not hand your shell's working directory or PATH to the spawned server, and a bare `node` or a relative path is the single most common cause of failure.

### Mode A: absolute `node` + entry js (recommended)

Windows:

```json
{
  "mcpServers": {
    "dobocache": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\dobocache\\dist\\index.js"]
    }
  }
}
```

macOS / Linux:

```json
{
  "mcpServers": {
    "dobocache": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/<you>/dobocache/dist/index.js"]
    }
  }
}
```

- **Use when**: unzip-and-run convenience, offline or intranet machines, or clients launched from a non-login user / unusual working directory.
- **Finding node**: `where node` on Windows; `which node` on macOS / Linux (Homebrew: `/opt/homebrew/bin/node` or `/usr/local/bin/node`; with nvm, use the absolute path inside the version directory).
- Needs no `npm` and no network — the most robust mode across machines.

### Mode B: one-shot `npx -y` (⚠️ not on npm yet — use Mode A for now)

> ⚠️ **Not on npm yet**: `dobocache` has not been published to the npm registry (`npm view dobocache` returns `404`). Modes B and C are placeholders — **use Mode A (portable zip) until it is published**, otherwise the install will fail.

```json
{
  "mcpServers": {
    "dobocache": {
      "command": "npx",
      "args": ["-y", "dobocache@0.4.7"]
    }
  }
}
```

- ⚠️ **On Windows you must write `npx.cmd`** (`"command": "npx.cmd"`). npm installs only `npx.cmd` on Windows — there is no `npx.exe` — so a client calling `spawn("npx")` fails with `ENOENT`. This is the most frequent MCP-on-Windows error.
- On macOS / Linux keep `npx`; if the client spawns through a non-login shell whose PATH lacks node, use an absolute path such as `/usr/local/bin/npx`.
- **Use when**: you want automatic version tracking, the machine is online, and you would rather not extract a zip.
- **Caveat**: the version must be published to npm first — **use Mode A until then**. `npx` also caches; if an upgrade appears not to take effect, run `npm cache clean --force` or switch to Mode C.

### Mode C: global install, call the command directly

```bash
npm install -g dobocache@0.4.7
```

```json
{
  "mcpServers": {
    "dobocache": {
      "command": "dobocache"
    }
  }
}
```

- ⚠️ **Same extension caveat on Windows**: write `"command": "dobocache.cmd"`. If the client still cannot find it, use the absolute path of the installed launcher (the `dobocache.cmd` inside the directory whose parent `npm root -g` reports).
- **macOS / Linux permission errors**: `npm install -g dobocache@0.4.7 --prefix ~/.npm-global`, then point the config at `/Users/<you>/.npm-global/bin/dobocache`.
- **Use when**: one machine, long-term use, no repeated downloads. Upgrade by re-running `npm install -g dobocache@<new version>` and restarting the client.

Comparison:

| Mode | Needs network | Needs npm | Path control | Upgrade | Best for |
|---|:---:|:---:|---|---|---|
| A absolute node | No | No | Highest (hard-coded) | Swap folder / edit config | **Recommended**: portable zip, offline, intranet |
| B `npx -y` | Yes | Yes | Medium (npm decides cache dir) | Change version / automatic | Trials, following releases |
| C global install | Yes, at install | Yes | Medium | Re-run install | Single machine, long-term |

> **Running `npm test` / `npm run lint`?** The portable package ships production dependencies only — run `npm install` once inside the extracted folder (network required) to pull in the dev dependencies first.

**Log directory** (since v0.4.4 it no longer depends on the process working directory, so any cwd a client spawns from works):

| Platform | Default log directory |
|---|---|
| Windows | `%LOCALAPPDATA%\DoboCache\logs` (e.g. `C:\Users\<you>\AppData\Local\DoboCache\logs`) |
| macOS | `~/Library/Logs/DoboCache` |
| Linux | `$XDG_STATE_HOME/dobocache` (falls back to `~/.local/state/dobocache`) |

Priority: `DOBOCACHE_LOG_DIR` environment variable > platform default > `<cwd>/data/logs` (fallback) > if none is writable, no file is written, one warning goes to stderr, and the process keeps running. The directory actually used is reported as `logDir` / `logFile` by `cf_report`.

Where the target vendor's threshold is clearly higher than the default (some vendors require 1806+), pass `minPrefixTokens` to `cf_inject`, e.g. `minPrefixTokens=3000`. The effective threshold is that value × 1.15 (safety margin).

**All environment variables** (every one is optional; omit it and the default applies):

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `DOBOCACHE_LOG_DIR` | White-box log directory | Platform default (table above) | **Use an absolute path**; a relative path resolves against the server process's cwd, so the result is unpredictable |
| `DOBOCACHE_HIT_PRICE_PER_M` | Cache-hit price coefficient | `0.014` | Used by `cf_meter` / `cf_report` for relative cost conversion; **must be a finite number ≥ 0**. An invalid value (`abc`, `-1`) falls back to the default and prints one stderr warning |
| `DOBOCACHE_MISS_PRICE_PER_M` | Cache-miss price coefficient | `0.5` | Same as above |
| `CACHEFORGE_LOG_DIR` / `CACHEFORGE_HIT_PRICE_PER_M` / `CACHEFORGE_MISS_PRICE_PER_M` | Backward-compatible aliases | — | Pre-rename names still work; `DOBOCACHE_*` wins when both are set |

> **Replace the price coefficients with your own contracted numbers.** The shipped defaults only express the **relative** hit-vs-miss ratio (roughly 1:36); they are not any vendor's real price. The `Usd` in `savedUsd` / `cumSavedUsd` is a historical field name — the value is "relative cost converted at the current coefficients". Changing the coefficients scales the whole curve proportionally and does not affect the hit rate.

## 7. Privacy: your prompt text is not in the log

Since **v0.4.4**:

- `requestId` stores only `req-<8-hex>` (fixed salt + 64-bit fingerprint) — **stable for identical text, not reversible**;
- `sessionId` stores only `sid-<8-hex>`;
- the `cf_normalize` key stores only `nk-<16-hex>`;
- two numeric-only fields `round` (request index; renamed `reqIndex` in v0.4.6) and `promptChars` were added, preserving comparability without content;
- writes go through a field whitelist, so future fields carrying text still cannot reach the log;
- **the log stays local and is never uploaded**; the default location is the platform log directory (Windows `%LOCALAPPDATA%\DoboCache\logs`, macOS `~/Library/Logs/DoboCache`, Linux `~/.local/state/dobocache`), and it is never bundled with the package.

Before and after, same record:

| Field | v0.4.3 and earlier | v0.4.4 |
|---|---|---|
| `requestId` | `Summarise the main AI developments in October 2026, grouped by vendor and direction.::1793718183368` | `req-ec142df8` |
| `sessionId` | `CustomerA-2026Q4-ProjectX` | `sid-8a0a11e6` |
| `reqIndex` / `promptChars` | absent | `1` / `36` |
| Other numeric fields | original values | **identical** |

> ⚠️ **Historical logs are still yours to clean up**: v0.4.4 cannot retroactively rewrite files produced by earlier versions. If `data/logs/*.jsonl` from v0.4.3 or earlier exists on your machine (older builds wrote it under whatever directory they were launched from), its `requestId` still contains prompt text — delete or archive it as your policy requires.

## 8. Client compatibility

Only statements backed by official documentation or a clear source are included; anything unverified is marked "unconfirmed", with no speculation.

| Client | stdio MCP | Custom OpenAI-compatible `base_url` | Forced private protocol | Cache usage visibility |
|---|:---:|:---:|---|---|
| Claude Desktop | ✅ (JSON config) | Unconfirmed (no endpoint field in docs) | Vendor's own API protocol | Unconfirmed |
| Cursor | ✅ (`.cursor/mcp.json`) | ❌ Not supported: official vendor keys only, **no `base_url` field** | None, but effectively official endpoints only | Unconfirmed |
| Cline | ✅ | ✅ (Base URL + API key + model ID) | No (`/v1/chat/completions`) | Unconfirmed |
| Continue | ✅ (yaml / json) | ✅ (`provider: openai` + `apiBase`) | No | Unconfirmed |
| Codex CLI | ✅ (`~/.codex/config.toml`) | ✅ (`base_url` / `env_key` / `wire_api` under `[model_providers]`) | Optional: `wire_api` is `chat` or `responses` | ✅ telemetry carries `cached_token_count` (`responses` only) |
| Gemini CLI | ✅ | Unconfirmed (Gemini / Vertex ecosystem) | Yes (Gemini protocol) | ✅ cached tokens via `/stats` (API key / Vertex only) |
| Cherry Studio | ✅ (UI: stdio/SSE/HTTP) | ✅ (custom provider: key + endpoint) | No (OpenAI-compatible optional) | Unconfirmed |
| Trae | ✅ (UI JSON or project `.trae/mcp.json`) | ✅ (OpenAI Chat Completions + custom request URL) | No | Unconfirmed |
| Windsurf | Unconfirmed | Unconfirmed | Unconfirmed | Unconfirmed |

How to read it:

- **Mounting (stdio MCP)**: 7 of the 8 clients above document stdio configuration; Windsurf could not be verified and is left out of the supported list for now.
- **Whether requests can be pointed at your OpenAI-compatible endpoint**: 5 support it explicitly (Cline / Continue / Codex CLI / Cherry Studio / Trae); **Cursor cannot use a custom endpoint**; **Claude Desktop and Gemini CLI show no compatible endpoint entry in their docs**.
- **Where cache-hit data is visible**: only 2 have documentation-level evidence, and **neither is "the client panel shows cache hit rate"** — Codex CLI exposes it as an OTel telemetry field, Gemini CLI via `/stats`. This document therefore **does not claim that clients display cache hit rates in their panels**. The accurate statement is: **DoboCache reads the cache fields of the vendor API's usage response on the server side and records and returns them**; per-client visualisation needs to be verified case by case.

The full version (config paths and formats per client, 18 source links, unconfirmed list) is in `兼容性说明.md` (Chinese).

## 9. How to reproduce

Every number here ships in `testdata/`, so you can check and re-run it:

| File | Purpose |
|---|---|
| `testdata/hitrate-regression-report-20261103.md` | This run regression report: setup, all 20 requests, criterion-by-criterion verdicts |
| `testdata/hitrate-task-inventory-20261103.md` | The 20 task prompts verbatim, parameters of all 8 experiment groups, re-run notes |
| `testdata/hitrate-testdata-20261103.csv` | Per-request data (`round,text_type,raw_tokens,opt_tokens,hit_rate,saved_tokens,platform`; `round` is a legacy column name meaning "which request") |
| `testdata/复跑说明.md` | Re-run procedure, acceptance criteria, four common pitfalls (Chinese) |
| `scripts/hitrate-comparison.py` | Redraws the chart from that CSV: `python scripts/hitrate-comparison.py` |

Shortest path to reproduce:

1. Unzip v0.4.7 and point your MCP config at `<extract-dir>\dist\index.js`;
2. Mounted arm: `cf_inject(reset=true, sessionId=<new session>, minPrefixTokens=<vendor threshold>)`, then send the 20 requests from the task inventory;
3. Control arm: identical task text, but **inject different random noise at the head of every request** (see below);
4. Take the **second** request's vendor usage on each request (the first builds the cache, the second is the measurement);
5. Acceptance: `prefixReady=true` in the log and `effectiveMinPrefixTokens = configured threshold × 1.15`; the mounted arm should stay above 90%, the control mostly at 0.

> ⚠️ **Re-run must-read**: if the control arm does not get random noise on each request's prefix, the vendor's automatic prefix cache will make the control **hit as well**, and the comparison becomes meaningless. This is the step most easily done wrong.

## 10. Known limitations and non-commitments

Read this before installing. Each item below is a **capability boundary**, not a to-do.

**1. Hits require a byte-stable prefix — this tool cannot guarantee it for you**

A cache hit depends on whether the request prefix (system prompt, tool list, message order, header fields) is identical to the previous request. If your client injects timestamps, random IDs, or a changing tool set into the head, or reorders history, hit rate drops. `cf_inject` can normalise the parts you control, but it **cannot stop a client from altering the prefix**, and cannot force a hit after the fact.

**2. The provider must support prefix caching and have it enabled**

Providers differ in the minimum cacheable prefix length (this project's measurement convention uses "configured threshold × 1.15" as the effective threshold). If the endpoint does not support prefix caching, or it is disabled on the account, the hit rate is zero. **This tool does not change provider behaviour and cannot create hits on a provider that does not support them.**

**3. It reads usage fields the provider already returns — it does not estimate**

Hit figures come from the cache fields in the provider's API usage response. **When the client or provider does not return that field, the number is simply absent from the report** — this project shows "undetermined" rather than estimating a flattering figure from character counts.

**4. `savedUsd` / `cumSavedUsd` are relative values, not a bill**

The bundled default price coefficients exist only for relative hit-vs-miss comparison. They are not any vendor's real rate, and the `Usd` in the field names is historical naming. Substitute your own contract coefficients if you need money; hit rate is unaffected by the coefficients.

**5. No semantic cache, no cross-session content reuse**

This tool does not proxy, forward, or store your prompt text, and does not reuse content at a similarity or semantic level. Asking the same question in different words is not counted as a hit.

**6. Transport is stdio MCP only**

The current package provides stdio mounting only. No HTTP / SSE form. Items marked "undetermined" in the client compatibility table (including Windsurf) have no official documentation behind them: **they are not on the supported list, and no effectiveness claim is made for them.**

**7. The test set is small — this is not a benchmark**

The figures in section 4 come from a controlled 20-request experiment (same-shape plus four request shapes) and are reproducible, but **they are not a prediction for your workload**. See "On the size of this test set".

**8. What is explicitly not promised**

No promise is made about: a specific hit rate, a specific saving ratio or amount, results on any given provider/client combination, the size of any advantage over other caching approaches, or downstream business outcomes. Whether hits occur depends on your request shape and provider policy. **What this tool provides is a controllable stable prefix, admission judgement, and verifiable measurement — not a performance guarantee.**

**9. Switching clients or upgrading requires re-observation**

Changing the client, upgrading the package, or editing the system prompt or tool list invalidates the previously established cache prefix; re-observe per section 9. **Log files produced by older versions are not rewritten or deleted automatically** — clean them up yourself.

## 11. FAQ

Does `hitRate=null` mean it is broken? Why no hit on the first request? Where is the log and how do I read it? Do I need to clean logs when moving machines? See [`FAQ-使用须知.md`](FAQ-使用须知.md) (Chinese).

---

## Statement of disclosure discipline

This README and its companion materials follow one shared disclosure policy:

1. **Testbed anonymity**: the testbed is referred to only as "a common coding CLI tool", never by product name;
2. **No monetary figures**: only hit rates and relative ratios — no cost numbers anywhere;
3. **No improvement claims**: v0.4.7 is a "bounded logs + retrievable statistics" release whose caching core matches v0.4.4, described as "cache behaviour identical to v0.4.4", never as higher/faster/stronger;
4. **No mixing**: numbers from different experiments, integration paths or vendors are never compared directly.


---


---

## License

DoboCache is released under the **Apache License 2.0**. The full text ships in [LICENSE](../LICENSE) at the repository root and is also available at <https://www.apache.org/licenses/LICENSE-2.0>.

What that means for you:

- **Commercial use is allowed.** Use, modify, and redistribute DoboCache inside your company, in a commercial product, or behind a paid service — no fee, no license request, no notification required.
- **Closed-source derivatives are allowed.** You may embed it in a proprietary product, provided you keep the copyright and license notices and state the changes you made to modified files.
- **Express patent grant.** Section 3 of the Apache License 2.0 includes an express patent license from contributors, which matters if you are shipping this in a commercial setting.
- **No warranty.** The software is provided "AS IS", without express or implied warranties. You use it at your own risk.
- **Trademarks and names are reserved.** The license does **not** grant rights to the "DoboCache" name, the project name, or associated logos (Apache-2.0, Section 6). Fork it, ship it, build on it — just don't present your fork, service, or product as the official DoboCache release, and don't claim endorsement. Saying "based on DoboCache" is both allowed and appreciated.

## Pricing

DoboCache is a free and open-source project. There is **no paid tier, no subscription, no commercial license gate, and no plan to charge for it**. If commercial add-ons ever appear, they will be separate offerings and will not change the rights you already have under Apache-2.0 in this repository.

For **commercial partnerships, custom development, or enterprise support**, reach the author via the repository Issues. Such engagements are separate services and do not alter any right you already hold under Apache-2.0.

## Third-party components

This project depends on third-party open-source packages. Their licenses and notices are retained in the respective package directories (for example `node_modules/<package>/LICENSE`). Those licenses are **not** replaced or overridden by this project's Apache-2.0 license — keep them intact when you redistribute.

---

### Copyright and notice files

- `LICENSE` — the unmodified Apache License 2.0 text
- `NOTICE` — project name, copyright year, and trademark statement (retained on redistribution as required by Apache-2.0, Section 4(d))
