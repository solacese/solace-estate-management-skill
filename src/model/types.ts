/**
 * Core data model types for Solace Estate Management.
 *
 * These types represent the normalized view of a multi-broker Solace estate,
 * derived from SEMP v2 Monitor and Config API responses.
 */

// ─── Configuration ──────────────────────────────────────────────────────────

/** Authentication configuration for a broker's SEMP API. */
export interface BrokerAuth {
  /** Authentication mode: basic (username/password) or bearer (API token). */
  mode: "basic" | "bearer";
  /** Environment variable name holding the username (basic auth). */
  usernameEnv?: string;
  /** Environment variable name holding the password (basic auth). */
  passwordEnv?: string;
  /** Environment variable name holding the bearer token. */
  tokenEnv?: string;
}

/** Configuration for a single Solace PubSub+ broker. */
export interface BrokerConfig {
  /** Unique identifier for this broker within the estate. */
  id: string;
  /** Human-friendly display name. */
  displayName: string;
  /** Base SEMP URL (e.g. "https://broker.example.com:943"). */
  sempUrl: string;
  /** List of Message VPN names to crawl on this broker. */
  vpns: string[];
  /** Authentication configuration. */
  auth: BrokerAuth;
  /** Arbitrary key-value tags for grouping (site, region, environment, etc.). */
  tags: Record<string, string>;
  /** Whether to reject untrusted TLS certificates (default: true). */
  tlsRejectUnauthorized: boolean;
}

/** Top-level estate configuration, typically loaded from estate.yaml. */
export interface EstateConfig {
  /** Display name for this estate (e.g. "Acme Manufacturing"). */
  name: string;
  /** How often to poll brokers, in seconds. */
  pollIntervalSeconds: number;
  /** All brokers in this estate. */
  brokers: BrokerConfig[];
}

// ─── Estate Graph Model ─────────────────────────────────────────────────────

/** The type of a node in the estate topology graph. */
export type EstateNodeType = "broker" | "vpn" | "client" | "queue";

/** A node in the estate topology graph. */
export interface EstateNode {
  /** Globally unique node identifier (e.g. "broker:cloud-core" or "queue:cloud-core/prod/orders.q"). */
  id: string;
  /** Node category. */
  type: EstateNodeType;
  /** Human-readable label. */
  label: string;
  /** Broker this node belongs to. */
  brokerId: string;
  /** VPN name (for vpn/client/queue nodes). */
  vpnName?: string;
  /** Observed metrics for this node. */
  metrics?: MetricBag;
  /** Arbitrary key-value tags inherited or computed. */
  tags: Record<string, string>;
}

/** The type of an edge in the estate topology graph. */
export type EstateEdgeType =
  | "publishes_to"
  | "subscribes_to"
  | "consumes_from"
  | "connected_to"
  | "linked_to";

/** A directed edge in the estate topology graph. */
export interface EstateEdge {
  /** Globally unique edge identifier. */
  id: string;
  /** Edge category describing the relationship. */
  type: EstateEdgeType;
  /** Source node ID. */
  source: string;
  /** Target node ID. */
  target: string;
  /** Observed metrics for this relationship. */
  metrics?: MetricBag;
}

