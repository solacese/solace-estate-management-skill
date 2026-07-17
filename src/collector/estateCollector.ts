/**
 * Estate Collector — orchestrates crawling all brokers in the estate.
 *
 * Crawls brokers in parallel, normalizes observations into the estate graph model,
 * and handles individual broker failures gracefully (skip, log, continue).
 */

import type {
  BrokerConfig,
  BrokerObservation,
  BrokerStatus,
  EstateConfig,
  EstateEdge,
  EstateNode,
  EstateSnapshot,
} from "../model/types.js";
import { SempClient } from "./sempClient.js";

/**
 * Collects and normalizes observations from all brokers in an estate.
 *
 * @example
 * ```ts
 * const collector = new EstateCollector(config);
 * const snapshot = await collector.collect();
 * ```
 */
export class EstateCollector {
  private readonly config: EstateConfig;
  private readonly sempClient: SempClient;

  constructor(config: EstateConfig) {
    this.config = config;
    this.sempClient = new SempClient();
  }

  /**
   * Crawls all configured brokers in parallel and builds a unified estate snapshot.
   *
   * Individual broker failures are captured as `unreachable` statuses — the
   * collection continues for remaining brokers.
   */
  async collect(): Promise<EstateSnapshot> {
    const results = await Promise.allSettled(
      this.config.brokers.map((broker) => this.collectOne(broker))
    );

    const observations: BrokerObservation[] = [];
    const statuses: BrokerStatus[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const broker = this.config.brokers[i]!;

      if (result.status === "fulfilled") {
        observations.push(result.value);
        statuses.push(result.value.status);
      } else {
        const errorMessage = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        console.error(`[estate] Failed to collect broker "${broker.id}": ${errorMessage}`);
        statuses.push({
          brokerId: broker.id,
          displayName: broker.displayName,
          status: "unreachable",
          error: errorMessage,
        });
      }
    }

    const nodes = this.buildNodes(observations);
    const edges = this.buildEdges(observations);

    return {
      generatedAt: new Date().toISOString(),
      estateName: this.config.name,
      nodes,
      edges,
      brokerStatuses: statuses,
    };
  }

  /**
   * Collects a single broker, wrapping the SEMP client call.
   */
  private async collectOne(broker: BrokerConfig): Promise<BrokerObservation> {
    return this.sempClient.collectBroker(broker);
  }

  /**
   * Builds the normalized node list from broker observations.
   * Creates broker, VPN, client, and queue nodes.
   */
  private buildNodes(observations: BrokerObservation[]): EstateNode[] {
    const nodes: EstateNode[] = [];
    const seenClients = new Set<string>();

    for (const obs of observations) {
      const brokerConfig = this.config.brokers.find((b) => b.id === obs.brokerId);
      const brokerTags = brokerConfig?.tags ?? {};

      // Broker node
      const totalMsgRate = obs.vpns.reduce((sum, vpn) => sum + vpn.msgRate, 0);
      const totalByteRate = obs.vpns.reduce((sum, vpn) => sum + vpn.byteRate, 0);
      const totalClients = obs.vpns.reduce((sum, vpn) => sum + vpn.connectionCount, 0);

      nodes.push({
        id: `broker:${obs.brokerId}`,
        type: "broker",
        label: brokerConfig?.displayName ?? obs.brokerId,
        brokerId: obs.brokerId,
        metrics: {
          msgRate: totalMsgRate,
          byteRate: totalByteRate,
          connectedClients: totalClients,
        },
        tags: brokerTags,
      });

      // VPN nodes
      for (const vpn of obs.vpns) {
        nodes.push({
          id: `vpn:${obs.brokerId}/${vpn.vpnName}`,
          type: "vpn",
          label: vpn.vpnName,
          brokerId: obs.brokerId,
          vpnName: vpn.vpnName,
          metrics: {
            msgRate: vpn.msgRate,
            byteRate: vpn.byteRate,
            connectedClients: vpn.connectionCount,
            spoolUsage: vpn.spoolUsage,
            maxSpoolUsage: vpn.maxSpoolUsage,
          },
          tags: brokerTags,
        });
      }

      // Client nodes — deduplicate by username across brokers
      for (const client of obs.clients) {
        const clientKey = client.username
          ? `client:${client.username}`
          : `client:${obs.brokerId}/${client.vpnName}/${client.name}`;

        if (!seenClients.has(clientKey)) {
          seenClients.add(clientKey);
          nodes.push({
            id: clientKey,
            type: "client",
            label: client.username ?? client.name,
            brokerId: obs.brokerId,
            vpnName: client.vpnName,
            metrics: {
              ingressMsgRate: client.ingressMsgRate,
              egressMsgRate: client.egressMsgRate,
              msgRate: client.ingressMsgRate + client.egressMsgRate,
            },
            tags: brokerTags,
          });
        }
      }

      // Queue nodes
      for (const queue of obs.queues) {
        nodes.push({
          id: `queue:${obs.brokerId}/${queue.vpnName}/${queue.name}`,
          type: "queue",
          label: queue.name,
          brokerId: obs.brokerId,
          vpnName: queue.vpnName,
          metrics: {
            ingressMsgRate: queue.ingressMsgRate,
            egressMsgRate: queue.egressMsgRate,
            queuedMessages: queue.queuedMessages,
            bindCount: queue.bindCount,
            spoolUsage: queue.spoolUsage,
            maxSpoolUsage: queue.maxSpoolUsage,
          },
          tags: brokerTags,
        });
      }
    }

    return nodes;
  }

