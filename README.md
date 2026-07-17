# Solace Estate Management

> AI agent skill + dashboard toolkit for managing a fleet of Solace PubSub+ brokers via SEMP v2.

**Read-only. Safe for production. Works on any estate size.**

## What This Is

As a Solace deployment grows from a handful of brokers to dozens, teams lose track of what exists and where it lives. This project gives AI agents (and humans) the procedures and tooling to:

1. **Inventory** — enumerate every broker, VPN, client, and queue across the fleet
2. **Locate** — find any resource across all brokers ("where is queue X?")
3. **Topology** — map the mesh of brokers, applications, and data flows
4. **Health** — surface hotspots, silent brokers, spool pressure, and capacity limits
5. **Chargeback** — attribute consumption (msg/byte volume) by team, application, or cost center
6. **Security Posture** — audit auth config, ACL coverage, TLS state, and connection limits

Everything runs through the SEMP v2 Monitor API (read-only). No broker state is ever modified.

## Project Structure

```
solace-estate-management/
├── skill.yaml              # SAM agent skill definition
├── src/
│   ├── collector/          # SEMP v2 client + broker crawler
│   ├── model/              # Normalized estate data model
│   ├── analyzers/          # Health, capacity, security analyzers
│   ├── reporters/          # Output formatters (inventory, chargeback, health)
│   └── index.ts            # CLI entry point
├── references/
│   ├── semp-monitor.md     # SEMP v2 monitor endpoint reference
│   ├── chargeback.md       # Consumption attribution model
│   └── security-checks.md  # Security posture checks (from audit research)
├── config/
│   └── estate.example.yaml # Example multi-broker configuration
├── docker-compose.yml      # Local dev: multi-broker test estate
├── package.json
└── tsconfig.json
```

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure your estate (copy and edit)
cp config/estate.example.yaml config/estate.yaml

# 3. Run inventory
npx tsx src/index.ts inventory

# 4. Run health check
npx tsx src/index.ts health

# 5. Run security posture audit
npx tsx src/index.ts security
```

## Agent Skill Usage

This project is designed to be loaded as an AI agent skill. The agent receives:
- The estate management procedures (when to use SEMP monitor vs. tracing)
- Domain knowledge (Solace topology model, chargeback attribution)
- Reference docs (SEMP endpoints, rate fields, pagination patterns)

```yaml
# In your agent configuration
skills:
  - solace-estate-management
```

The agent can then answer questions like:
- "How many brokers do we have?"
- "Where does the Orders application connect?"
- "Which brokers are running hot?"
- "Show me consumption by business unit this week"
- "Are any brokers misconfigured for security?"

## Configuration

```yaml
# config/estate.yaml
estate:
  name: "Acme Manufacturing"
  poll_interval_seconds: 30

brokers:
  - id: cloud-core
    display_name: "Cloud Core Broker"
    semp_url: "https://cloud-core.messaging.solace.cloud:943"
    vpns: ["production"]
    auth:
      mode: bearer
      token_env: CLOUD_CORE_SEMP_TOKEN
    tags:
      site: paris
      region: EMEA
      environment: production
      role: core

  - id: plant-edge-01
    display_name: "Plant A Edge Broker"
    semp_url: "http://10.1.1.50:8080"
    vpns: ["default"]
    auth:
      mode: basic
      username_env: PLANT_A_USER
      password_env: PLANT_A_PASS
    tags:
      site: douai
      region: EMEA
      environment: production
      role: edge
      plant: "Plant A"
```

## Core Principle: Aggregate First

There are two levels of detail available:

| Tier | Source | Load | Answers |
|------|--------|------|---------|
| **Tier 1** (default) | SEMP v2 Monitor | Zero added broker load | Inventory, locate, topology, health, aggregate consumption |
| **Tier 2** (opt-in) | OpenTelemetry distributed tracing | ~2x message volume | Per-topic lineage, per-topic chargeback |

**Always start at Tier 1.** It answers 90% of estate questions with zero production impact.

Tier 2 requires the customer's explicit decision — it doubles broker message volume. Never enable it by default.

## Security Posture Checks

Derived from [security audit research](https://github.com/solacese/solace-security-audit), the security analyzer checks each broker for:

| Check | What It Verifies | SEMP Endpoint |
|-------|-----------------|---------------|
| Auth enabled | `authenticationBasicType != "none"` | `GET /monitor/msgVpns/{vpn}` |
| ACL default deny | publish/subscribe default = "disallow" | `GET /config/msgVpns/{vpn}/aclProfiles/*` |
| Connection limits | `maxConnectionCount` is set reasonably | `GET /monitor/msgVpns/{vpn}` |
| TLS configured | TLS listeners enabled on protocols | `GET /monitor/msgVpns/{vpn}` |
| Bridge restrictions | `allowBridgeConnectionsEnabled = false` | `GET /config/msgVpns/{vpn}/clientProfiles/*` |
| Spool limits | queues have `maxMsgSpoolUsage` set | `GET /monitor/msgVpns/{vpn}/queues` |
| Session timeout | management session lifetime is bounded | `GET /monitor` |

## Sunburst Integration

The estate model can feed the [Solace Sunburst Topic Explorer](https://explorer.solace.dev/) for per-broker topic visualization:

```bash
# Export topic tree for a specific broker
npx tsx src/index.ts sunburst --broker cloud-core

# Start API server with live sunburst endpoint
npx tsx src/index.ts serve
# Then point Explorer at: http://localhost:8080/api/sunburst/scan?broker=cloud-core
```

## Topology Visualization

Pairs with [solace-topology](https://github.com/solacese/solace-topology) for fleet-level visualization:

```bash
# Export estate as topology snapshot
npx tsx src/index.ts topology --format snapshot > topology.json

# Or serve live topology API
npx tsx src/index.ts serve
# Frontend connects to SSE stream at /api/live
```

## Related Projects

- [solace-topology](https://github.com/solacese/solace-topology) — Visual topology dashboard
- [Solace Sunburst Explorer](https://explorer.solace.dev/) — Per-broker topic visualization
- [solace-security-audit](https://github.com/solacese/solace-security-audit) — Security vulnerability research

## License

Apache-2.0