/** Bag of numeric metrics observed from SEMP Monitor API. All fields optional. */
export interface MetricBag {
  /** Aggregate message rate (msg/s). */
  msgRate?: number;
  /** Aggregate byte rate (B/s). */
  byteRate?: number;
  /** Ingress (received) message rate (msg/s). */
  ingressMsgRate?: number;
  /** Egress (sent) message rate (msg/s). */
  egressMsgRate?: number;
  /** Number of currently connected clients. */
  connectedClients?: number;
  /** Number of messages currently spooled. */
  queuedMessages?: number;
  /** Number of consumers bound to a queue. */
  bindCount?: number;
  /** Current spool usage in MB. */
  spoolUsage?: number;
  /** Maximum allowed spool usage in MB. */
  maxSpoolUsage?: number;
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

/** A point-in-time snapshot of the entire estate. */
export interface EstateSnapshot {
  /** ISO 8601 timestamp when this snapshot was generated. */
  generatedAt: string;
  /** Name of the estate (from config). */
  estateName: string;
  /** All nodes in the estate graph. */
  nodes: EstateNode[];
  /** All edges in the estate graph. */
  edges: EstateEdge[];
  /** Per-broker connectivity and health status. */
  brokerStatuses: BrokerStatus[];
}

/** Connectivity and health status of a single broker. */
export interface BrokerStatus {
  /** Broker identifier. */
  brokerId: string;
  /** Human-friendly display name. */
  displayName: string;
  /** Current connectivity status. */
  status: "connected" | "unreachable" | "degraded";
  /** When the broker was last successfully polled (ISO 8601). */
  lastPollAt?: string;
  /** Round-trip latency of the last SEMP request in milliseconds. */
  latencyMs?: number;
  /** Error message if status is not "connected". */
  error?: string;
}

// ─── Analysis Findings ──────────────────────────────────────────────────────

/** Severity level for findings. */
export type Severity = "critical" | "high" | "medium" | "low";

/** A security posture finding from the estate audit. */
export interface SecurityFinding {
  /** Broker where the finding was detected. */
  brokerId: string;
  /** VPN scope (if applicable). */
  vpnName?: string;
  /** Severity of the finding. */
  severity: Severity;
  /** Name of the security check that produced this finding. */
  check: string;
  /** What the expected (secure) configuration should be. */
  expected: string;
  /** What was actually observed. */
  actual: string;
  /** Recommended remediation. */
  remediation: string;
}

/** Category of health finding. */
export type HealthCategory =
  | "hotspot"
  | "silent"
  | "spool_pressure"
  | "connection_limit"
  | "mesh_down"
  | "idle_queue";

/** A health or capacity finding from estate analysis. */
export interface HealthFinding {
  /** Broker where the finding was detected. */
  brokerId: string;
  /** VPN scope (if applicable). */
  vpnName?: string;
  /** Severity of the finding. */
  severity: Severity;
  /** Category of the health issue. */
  category: HealthCategory;
  /** Human-readable description of the finding. */
  message: string;
  /** Observed value (e.g. current spool usage). */
  value?: number;
  /** Configured limit (e.g. max spool). */
  limit?: number;
}

// ─── Raw Observation Types (from SEMP crawl) ────────────────────────────────

/** Raw observation data from a single VPN's clients. */
export interface ClientObservation {
  brokerId: string;
  vpnName: string;
  name: string;
  username?: string;
  connected: boolean;
  ingressMsgRate: number;
  egressMsgRate: number;
  ingressByteRate: number;
  egressByteRate: number;
}

/** Raw observation data from a single VPN's queues. */
export interface QueueObservation {
  brokerId: string;
  vpnName: string;
  name: string;
  bindCount: number;
  queuedMessages: number;
  spoolUsage: number;
  maxSpoolUsage: number;
  ingressMsgRate: number;
  egressMsgRate: number;
  ingressByteRate: number;
  egressByteRate: number;
}

/** Raw observation data for a queue subscription. */
export interface SubscriptionObservation {
  brokerId: string;
  vpnName: string;
  queueName: string;
  topic: string;
}

/** Raw observation of a VPN's aggregate stats. */
export interface VpnObservation {
  brokerId: string;
  vpnName: string;
  connectionCount: number;
  maxConnectionCount: number;
  msgRate: number;
  byteRate: number;
  spoolUsage: number;
  maxSpoolUsage: number;
}

/** Complete observation from crawling a single broker. */
export interface BrokerObservation {
  brokerId: string;
  vpns: VpnObservation[];
  clients: ClientObservation[];
  queues: QueueObservation[];
  subscriptions: SubscriptionObservation[];
  status: BrokerStatus;
}

/** Optional raw SEMP config API data for security analysis. */
export interface VpnConfigObservation {
  brokerId: string;
  vpnName: string;
  authenticationBasicType?: string;
  authorizationType?: string;
  maxConnectionCount?: number;
  maxMsgSpoolUsage?: number;
  tlsAllowDowngradeToPlainText?: boolean;
  aclProfiles?: AclProfileObservation[];
  clientProfiles?: ClientProfileObservation[];
}

/** ACL profile data from SEMP config API. */
export interface AclProfileObservation {
  name: string;
  publishTopicDefaultAction: string;
  subscribeTopicDefaultAction: string;
  clientConnectDefaultAction: string;
}

/** Client profile data from SEMP config API. */
export interface ClientProfileObservation {
  name: string;
  allowBridgeConnectionsEnabled: boolean;
  allowGuaranteedEndpointCreateEnabled: boolean;
  maxConnectionCountPerClientUsername?: number;
}
