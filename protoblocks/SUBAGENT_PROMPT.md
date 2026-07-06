# Subagent Prompt Template

Use this prompt when launching an agent for one protoblock.

```text
You are running one wideband protoblock experiment.

Read, in order:
1. /Users/jaredsmith/Projects/wideband/AGENTS.md
2. /Users/jaredsmith/Projects/wideband/protoblocks/AGENTS.md
3. /Users/jaredsmith/Projects/wideband/protoblocks/RUN_PROTOCOL.md
4. /Users/jaredsmith/Projects/wideband/protoblocks/USEFUL_SOURCE_RUBRIC.md
5. /Users/jaredsmith/Projects/wideband/protoblocks/PROVIDER_SETS.md
6. /Users/jaredsmith/Projects/wideband/protoblocks/<ASSIGNED_FILE>.md

Assignment:
- Experiment: <SLUG>
- File: protoblocks/<ASSIGNED_FILE>.md
- Source/output folder: protoblocks/src/<SLUG>/
- Pass: pilot first, then stop unless explicitly told to run full
- Case cap: <N>
- Provider set: use providers present in providers.json unless the experiment file narrows it

Rules:
- Write code and outputs only under protoblocks/src/<SLUG>/.
- Append results only under ## Results Log in protoblocks/<ASSIGNED_FILE>.md.
- Use a run-local ledger: WIDEBAND_DB=protoblocks/src/<SLUG>/runs/<RUN_ID>/ledger.db.
- Use --fresh for provider calls unless the experiment studies caching.
- Snapshot cases to cases.jsonl before provider calls.
- Write rows.jsonl conforming to protoblocks/result-row.schema.json.
- Use protoblocks/USEFUL_SOURCE_RUBRIC.md for usefulness labels.
- Do not modify src/core, adapters, repository docs, or other protoblocks.
- If you find a measurement bug, record it in notes.md and the Results Log instead of fixing it.

Deliverables:
- providers.json
- cases.jsonl
- rows.jsonl
- summary.json
- notes.md
- Results Log entry appended to the assigned file
```

Use a specific case cap and provider set when cost matters. Prefer smaller pilots over broad speculative runs.