  /**
   * Builds the edge list from broker observations.
   * Creates connections between clients and VPNs, clients and queues.
   */
  private buildEdges(observations: BrokerObservation[]): EstateEdge[] {
    const edges: EstateEdge[] = [];
    let edgeIndex = 0;

    for (const obs of observations) {
      // Client → VPN connections
      for (const client of obs.clients) {
        const clientId = client.username
          ? `client:${client.username}`
          : `client:${obs.brokerId}/${client.vpnName}/${client.name}`;
        const vpnId = `vpn:${obs.brokerId}/${client.vpnName}`;

        edges.push({
          id: `edge:${edgeIndex++}`,
          type: "connected_to",
          source: clientId,
          target: vpnId,
          metrics: {
            ingressMsgRate: client.ingressMsgRate,
            egressMsgRate: client.egressMsgRate,
          },
        });

        // If client has ingress traffic, it publishes to the VPN
        if (client.ingressMsgRate > 0) {
          edges.push({
            id: `edge:${edgeIndex++}`,
            type: "publishes_to",
            source: clientId,
            target: vpnId,
            metrics: { msgRate: client.ingressMsgRate },
          });
        }
      }

      // Queue → VPN containment and subscription edges
      for (const queue of obs.queues) {
        const queueId = `queue:${obs.brokerId}/${queue.vpnName}/${queue.name}`;
        const vpnId = `vpn:${obs.brokerId}/${queue.vpnName}`;

        // Queue subscribes to topics on the VPN
        const queueSubs = obs.subscriptions.filter(
          (s) => s.brokerId === obs.brokerId && s.vpnName === queue.vpnName && s.queueName === queue.name
        );
        if (queueSubs.length > 0) {
          edges.push({
            id: `edge:${edgeIndex++}`,
            type: "subscribes_to",
            source: queueId,
            target: vpnId,
            metrics: { ingressMsgRate: queue.ingressMsgRate },
          });
        }

        // Consumers consume from the queue
        if (queue.bindCount > 0) {
          edges.push({
            id: `edge:${edgeIndex++}`,
            type: "consumes_from",
            source: vpnId,
            target: queueId,
            metrics: {
              egressMsgRate: queue.egressMsgRate,
              bindCount: queue.bindCount,
            },
          });
        }
      }

      // Broker mesh links
      const brokerNodeId = `broker:${obs.brokerId}`;
      const brokerConfig = this.config.brokers.find((b) => b.id === obs.brokerId);
      if (brokerConfig) {
        // Look for other brokers at the same site (potential mesh links)
        for (const otherBroker of this.config.brokers) {
          if (
            otherBroker.id !== obs.brokerId &&
            otherBroker.tags.site === brokerConfig.tags.site &&
            otherBroker.id > obs.brokerId // Avoid duplicate edges
          ) {
            edges.push({
              id: `edge:${edgeIndex++}`,
              type: "linked_to",
              source: brokerNodeId,
              target: `broker:${otherBroker.id}`,
            });
          }
        }
      }
    }

    return edges;
  }
}
