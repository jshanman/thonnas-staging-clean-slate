# Metrics-OTEL-Signoz: Requirements Review Checklist

Review the feature.md for observability and metrics considerations.

## Metrics Design (CRITICAL)

- [ ] Key metrics identified (counters, gauges, histograms)
- [ ] Metric naming conventions followed
- [ ] Metric dimensions/labels specified
- [ ] Cardinality considerations addressed

**Flag as CRITICAL if:**
- Features lack metrics specification
- High cardinality labels proposed

## Tracing Requirements (CRITICAL)

- [ ] Trace span requirements documented
- [ ] Span naming conventions followed
- [ ] Parent-child span relationships defined
- [ ] Trace context propagation needs

**Flag as CRITICAL if:**
- Distributed features lack tracing
- No span hierarchy defined

## Dashboard Requirements (IMPORTANT)

- [ ] Dashboard panels identified
- [ ] Visualization types specified
- [ ] Time range requirements documented
- [ ] Alert thresholds defined

**Flag as IMPORTANT if:**
- Monitoring features lack dashboard spec
- No alert thresholds for critical metrics

## Logging Integration (IMPORTANT)

- [ ] Log correlation requirements documented
- [ ] Structured logging fields specified
- [ ] Log level requirements defined
- [ ] Log sampling strategy (if high volume)

**Flag as IMPORTANT if:**
- Features lack log correlation
- No structured logging plan

## Alerting (IMPORTANT)

- [ ] Alert conditions documented
- [ ] Alert severity levels specified
- [ ] Notification channels identified
- [ ] Alert escalation requirements

**Flag as IMPORTANT if:**
- Critical features lack alerting
- No escalation strategy

## Performance (NICE-TO-HAVE)

- [ ] Sampling strategy for high-volume traces
- [ ] Retention requirements documented
- [ ] Query performance considerations

**Flag as NICE-TO-HAVE if:**
- High-volume features could optimize sampling

