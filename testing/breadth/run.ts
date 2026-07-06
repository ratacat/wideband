// Breadth test: one fan-out sweep per query; per-provider breadth derived from
// Source.provenance (provider p's result set = sources whose provenance includes p).
// Fair by construction: same query, same max, same moment for every provider.
import { wideband } from '../../src/index'

const QUERIES = [
  'bun sqlite WAL mode performance',
  'CRISPR base editing clinical trial results',
  'EU AI Act enforcement timeline for general purpose models',
  'reciprocal rank fusion information retrieval evaluation',
  'best mechanical keyboard switches 2026',
  'prediction market resolution source disputes',
  'TypeScript 6 breaking changes migration',
  'lithium iron phosphate battery degradation study',
  'James Webb telescope exoplanet atmosphere findings',
  'restaurant industry labor shortage statistics 2026',
]

const wb = wideband()
const out: unknown[] = []

for (const q of QUERIES) {
  const r = await wb.scan({ q, max: 10 }, { fresh: true, timeoutMs: 15_000 })
  const byProvider: Record<string, number> = {}
  for (const s of r.sources) for (const p of s.providers) byProvider[p] = (byProvider[p] ?? 0) + 1
  out.push({
    q,
    union: r.stats.uniqueSources,
    totalHits: r.stats.totalHits,
    overlapPct: r.stats.overlapPct,
    found: byProvider, // distinct sources each provider found
    providers: Object.fromEntries(
      Object.entries(r.stats.providers).map(([p, st]) => [
        p,
        { status: st.status, hits: st.hits, uniqueContributed: st.uniqueContributed, latencyMs: st.latencyMs },
      ]),
    ),
    costUSD: r.cost.totalUSD,
    ms: r.timing.totalMs,
  })
  console.error(`done: ${q} (union ${r.stats.uniqueSources}, $${r.cost.totalUSD.toFixed(4)})`)
}

wb.close()
await Bun.write(new URL('results.json', import.meta.url).pathname, JSON.stringify(out, null, 1))
console.error('wrote results.json')
