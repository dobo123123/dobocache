# Show: a local MCP proxy that keeps your prompt prefix stable, and logs every step

**Repo:** https://github.com/dobo123123/dobocache · **Release v0.5.2:** https://github.com/dobo123123/dobocache/releases/tag/v0.5.2 · **Evidence, docs & test data:** https://github.com/dobo123123/dobocache/tree/main/release

*An open-source, fully local tool for coding CLIs / agent clients — mount it as a **stdio MCP server** or as a **local proxy**. No network calls, no telemetry, no sign-up.*

**TL;DR** — Prompt caching only pays off if your request prefix is byte-identical across requests. Mine almost never was. This tool rebuilds the prefix, aligns it to cache block boundaries, and writes a whitebox log of exactly what it changed. 20-request A/B: control group 0.00% cache hit (20/20 requests at zero), test group mean 98.59% (range 96.08%–99.79%, 0/20 requests at zero).

---

## 1. The problem: "it looks the same" is worth nothing

Most providers cache the request prefix: if the beginning of a request is byte-identical to the previous one, that part hits the cache instead of being recomputed.

I watched my own usage for a week and found the hit rate was erratic — sometimes zero for an entire long conversation. The provider was not at fault. My requests were:

1. **Reordered** — system prompt position, tool description order changed between requests;
2. **Misaligned** — after trimming history, the prefix tail ended mid-block (128-token granularity), so the trailing half-block never hit;
3. **Too short** — the prefix was under the provider's minimum cacheable length, so it never even entered the cache;
4. **Dirty** — duplicated instructions and repeated doc blocks bloated the prefix.

Any one of those and the *entire* prefix invalidates. You think you're caching; you're recomputing from scratch on every request.

## 2. What it does

Three actions, all logged:

| Action | Fixes |
|---|---|
| `dedup` | Collapses duplicate instructions / repeated content |
| `align128` | Aligns prefix tail to 128-token cache block boundaries |
| `topup` | Pads short prefixes to the provider's minimum effective cache length |

Plus `cf_report` (cumulative stats), `cf_meter` (usage snapshot), `cf_normalize` (normalize content, returns a content-free fingerprint).

Two ways to mount it, one shared core (since v0.5.0):

| Mount | How | Best for |
|---|---|---|
| **A. stdio MCP** (original) | Point the client's MCP config at `dist/index.js` | Clients that speak MCP |
| **B. Local proxy `dobostitch`** (new in v0.5.0) | Start a local proxy, point the client's `baseURL` at it | Clients **without** MCP support, or people who don't want to restructure their config |

B is the only option for clients that can't do MCP — and it requires **no config file editing at all**:

```bash
npx -y dobocache@0.5.2 dobostitch start
# or unzip the portable build and double-click start-dobostitch.cmd
# the terminal prints: 接入 baseURL 填：http://127.0.0.1:27880/anthropic
```

Paste that URL into the client's **baseURL** (swap the prefix for your vendor: `/anthropic`, `/openai`, `/deepseek`). Key, model name and request body stay untouched. From the **2nd request** on, the terminal card shows the hit-rate percentage; the first requests read "未判定 (vendor did not return usage)" — that's expected, not 0%. Liveness check: `http://127.0.0.1:27880/__dobostitch/health` (note: **not** `/health`).

Stated boundaries, same as always: the proxy path is verified on **Windows 11 hardware only**; Linux/macOS unverified. **Install one, not both.**

## 3. The 20-request A/B

One progressive 20-request conversation (AI news recap; each request builds on the accumulated history). The requesting side was **"a common coding CLI tool"** wired to a provider referred to here as **vendor G**; the whitebox engine mounted DoboCache over stdio MCP. Same machine, same model, same parameters. The **only** difference is whether the proxy was mounted.

| Metric | Control (no mount) | Test (mounted) |
|---|---|---|
| Mean hit rate, 20 requests | **0.00%** (all 20 requests at zero) | **98.59%** |
| Range | — | **96.08% – 99.79%** |
| Requests with zero hits | 20 / 20 | **0 / 20** |
| Prefix ready | — | **20 / 20** |

