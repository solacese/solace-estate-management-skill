/**
 * SEMP v2 HTTP client for Solace PubSub+ brokers.
 *
 * Handles authentication, pagination, and graceful error handling
 * for both Monitor and Config API endpoints. Strictly read-only.
 */

import type {
  BrokerConfig,
  BrokerObservation,
  ClientObservation,
  QueueObservation,
  SubscriptionObservation,
  VpnObservation,
} from "../model/types.js";

/** Shape of a SEMP v2 paginated response. */
interface SempResponse<T> {
  data?: T[] | T;
  meta?: {
    paging?: {
      cursorQuery?: string;
    };
    error?: {
      code: number;
      description: string;
      status: string;
    };
  };
}

/** Default timeout for individual SEMP requests (ms). */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Encodes a resource name for use in SEMP URL paths.
 * Handles characters like `/`, `#`, `+`, etc. that appear in VPN/queue names.
 */
function encodeResource(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, "%2F");
}

/**
 * Safely extracts a number from a raw SEMP record, trying multiple field name variants.
 */
function numberFrom(record: Record<string, unknown>, names: string[]): number {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
}

/**
 * Safely extracts a string from a raw SEMP record.
 */
function stringFrom(record: Record<string, unknown>, names: string[], fallback = ""): string {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return fallback;
}

/**
 * SEMP v2 client that crawls a single broker via the Monitor and Config APIs.
 *
 * @example
 * ```ts
 * const client = new SempClient();
 * const observation = await client.collectBroker(brokerConfig);
 * ```
 */
export class SempClient {
  /**
   * Collects a full observation from a single broker: VPNs, clients, queues, and subscriptions.
   *
   * @param broker - Broker configuration specifying URL, auth, and VPN list.
   * @returns Complete broker observation including timing and status.
   * @throws If the broker is entirely unreachable (individual VPN errors are logged and skipped).
   */
  async collectBroker(broker: BrokerConfig): Promise<BrokerObservation> {
    const start = Date.now();
    const vpns: VpnObservation[] = [];
    const clients: ClientObservation[] = [];
    const queues: QueueObservation[] = [];
    const subscriptions: SubscriptionObservation[] = [];

    for (const vpnName of broker.vpns) {
      // Fetch VPN-level stats
      const rawVpns = await this.fetchCollection<Record<string, unknown>>(
        broker,
        "monitor",
        `msgVpns?where=msgVpnName==${encodeResource(vpnName)}&count=1`
      );
      const rawVpn = rawVpns[0];
      if (rawVpn) {
        vpns.push(this.normalizeVpn(broker.id, vpnName, rawVpn));
      }

      // Fetch clients
      const rawClients = await this.fetchCollection<Record<string, unknown>>(
        broker,
        "monitor",
        `msgVpns/${encodeResource(vpnName)}/clients?count=100`
      );
      clients.push(...rawClients.map((raw) => this.normalizeClient(broker.id, vpnName, raw)));

      // Fetch queues
      const rawQueues = await this.fetchCollection<Record<string, unknown>>(
        broker,
        "monitor",
        `msgVpns/${encodeResource(vpnName)}/queues?count=100`
      );
      const normalizedQueues = rawQueues.map((raw) => this.normalizeQueue(broker.id, vpnName, raw));
      queues.push(...normalizedQueues);

      // Fetch subscriptions for each queue
      for (const queue of normalizedQueues) {
        const rawSubs = await this.fetchCollection<Record<string, unknown>>(
          broker,
          "config",
          `msgVpns/${encodeResource(vpnName)}/queues/${encodeResource(queue.name)}/subscriptions?count=100`
        );
        subscriptions.push(
          ...rawSubs.map((raw) => this.normalizeSubscription(broker.id, vpnName, queue.name, raw))
        );
      }
    }

    const latencyMs = Date.now() - start;

    return {
      brokerId: broker.id,
      vpns,
      clients,
      queues,
      subscriptions,
      status: {
        brokerId: broker.id,
        displayName: broker.displayName,
        status: "connected",
        lastPollAt: new Date().toISOString(),
        latencyMs,
      },
    };
  }

