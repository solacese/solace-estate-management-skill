# Security Posture Checks — Solace PubSub+ (Read-Only SEMP)

All checks are **read-only** and production-safe. They use SEMP v2 Monitor or Config (read) endpoints.

## Severity Scale

| Severity | Meaning |
|----------|---------|
| Critical | Immediate exploit risk, unauthenticated access possible |
| High | Overly permissive defaults allowing lateral movement |
| Medium | Missing encryption or defense-in-depth layers |
| Low | Missing limits that could enable resource exhaustion |

---

## Checks

### 1. Authentication Enabled

| | |
|---|---|
| **Severity** | Critical |
| **What** | VPN must require authentication |
| **Endpoint** | `GET /SEMP/v2/monitor/msgVpns/{vpn}` |
| **Field** | `authenticationBasicType` |
| **Safe value** | `"internal"` or `"ldap"` or `"radius"` |
| **Fail** | `"none"` |
| **Risk** | Any client can connect without credentials — full pub/sub access |
| **Remediation** | Set `authenticationBasicType` to `internal` (minimum) and configure client usernames |

---

### 2. ACL Default Deny

| | |
|---|---|
| **Severity** | High |
| **What** | ACL profiles should deny by default, then allow explicitly |
| **Endpoint** | `GET /SEMP/v2/config/msgVpns/{vpn}/aclProfiles/{profile}` |
| **Fields** | `publishTopicDefaultAction`, `subscribeTopicDefaultAction` |
| **Safe value** | Both = `"disallow"` |
| **Fail** | Either = `"allow"` |
| **Risk** | Clients can publish/subscribe to any topic — no namespace isolation |
| **Remediation** | Set both defaults to `disallow`, add explicit allow exceptions per topic namespace |

---

### 3. Connection Limits Set

| | |
|---|---|
| **Severity** | Low |
| **What** | VPN should cap total connections |
| **Endpoint** | `GET /SEMP/v2/monitor/msgVpns/{vpn}` |
| **Field** | `maxConnectionCount` |
| **Safe value** | Set to a value appropriate for the workload (typically < 1000 for non-shared VPNs) |
| **Fail** | Default maximum (e.g., 100000) with no intentional sizing |
| **Risk** | Runaway clients or connection storms exhaust broker resources |
| **Remediation** | Set `maxConnectionCount` based on expected peak + headroom |

---

### 4. TLS Configured

| | |
|---|---|
| **Severity** | Medium |
| **What** | VPN should have TLS listener ports active |
| **Endpoint** | `GET /SEMP/v2/monitor/msgVpns/{vpn}` |
| **Fields** | `serviceSmfTlsListenPort`, `serviceMqttTlsListenPort`, `serviceAmqpTlsListenPort`, `serviceRestIncomingTlsListenPort` |
| **Safe value** | At least one TLS port > 0 (configured) |
| **Fail** | All TLS ports = 0 (disabled) |
| **Risk** | Credentials and message payloads transmitted in plaintext |
| **Remediation** | Configure server certificate and enable TLS listen ports; disable plain-text ports if possible |

---

### 5. Bridge Connections Restricted

| | |
|---|---|
| **Severity** | High |
| **What** | Default client profile should not allow bridge connections |
| **Endpoint** | `GET /SEMP/v2/config/msgVpns/{vpn}/clientProfiles/{profile}` |
| **Field** | `allowBridgeConnectionsEnabled` |
| **Safe value** | `false` (on `default` profile) |
| **Fail** | `true` on default profile |
| **Risk** | Any client using the default profile can establish bridge connections, enabling unauthorized cross-VPN or cross-broker message flow |
| **Remediation** | Disable on default profile; create a dedicated bridge profile with bridge access for authorized bridge clients only |

---

### 6. Endpoint Creation Restricted

| | |
|---|---|
| **Severity** | High |
| **What** | Default profile should not allow clients to create durable endpoints |
| **Endpoint** | `GET /SEMP/v2/config/msgVpns/{vpn}/clientProfiles/{profile}` |
| **Field** | `allowGuaranteedEndpointCreateEnabled` |
| **Safe value** | `false` (on `default` profile) |
| **Fail** | `true` on default profile |
| **Risk** | Clients can create arbitrary queues/topic-endpoints, consuming spool and potentially shadowing messages |
| **Remediation** | Disable on default profile; grant endpoint creation only to provisioning service accounts |

---

### 7. Management Session Timeout

| | |
|---|---|
| **Severity** | Low |
| **What** | Web management / CLI sessions should have bounded idle timeout |
| **Endpoint** | `GET /SEMP/v2/monitor` (broker-level) |
| **Field** | Check SEMP session and CLI session configuration |
| **Safe value** | Idle timeout ≤ 30 minutes |
| **Fail** | No timeout or timeout > 60 minutes |
| **Risk** | Abandoned admin sessions remain active, susceptible to session hijacking |
| **Remediation** | Configure management session inactivity timeout via broker CLI or SEMP config |

---

### 8. Queue Spool Limits

| | |
|---|---|
| **Severity** | Low |
| **What** | Queues should have explicit `maxMsgSpoolUsage` set |
| **Endpoint** | `GET /SEMP/v2/monitor/msgVpns/{vpn}/queues` |
| **Field** | `maxMsgSpoolUsage` |
| **Safe value** | Set to a finite value appropriate for the queue (e.g., 1500 MB or less) |
| **Fail** | Set to 0 (unlimited) or VPN max without per-queue cap |
| **Risk** | Single queue can consume all VPN spool, starving other queues |
| **Remediation** | Set per-queue `maxMsgSpoolUsage` based on expected retention × throughput |

---

### 9. Per-Client Connection Limits

| | |
|---|---|
| **Severity** | Low |
| **What** | Client profiles should limit connections per username |
| **Endpoint** | `GET /SEMP/v2/monitor/msgVpns/{vpn}/clientProfiles/{profile}` |
| **Field** | `maxConnectionCountPerClientUsername` |
| **Safe value** | Set to a reasonable bound (e.g., 10–100 depending on app) |
| **Fail** | Default max (e.g., 100000) with no intentional sizing |
| **Risk** | Compromised or buggy client opens thousands of connections, exhausting session resources |
| **Remediation** | Set `maxConnectionCountPerClientUsername` per profile based on expected client count per username |

---

## Quick Scan Approach

1. **Fetch VPN config**: `GET /SEMP/v2/monitor/msgVpns/{vpn}` — checks 1, 3, 4
2. **Fetch ACL profiles**: `GET /SEMP/v2/config/msgVpns/{vpn}/aclProfiles` — check 2
3. **Fetch client profiles**: `GET /SEMP/v2/config/msgVpns/{vpn}/clientProfiles` — checks 5, 6, 9
4. **Fetch queues**: `GET /SEMP/v2/monitor/msgVpns/{vpn}/queues?select=queueName,maxMsgSpoolUsage` — check 8
5. **Fetch broker status**: `GET /SEMP/v2/monitor` — check 7

Total: 5 API calls for a complete VPN security posture snapshot.