Two things I want to be precise about, because they're where this kind of experiment usually goes wrong:

**(a) The control group's zeros are engineered, not cherry-picked.** Every control request injects a *different* random noise marker at the head of the request, so the prefix drifts. Without that noise, the control group hits a substantial share of its own input — and then you're no longer comparing "with vs. without the tool", you're comparing "what state the provider's cache window happened to be in". Anyone reproducing this: do not skip the noise injection.

Not a theoretical concern. I ran the same mounting logic for 20 requests under three requesting-side forms (later referred to by codes — **WBX** = the whitebox direct client I wrote myself, **DXH** = official Harness headless, **COD-X** = a common coding CLI; the codes abbreviate the *type* of requesting side, not any specific product):

| Requesting-side form | Version (source run) | No mount (control) | Mounted (test) |
|---|---|---|---|
| WBX whitebox self-built, direct | v0.4.0 (031) / v0.4.2 (032) | 0.00% / 0.00% | 93.09% / 91.89% |
| DXH official Harness, headless | v0.4.0 (033) / v0.4.2 (034) | 66.00% / 68.09% | 96.85% / 95.91% |
| COD-X common coding CLI | v0.4.2 candidate (group 7) / v0.4.3 (group 8) | 9.87% / 0.00% | 90.58% / 98.59% |

The "whitebox engine, direct" rows sit at 0% for a reason worth stating plainly: **that client is a whitebox test base I wrote myself** (not any official client), and **it deliberately does no prefix handling at all** — no prefix construction, no cache warm-up, no session reuse; each round sends only "task text + random noise". With no reusable prefix on hand, zero is the only possible reading. It is a **structural zero baseline**, not evidence that a provider's cache collapsed.

The "official Harness" form ships ~2,560 tokens of provider-side global system-prefix cache per new session, so its control arm sits at 66%–68% for free (exp 033: 51,200 cached tokens = 2,560 × 20 — divide it yourself; the whole 66% is the official prefix, nothing to do with this plugin). But don't envy it: in the v0.4.0 batch that arm degraded from 84.27% down to 54.54% as request noise accumulated — just as fragile, only starting higher.

So the accurate statement is: **not mounted ≈ 0%–68% (form-dependent); mounted 90%–98%.** Cross-form control values are not comparable — only "mounted vs not mounted" within the same form is. (Basis note: the A/B rows are aggregate over the 20 requests, the C rows are the mean of per-request rates — different estimators, so read them as magnitudes only. Every cell maps to a row of the shipped `testdata/hitrate-multi-platform-summary-20261105.csv` via its `source_exp` field, numerators and denominators included — recompute it yourself.)

**On the COD-X pair (9.87% and 0.00%)** — this one needs spelling out, because it reads far too easily as "this tool takes hits from 0 to 98". Same form, same 20-request set, same control construction (a *different* random marker in the head of every control request); the only difference is the mounted version, and the control arm mounts nothing, so it is version-independent. The gap is noise randomness: in group 7, R10 and R20 came after 10 and 19 rounds of accumulated history, the long prefix was long enough for the provider-side cache to match on its own, and those two read **99.27% / 98.10%**; in group 8 the noise broke all 20 requests, so every reading was 0.

Which is to say, these numbers show the provider's own cache is already strong — **with a stable prefix it reaches close to 99%**. Prefix stability is the only bottleneck throughout. What I built stabilises the prefix; it does not manufacture hits. So don't read the two cells as "a 98-point gain" — that is a stress condition I set up myself, not anyone's daily baseline.

Also, why group 7's mounted mean (90.58%) trails group 8's by 8 points: R9, R13 and R16 hit provider-side jitter (53.08% / 85.53% / 0%). Drop those three and the remaining 17 average **98.41%**, 0.16pp from group 8's 98.57% on the same basis — the two versions agree on the stable segment; the upgrade did not buy 8 points.

**(b) Hit rate is a ratio inside each group's own input.** The two groups have different absolute input sizes (control grows 39 → 2738 tokens as history accumulates; test stays at prefix + tail). Do **not** convert between groups, and don't mix these numbers with other experiments.

