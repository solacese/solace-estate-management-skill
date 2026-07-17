# Consumption Attribution & Chargeback Model

## Philosophy

- Keep it simple. Customers don't trust complex formulas.
- Single primary dimension: **volume** (messages or bytes).
- Transparent: any team can reproduce their own number from the API.
- Auditable: raw data retained for the rollup period.

## Primary Dimension

**Message or byte volume** over a chosen period (daily or weekly).

Choose one unit and stick with it:
- **Messages** — easier to reason about, better for event-driven workloads
- **Bytes** — fairer when message sizes vary widely (e.g., bulk file transfer vs. small events)

## Attribution Method

| Role | Metric | SEMP Source |
|------|--------|-------------|
| Publisher (ingress) | `dataMessagesReceivedRate` or `dataBytesReceivedRate` | `GET .../clients?select=clientUsername,dataMessagesReceivedRate,dataBytesReceivedRate` |
| Subscriber (egress) | `dataMessagesSentRate` or `dataBytesSentRate` | `GET .../clients?select=clientUsername,dataMessagesSentRate,dataBytesSentRate` |

- Sum **ingress** rates × sample interval for publisher attribution.
- Sum **egress** rates × sample interval for subscriber attribution.
- If billing only one side, prefer **ingress** (producer pays).

## Grouping

Attribute cost to the entity that owns the traffic. Group by tag:

- `owner` — team or individual
- `business_unit` — department
- `cost_center` — finance code
- `application` — service name

Tags come from a mapping table (clientUsername → tag). Maintain this mapping outside the broker.

## Period

- **Daily rollup**: good for visibility, more data points.
- **Weekly rollup**: less noise, easier to report.

Sample rates at regular intervals (e.g., every 60s), sum over the period.

## Tier 1 vs Tier 2

| Tier | Granularity | Source | Complexity |
|------|-------------|--------|------------|
| Tier 1 | Per-client or per-queue | SEMP Monitor rates | Low — API polling only |
| Tier 2 | Per-topic | OpenTelemetry / distributed tracing | High — requires OTel collector + topic-level instrumentation |

Start with Tier 1. Only move to Tier 2 if the customer needs per-topic cost breakdown.

## Report Template

```
Chargeback Report — Week of 2025-01-06
Broker: prod-solace-01
VPN: trading

| Business Unit | App             | Direction | Messages   | Bytes (GB) | Share % |
|---------------|-----------------|-----------|------------|------------|---------|
| Markets       | order-gateway   | Ingress   | 12,450,000 | 4.2        | 38%     |
| Markets       | risk-engine     | Egress    | 9,800,000  | 3.1        | 30%     |
| Settlements   | confirm-service | Ingress   | 5,200,000  | 1.8        | 17%     |
| Settlements   | ledger-sync     | Egress    | 4,900,000  | 1.6        | 15%     |
|               |                 | **Total** | 32,350,000 | 10.7       | 100%    |
```

## Optional Weighted Add-Ons

Only include if the customer explicitly requests:

| Add-On | Weight | Rationale |
|--------|--------|-----------|
| Persistent connections | 5% of total cost pool | Long-lived connections consume TCP/session resources |
| Spool footprint | 10% of total cost pool | Retained messages consume disk/memory |

Formula when add-ons enabled:
```
cost_share = (volume_share × 0.85) + (connection_share × 0.05) + (spool_share × 0.10)
```

Default (no add-ons): `cost_share = volume_share`.