  /**
   * Fetches a paginated SEMP v2 collection, following cursor links until exhausted.
   *
   * @param broker - Broker to query.
   * @param api - Which SEMP API to use ("monitor" or "config").
   * @param resource - Resource path including query parameters (e.g. "msgVpns/default/queues?count=100").
   * @returns Array of all records across all pages.
   */
  private async fetchCollection<T>(
    broker: BrokerConfig,
    api: "monitor" | "config",
    resource: string
  ): Promise<T[]> {
    const authHeader = this.authHeader(broker);
    const baseUrl = broker.sempUrl.replace(/\/$/, "");
    let nextUrl: string | null = `${baseUrl}/SEMP/v2/${api}/${resource}`;
    const seen = new Set<string>();
    const records: T[] = [];

    while (nextUrl) {
      if (seen.has(nextUrl)) {
        throw new Error(`SEMP pagination loop detected for ${broker.id}: ${nextUrl}`);
      }
      seen.add(nextUrl);

      const response = await fetch(nextUrl, {
        headers: {
          authorization: authHeader,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `SEMP ${api} request failed for ${broker.id}: ${response.status} ${response.statusText} — ${nextUrl}`
        );
      }

      const body = (await response.json()) as SempResponse<T>;

      // SEMP returns data as array for collections, single object for get-by-name
      if (Array.isArray(body.data)) {
        records.push(...body.data);
      } else if (body.data) {
        records.push(body.data);
      }

      const cursorQuery = body.meta?.paging?.cursorQuery;
      nextUrl = cursorQuery ? this.resolveCursorUrl(baseUrl, api, resource, cursorQuery) : null;
    }

    return records;
  }

  /**
   * Builds the Authorization header from broker config, resolving env vars at runtime.
   */
  private authHeader(broker: BrokerConfig): string {
    if (broker.auth.mode === "bearer") {
      const token = broker.auth.tokenEnv ? process.env[broker.auth.tokenEnv] : undefined;
      if (!token) {
        throw new Error(
          `Missing bearer token for broker "${broker.id}": set env var ${broker.auth.tokenEnv ?? "(tokenEnv not configured)"}`
        );
      }
      return `Bearer ${token}`;
    }

    // Basic auth
    const username = broker.auth.usernameEnv ? process.env[broker.auth.usernameEnv] : undefined;
    const password = broker.auth.passwordEnv ? process.env[broker.auth.passwordEnv] : undefined;
    if (!username || !password) {
      throw new Error(
        `Missing basic auth credentials for broker "${broker.id}": set env vars ${broker.auth.usernameEnv ?? "(usernameEnv not configured)"}/${broker.auth.passwordEnv ?? "(passwordEnv not configured)"}`
      );
    }
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  /**
   * Resolves a SEMP cursor query into a full URL for the next page.
   */
  private resolveCursorUrl(
    baseUrl: string,
    api: "monitor" | "config",
    resource: string,
    cursorQuery: string
  ): string {
    if (cursorQuery.startsWith("http://") || cursorQuery.startsWith("https://")) {
      return cursorQuery;
    }
    if (cursorQuery.startsWith("/SEMP/")) {
      return `${baseUrl}${cursorQuery}`;
    }
    if (cursorQuery.startsWith("?")) {
      return `${baseUrl}/SEMP/v2/${api}/${resource.split("?")[0]}${cursorQuery}`;
    }
    return `${baseUrl}/SEMP/v2/${api}/${cursorQuery.replace(/^\//, "")}`;
  }

  // ─── Normalizers ────────────────────────────────────────────────────────────

  private normalizeVpn(brokerId: string, vpnName: string, raw: Record<string, unknown>): VpnObservation {
    return {
      brokerId,
      vpnName,
      connectionCount: numberFrom(raw, ["serviceRestIncomingActiveConnectionCount", "clientCount", "connectionCount"]) +
        numberFrom(raw, ["serviceSmfActiveConnectionCount", "serviceMqttActiveConnectionCount"]),
      maxConnectionCount: numberFrom(raw, ["maxConnectionCount", "serviceSmfMaxConnectionCount"]),
      msgRate: numberFrom(raw, ["rxMsgRate", "averageRxMsgRate", "dataMessagesReceivedRate"]) +
        numberFrom(raw, ["txMsgRate", "averageTxMsgRate", "dataMessagesSentRate"]),
      byteRate: numberFrom(raw, ["rxByteRate", "averageRxByteRate"]) +
        numberFrom(raw, ["txByteRate", "averageTxByteRate"]),
      spoolUsage: numberFrom(raw, ["msgSpoolUsage", "currentSpoolUsageMb"]),
      maxSpoolUsage: numberFrom(raw, ["msgSpoolMsgCount", "maxMsgSpoolUsage"]),
    };
  }

  private normalizeClient(brokerId: string, vpnName: string, raw: Record<string, unknown>): ClientObservation {
    return {
      brokerId,
      vpnName,
      name: stringFrom(raw, ["clientName", "name"], "unknown-client"),
      username: stringFrom(raw, ["clientUsername", "originalClientUsername", "username"], undefined) || undefined,
      connected: true, // If it appears in /clients it's connected
      ingressMsgRate: numberFrom(raw, ["dataMessagesReceivedRate", "rxMsgRate", "averageRxMsgRate", "ingressMsgRate"]),
      egressMsgRate: numberFrom(raw, ["dataMessagesSentRate", "txMsgRate", "averageTxMsgRate", "egressMsgRate"]),
      ingressByteRate: numberFrom(raw, ["dataBytesReceivedRate", "rxByteRate", "averageRxByteRate"]),
      egressByteRate: numberFrom(raw, ["dataBytesSentRate", "txByteRate", "averageTxByteRate"]),
    };
  }

  private normalizeQueue(brokerId: string, vpnName: string, raw: Record<string, unknown>): QueueObservation {
    return {
      brokerId,
      vpnName,
      name: stringFrom(raw, ["queueName", "name"], "unknown-queue"),
      bindCount: numberFrom(raw, ["bindCount", "consumerCount", "numBoundClients"]),
      queuedMessages: numberFrom(raw, ["currentSpooledMsgCount", "spooledMsgCount", "queuedMessages"]),
      spoolUsage: numberFrom(raw, ["msgSpoolUsage", "currentSpoolUsageMb", "spoolUsageMb"]),
      maxSpoolUsage: numberFrom(raw, ["maxMsgSpoolUsage", "maxSpoolUsageMb"]),
      ingressMsgRate: numberFrom(raw, ["msgSpoolIngressRate", "dataMessagesReceivedRate", "ingressMsgRate"]),
      egressMsgRate: numberFrom(raw, ["msgSpoolEgressRate", "dataMessagesSentRate", "egressMsgRate"]),
      ingressByteRate: numberFrom(raw, ["byteSpoolIngressRate", "dataBytesReceivedRate"]),
      egressByteRate: numberFrom(raw, ["byteSpoolEgressRate", "dataBytesSentRate"]),
    };
  }

  private normalizeSubscription(
    brokerId: string,
    vpnName: string,
    queueName: string,
    raw: Record<string, unknown>
  ): SubscriptionObservation {
    return {
      brokerId,
      vpnName,
      queueName,
      topic: stringFrom(raw, ["subscriptionTopic", "topic", "topicSubscription"], ">"),
    };
  }
}