**(c) I only tested short requests — you should know that up front.** 8 controlled groups, 20 consecutive requests each, and every round is a few hundred to a few thousand tokens of news-roundup text. **I did not test long tasks**: single requests in the tens of thousands of tokens, whole-repo analysis, sessions dozens of turns deep. Whether prefix reuse holds there is untested, so I won't pretend it does.

If you have that kind of workload, mount it, run it, and send me the per-request usage — that's worth more than any number I could put in this post. The per-request data, the task texts and the replay steps are all in the package; I expect people to check me.

## 4. What the whitebox log looks like

One JSONL record per `cf_inject`, sanitized:

```json
{
  "requestId": "req-1b0ff98f",
  "ts": 1793709231484,
  "reqIndex": 2,
  "promptChars": 36,
  "rawTokens": 201,
  "optimizedTokens": 4096,
  "changes": [
    {"kind": "align128", "detail": "追加 98 个对齐块"},
    {"kind": "topup",    "detail": "补充 63 块（高价值片段/文档块）"},
    {"kind": "scenario", "label": "first request / empty cache: lightweight constraints"}
  ],
  "note": "cf_inject: 201 tokens in → 4096 tokens out (prefix 4096 + tail); effective threshold 3450 tokens.",
  "sessionId": "sid-b6ca1662",
  "prefixTokens": 4096
}
```

*(`detail` strings are emitted in Chinese by the tool itself; left verbatim.)*

This is more useful than the headline number: when something breaks you can see *which* step didn't fire, what the threshold was, and how many blocks were padded.

## 5. v0.4.4 → v0.4.7: privacy, then honesty about numbers

Previously the `requestId` field stored **the user's verbatim prompt**. The log is local and never uploaded, but local plaintext prompts are still a liability. v0.4.4:

- `requestId` → `req-<8-char hash>` (stable for identical text, not reversible)
- `sessionId` → `sid-<8-char hash>`
- Two new numeric fields, `round` (request index; renamed `reqIndex` in v0.4.6) and `promptChars`, preserving the ability to tell "which request" and "same question or not"
- A field allowlist on write: future fields carrying body text cannot leak in

Verified on 5 real smoke requests: `cf_judge` / `cf_inject` output is **byte-identical** to the previous release, `prefixHash` is constant, MD5 of the hit-path code is unchanged, 94 tests green.

**No performance claim.** Hit rate is identical to the previous release. Don't expect the number to go up.

Note: logs produced by older versions still contain verbatim prompts. Upgrading does not rewrite history — clean those yourself.

### What v0.4.6 changes

- **Whitebox cards are off by default.** The card lands in the conversation context, so it costs tokens (~300+ each, and every tool call could carry one). Default mode is `quiet`: log to disk, return nothing. `cf_report` gives you cumulative numbers without spending conversation tokens; `DOBOCACHE_WHITEBOX=once` returns a single report then falls back; `always` returns one every call.
- **No more `hitRate: 0` pretending to be a measurement.** The inject stage runs before the request is sent, so the real hit rate cannot be known there. v0.4.6 writes `null` (undetermined) instead of `0` — the old value collided with the CSV numbers sourced from provider `usage` and read like a contradiction. Pass `hitTokens` / `missTokens` if you want the real figure logged.
- **The word "round" is gone.** It never had a stable meaning here (one LLM request? one user turn? one tool call?). The log field named `round` was always "the n-th request this process made", so it is now `reqIndex`, and the docs say "request" everywhere.
- **The bundled evidence is CSV-only.** The bundle ships the CSV (figures from provider `usage`), the task inventory and the regression report.

### What v0.4.7 changes

Two more things that aren't functional bugs but will bite you if the server just sits there running:

