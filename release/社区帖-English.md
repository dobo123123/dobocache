# Show: a local MCP proxy that keeps your prompt prefix stable, and logs every step

*An open-source, fully local MCP server for coding CLIs / agent clients. No network calls, no telemetry, no sign-up.*

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

Transport is stdio MCP — point the client at `dist/index.js`.

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

**(b) Hit rate is a ratio inside each group's own input.** The two groups have different absolute input sizes (control grows 39 → 2738 tokens as history accumulates; test stays at prefix + tail). Do **not** convert between groups, and don't mix these numbers with other experiments.

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

**Want to try it?** The step-by-step setup guide (Chinese, beginner level) is `零基础三分钟上手.md` in the repo root — six steps from installing Node to verifying success. If you hit an error, the [FAQ troubleshooting section](FAQ-使用须知.md) lists 13 common install failures indexed by the exact error message.

*Generated with AI assistance; for reference only.*
