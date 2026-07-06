# Protoblock Run Protocol

Use this protocol for every protoblock run. It keeps separate agent runs comparable.

## Read Order

1. Repository `AGENTS.md`.
2. `protoblocks/AGENTS.md`.
3. This file.
4. `USEFUL_SOURCE_RUBRIC.md`.
5. `PROVIDER_SETS.md`.
6. The assigned protoblock file.

## Run Shape

Run each experiment in two passes:

1. Pilot: 3-5 cases, all intended output files, no shortcuts.
2. Full run: the sample size named in the protoblock, adjusted only for cost or provider failures.

Do not skip the pilot. A pilot catches broken provider auth, invalid fields, bad sampling, and impossible metrics before spending money.

## Run Folder

Create one folder per run:

```sh
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-<slug>-pilot"
RUN_DIR="protoblocks/src/<slug>/runs/$RUN_ID"
mkdir -p "$RUN_DIR"
```

Use this layout:

```text
runs/<run-id>/
  providers.json
  doctor.json              # optional; doctor makes live calls
  cases.jsonl
  sampling.md
  rows.jsonl
  manual-labels.jsonl      # if labels are used
  summary.json
  notes.md
  ledger.db
```

## Provider Inventory

Record provider state before running cases:

```sh
bun src/cli/main.ts providers --json > "$RUN_DIR/providers.json"
```

Run `doctor` only when the experiment owner asks for live validation or provider failures need diagnosis:

```sh
WIDEBAND_DB="$RUN_DIR/ledger.db" bun src/cli/main.ts doctor --json > "$RUN_DIR/doctor.json"
```

`doctor` makes real provider calls. Record that cost in the results log if you run it.

Use `PROVIDER_SETS.md` for default provider lists. If the live `providers.json` differs from that snapshot, use the live inventory and note the difference in `notes.md`.

## Ledger and Cache

Use a run-local ledger:

```sh
WIDEBAND_DB="$RUN_DIR/ledger.db" bun src/cli/main.ts research "<query>" --fresh --json
```

Use `--fresh` for provider-efficacy experiments. Cache hits hide provider cost, latency, and current result behavior.

## Dataset Snapshot

Write `cases.jsonl` before provider calls. Each line should satisfy `case.schema.json`.

Minimum case fields:

```json
{"id":"case-001","q":"example query","tags":["polymarket"]}
```

Record the sampling rule in `sampling.md`:

- Source endpoint or seed list.
- Date and UTC time sampled.
- Filters.
- Case cap.
- Exclusions.

Do not resample midway through a run. If sampling was wrong, start a new run.

## Result Rows

Write one JSON object per result row to `rows.jsonl`. Each row must satisfy `result-row.schema.json`.

Use one row per smallest meaningful unit:

- Provider experiments: one row per `(case, provider, mode)`.
- Leave-one-out: one row per `(case, excludedProvider)`.
- Dedup fixtures: one row per fixture or live duplicate candidate.

Required common fields:

```json
{
  "runId": "20260614T120000Z-example-pilot",
  "timestamp": "2026-06-14T12:00:00.000Z",
  "experiment": "01-polymarket-resolution-source-recall",
  "caseId": "market-slug",
  "provider": "exa",
  "query": "market question official source",
  "mode": "research",
  "sources": 10,
  "costUSD": 0.005,
  "latencyMs": 1842,
  "stats": {},
  "metrics": {}
}
```

Put experiment-specific measurements inside `metrics`.

## Usefulness Labels

Use `USEFUL_SOURCE_RUBRIC.md` for labels. Write manual labels to `manual-labels.jsonl`.

Manual labels should include:

```json
{"sourceId":"abc","url":"https://example.com","label":"A","useful":true,"reason":"official_source"}
```

Audit at least 20 rows or 10 percent of accepted useful sources, whichever is smaller. If the experiment has fewer than 20 rows, audit all rows.

## Cost Guard

Before the full run, estimate calls:

```text
cases x providers x modes x query_templates
```

Default cap: 200 provider calls per full experiment unless the user raises it. If the planned run exceeds the cap, reduce cases first, not providers, unless the experiment needs all cases for category balance.

## Failure Handling

Do not hide failures. Record a row with:

- `sources: 0`
- `costUSD: 0` unless wideband reports cost
- `stats.error` or `errors`
- `metrics.failureStage`

If one provider fails, continue the experiment. If all providers fail, stop after the pilot and append a failed result log entry.

## Summary

Write `summary.json` with:

- Run ID.
- Provider set.
- Case count.
- Call count.
- Cost.
- Main metrics.
- Three examples that changed the interpretation.
- Project changes justified: `none`, `measurement_fix`, `future_default_change`, or `needs_more_data`.

## Results Log

Append a dated entry to the bottom of the assigned protoblock file under `## Results Log`.

Use this template:

```md
### 2026-06-14 - <operator> - <run-id>

- Commit/worktree: <sha or "uncommitted">
- Commands: `<exact command or script>`
- Providers: <provider list>
- Dataset: <case count and sampling rule>
- Cost: <reported USD>
- Key metrics: <short table or bullets>
- Interpretation: <what changed your mind>
- Follow-up: <next useful experiment>
- Project change justified: <none | measurement_fix | future_default_change | needs_more_data>
```

## Subagent Boundary

Subagents may edit:

- Their assigned protoblock markdown file, only under `## Results Log`.
- Their assigned `protoblocks/src/<slug>/` folder.

Subagents must not edit:

- `src/core`.
- Provider adapters.
- Other protoblock files.
- Repository docs outside `protoblocks/`.

If a measurement bug blocks the run, write it in `notes.md` and the results log instead of fixing it during the experiment.