- **The log had no upper bound.** Mounted in a client and left running, the file only ever grows until it quietly fills the disk. v0.4.7 maintains it: roll over to `.1` at 10 MB, keep at most 3 copies, delete anything older than 7 days — and **only touch its own `dobocache-*.log.jsonl`**; other files in the same directory are never touched. `cf_report` exposes the active policy as `logPolicy`, and `logMaintenance` reports what a real cleanup deleted and freed. Tune with `DOBOCACHE_LOG_MAX_MB` / `DOBOCACHE_LOG_KEEP_DAYS`.
- **Cumulative stats died on every restart.** `cf_report` used to read process memory only, so restarting the MCP client wiped the numbers — and "0" reads like "the whitebox never worked". Pass `source="disk"` to re-aggregate from the local log files, with `days` for the look-back window (defaults to the retention period). Semantics are identical to the in-memory path — `hitRate` averages only decidable rows and stays `null` when nothing is decidable; no fabricated 0%.
- **`cf_prune` naming clarified (behaviour unchanged).** The name suggests log cleanup; it only trims the `text` you pass in and never reads or deletes any file on disk. Only the description was rewritten.

**The cache core is still untouched** — prefix freezing, alignment, tiered admission and hit judgement are identical to v0.4.4 / v0.4.6. This release only changes the log lifecycle and how cumulative stats are read, so the hit rate does not go up.

## 6. Client compatibility (documented only)

I'm only listing what official docs actually state; anything else is marked unconfirmed.

- **stdio MCP mounting**: Claude Desktop, Cursor, Cline, Continue, Codex CLI, Gemini CLI, Cherry Studio, Trae.
- **Can point requests at a custom OpenAI-compatible endpoint**: Cline, Continue, Codex CLI, Cherry Studio, Trae (5). **Cursor cannot** — it accepts official vendor keys but has no `base_url` field. Claude Desktop and Gemini CLI have no compatible-endpoint entry in their docs.
- **Can you see cache hits inside the client?** Documented evidence exists for exactly two, and neither is a UI panel: Codex CLI (OTel telemetry field `cached_token_count`, responses only) and Gemini CLI (`/stats`). So the defensible claim is: **the server reads the provider's usage cache field and records / returns it**. Per-client visualization needs individual testing.

Windsurf is deliberately excluded — its docs site was unreachable during the survey, so nothing could be verified.

## 7. Reproducing it

Everything is under `release/` in the repo: the 20 task prompts (verbatim, so runs are comparable), the per-request CSV, the regression report, and a reproduction guide with the pitfalls.

Three things you must get right:

1. Test group: `cf_inject(reset=true, sessionId=<fresh>, minPrefixTokens=<provider threshold>)` — for providers with high thresholds, pass 3000 (effective 3450);
2. Send each request **twice**, take the **second** request's usage (the first builds the cache);
3. Control group: inject **different** random noise at the head of every request.

Acceptance: `prefixReady=true`, `effectiveMinPrefixTokens` equals configured threshold × 1.15, test group above 90% from the second request onward.

## 8. Who this is not for

- One-off or two-request chats: request 1 is the cache build, zero hits by definition.
- Short contexts below the provider's minimum cacheable length: nothing to save.
- Clients that can't take a custom endpoint (Cursor): the request never reaches the endpoint, so mounting the MCP server alone does nothing.
- People who want a dollar figure: this project deliberately reports **no monetary numbers**, only hit rates and relative ratios. Provider billing rules differ too much for cross-group conversions to be trustworthy.

## 9. Closing

The hard part isn't the caching technique — it's that **you have no idea whether your caching works at all**. The whitebox log is aimed squarely at that.

Counter-examples welcome. If your control group hits heavily *without* noise injection, or your prefix stability is far worse than this, that's genuinely useful data.

**Want to try it?** The step-by-step setup guide (Chinese, beginner level, `零基础三分钟上手.md`) lives in [`release/`](https://github.com/dobo123123/dobocache/tree/main/release) — six steps from installing Node to verifying success. If you hit an error, the FAQ section there lists 13 common install failures indexed by the exact error message.

Direct download: [dobocache-v0.5.2-portable.zip](https://github.com/dobo123123/dobocache/releases/download/v0.5.2/dobocache-v0.5.2-portable.zip) (~6.5 MB, per-request evidence included); `SHA256SUMS.txt` alongside.

*Generated with AI assistance; for reference only.*
