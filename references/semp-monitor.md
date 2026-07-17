# SEMP v2 Monitor API Reference

## Base URL

```
{management_url}/SEMP/v2/monitor/msgVpns/{vpn}/...
```

The management URL is typically `https://{host}:943` (appliance) or `https://{host}:1943` (software broker).

## Authentication

- **Basic Auth**: `Authorization: Basic base64(username:password)`
- **Bearer Token**: `Authorization: Bearer {token}`

Admin-level credentials required for full monitor access. Read-only users see only permitted VPNs.

## Pagination

Responses include `meta.paging.cursorQuery` when more pages exist.

```
GET .../queues?count=100
→ response.meta.paging.cursorQuery = "cursor=..."
GET .../queues?count=100&cursor=...
```

**Always follow pagination until `meta.paging` is absent or `cursorQuery` is empty.** Default page size is 25; use `count=100` for fewer round trips.

## Field Selection

Reduce payload with `select`:

```
GET .../clients?select=clientName,dataMessagesReceivedRate,dataMessagesSentRate
```

Comma-separated field names. Nested objects not selectable individually.

## Key Endpoints

### Broker-Level Status

```
GET /SEMP/v2/monitor
```

Returns broker uptime, guaranteed messaging status, redundancy state.

### Message VPN List

```
GET /SEMP/v2/monitor/msgVpns
GET /SEMP/v2/monitor/msgVpns/{vpn}
```

Fields: `msgVpnName`, `state`, `serviceAmqpPlainTextListenPort`, `serviceMqttPlainTextListenPort`, `maxConnectionCount`, `connectionCount`, `msgSpoolUsage`, `authenticationBasicType`.

### Connected Clients

```
GET /SEMP/v2/monitor/msgVpns/{vpn}/clients
GET /SEMP/v2/monitor/msgVpns/{vpn}/clients/{clientName}
```

Key rate fields (read directly, never diff counters):
- `dataMessagesReceivedRate` — msgs/sec into broker from this client
- `dataMessagesSentRate` — msgs/sec from broker to this client
- `dataBytesReceivedRate` — bytes/sec into broker
- `dataBytesSentRate` — bytes/sec from broker

Other useful: `clientName`, `clientUsername`, `msgVpnName`, `uptime`, `webTransportUrl`.

### Queues

```
GET /SEMP/v2/monitor/msgVpns/{vpn}/queues
GET /SEMP/v2/monitor/msgVpns/{vpn}/queues/{queue}
```

Key fields: `queueName`, `bindCount`, `msgSpoolUsage`, `msgCount`, `maxMsgSpoolUsage`, `accessType`, `owner`.

Key rate fields:
- `msgSpoolUsageIngressRate` — bytes/sec entering queue spool
- `msgSpoolUsageEgressRate` — bytes/sec leaving queue spool

### Queue Subscriptions

```
GET /SEMP/v2/monitor/msgVpns/{vpn}/queues/{queue}/subscriptions
```

Returns topic subscriptions attracting messages to this queue.

### Bridges (Mesh/DMR Links)

```
GET /SEMP/v2/monitor/msgVpns/{vpn}/bridges
```

Fields: `bridgeName`, `enabled`, `inboundState`, `outboundState`, `remoteAddress`.

### Client Profiles

```
GET /SEMP/v2/monitor/msgVpns/{vpn}/clientProfiles
GET /SEMP/v2/monitor/msgVpns/{vpn}/clientProfiles/{profile}
```

Fields: `clientProfileName`, `maxConnectionCountPerClientUsername`, `allowBridgeConnectionsEnabled`, `allowGuaranteedEndpointCreateEnabled`.

### ACL Profiles

```
GET /SEMP/v2/monitor/msgVpns/{vpn}/aclProfiles
GET /SEMP/v2/monitor/msgVpns/{vpn}/aclProfiles/{profile}
```

Fields: `aclProfileName`, `publishTopicDefaultAction`, `subscribeTopicDefaultAction`, `clientConnectDefaultAction`.

## Filtering & Sorting

```
# Filter: where clause
GET .../queues?where=bindCount>0

# Sort: ascending/descending
GET .../queues?sort=msgSpoolUsage,desc
```

## Important Rate Fields (Never Diff Counters)

The Monitor API exposes pre-computed rate fields. **Always read these directly** instead of sampling counters and computing deltas yourself:

| Object | Rate Fields |
|--------|-------------|
| Client | `dataMessagesReceivedRate`, `dataMessagesSentRate`, `dataBytesReceivedRate`, `dataBytesSentRate` |
| Queue  | `msgSpoolUsageIngressRate`, `msgSpoolUsageEgressRate` |

## Error Handling

| Status | Meaning | Action |
|--------|---------|--------|
| 401 | Bad credentials | Check username/password or token |
| 403 | Insufficient privileges | User lacks monitor access to this VPN |
| 404 | Resource not found | VPN, queue, or client doesn't exist |
| 400 | Bad request | Invalid filter/select syntax |
