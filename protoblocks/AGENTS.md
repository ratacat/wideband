# protoblocks

Protoblocks are short-term experiments for learning how wideband's search providers behave. They are not product scope. Use them to buy evidence before changing defaults, adding features, dropping providers, or expanding the core engine.

## Rules

- Keep each experiment bounded and disposable.
- Prefer the existing CLI and SDK. Do not add public APIs for a protoblock.
- Do not change `src/core` unless the experiment exposes a measurement bug.
- Do not add dependencies without a short justification in the experiment file.
- Do not store secrets, provider keys, cookies, or private data in this folder.
- Run from the repository root unless the experiment says otherwise.
- Before running an experiment, read `RUN_PROTOCOL.md`, `USEFUL_SOURCE_RUBRIC.md`, `PROVIDER_SETS.md`, and the assigned protoblock file.
- Start with a pilot run of 3-5 cases before running the full sample.
- Use `--fresh` for provider-efficacy runs unless the protoblock explicitly studies caching.
- Use a per-run ledger: `WIDEBAND_DB=protoblocks/src/<slug>/runs/<run-id>/ledger.db`.
- Write result rows that conform to `result-row.schema.json`.

## Files

- Each protoblock has one markdown file in `protoblocks/`.
- Each protoblock's code, scratch data, and temporary outputs live under `protoblocks/src/<protoblock-slug>/`.
- Put generated outputs under `protoblocks/src/<protoblock-slug>/runs/<timestamp>/` when possible.
- Keep reusable helper code in that protoblock's source folder unless two or more completed experiments prove it should be shared.
- Save sampled datasets as `cases.jsonl` before provider calls. Do not let a live API sample drift during a run.
- Save provider inventory as `providers.json` in the run folder.

## Result Logging

When an experiment finishes, append results to the bottom of its markdown file under `## Results Log`.

Append a new dated entry. Do not replace prior entries.

Each entry should include:

- Date and operator.
- Commit or working-tree note.
- Exact command(s) run.
- Provider set.
- Dataset size and sampling rule.
- Key metrics.
- What changed your mind.
- Follow-up questions.
- Whether any project change is justified.

If the experiment failed, still append the result. Include the failure mode and the next useful attempt.
