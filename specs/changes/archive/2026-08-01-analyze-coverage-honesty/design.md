# Design — analyze-coverage-honesty (F70)

## Classification (per digest entry)

| Condition | Bucket |
|-----------|--------|
| `entry.metrics?.available === true` | measured |
| `entry.metrics?.available === false` | collectionFailed |
| no `metrics` object (or metrics not an object) | predatesTelemetry |

Live `metrics.json` is not required for the bucket — digests already carry
`{available:false}` after a failed collect, and missing metrics means the
session predates the field.

## Shape

```js
coverage: {
  sessionsTotal,
  measured,
  predatesTelemetry,
  collectionFailed,
  sessionsWithMetrics, // === measured (compat)
  ratio,               // measured / sessionsTotal
}
```

## Render

```
Coverage: 8 measured, 3 predates telemetry, 1 collection failed (of 12; measured 66.7%)
```

## Tests

RED then GREEN in `analyze.test.mjs`; e2e status line asserting the three buckets.
