# Useful Source Rubric

Use this rubric when an experiment asks whether a source is useful.

## Labels

| Label | Name | Useful | Meaning |
| --- | --- | --- | --- |
| A | Official or primary | yes | Official resolution source, government page, exchange page, league page, company filing, court record, protocol docs, direct dataset. |
| B | Strong evidence | yes | Reputable reporting or analysis that directly answers the query and cites primary facts. |
| C | Context | yes, when relevant | Background that helps understand the topic but does not settle the question. |
| D | Weak duplicate | no | Duplicate summary, thin rewrite, generic SEO page, or source that adds no new evidence. |
| F | Wrong or unusable | no | Off-topic page, search page, aggregator, login wall, spam, irrelevant social post, broken page. |

Use `useful: true` for A and B. Use C only when the experiment asks for context, not official resolution evidence.

## Polymarket Rules

For Polymarket experiments:

- Count an exact `resolutionSource` URL as A.
- Count the same canonical host as A when the page plausibly contains the resolving data.
- Count official data pages as A even when they are not the exact stored `resolutionSource`.
- Count reputable reporting as B if it directly bears on the market question.
- Count the Polymarket event page as D unless the case asks for the market page itself.
- Count comments, prediction-market discussion, and social chatter as C or F, depending on relevance.

## Domain Rules

For official-domain experiments:

- A source on an expected domain is not automatically useful. It must address the query.
- An off-domain source can be B if it quotes or links the primary record, but it fails domain-compliance metrics.
- A provider result page, search page, or tag page is D unless it points directly to the target source and no better result exists.

## Freshness Rules

For freshness experiments:

- A fresh irrelevant source is F.
- A stale official source can be A for stable resolution criteria.
- A stale news article is D or F for time-sensitive currentness.
- An undated source needs manual judgment. Mark it useful only if content proves relevance.

## Full-Content Rules

For content experiments:

- Useful content contains answer-bearing body text, not only title and snippet.
- Boilerplate-heavy content can still be useful if expected terms and surrounding context appear.
- Truncated content is D when it omits the answer-bearing section.

## Manual Label Shape

Write manual labels as JSONL:

```json
{"sourceId":"abc123","url":"https://example.com/source","label":"A","useful":true,"reason":"official_source","notes":"Exact resolution source host"}
```

Recommended `reason` values:

- `official_source`
- `expected_domain`
- `primary_data`
- `reputable_reporting`
- `context`
- `duplicate`
- `thin_summary`
- `aggregator`
- `polymarket_page`
- `off_topic`
- `stale`
- `broken`

## Audit Rule

Audit enough rows to catch obvious rubric drift:

- Pilot: audit all rows.
- Full run: audit 20 rows or 10 percent of accepted useful sources, whichever is smaller.
- Include at least one row per provider when possible.

If labels feel ambiguous, record the ambiguity. Do not silently change the rubric during a run.
