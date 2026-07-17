/**
 * Inventory Reporter — generates a markdown inventory report of the estate.
 *
 * Produces a summary table of all brokers with key metrics, followed by
 * rollup sections grouped by tag dimensions (site, region, environment).
 */

import type { EstateNode, EstateSnapshot } from "../model/types.js";

/**
 * Generates a markdown inventory report from an estate snapshot.
 *
 * @param snapshot - Current estate snapshot.
 * @returns Markdown-formatted inventory report.
 *
 * @example
 * ```ts
 * const report = generateInventoryReport(snapshot);
 * console.log(report);
 * ```
 */
export function generateInventoryReport(snapshot: EstateSnapshot): string {
  const lines: string[] = [];

  lines.push(`# Estate Inventory: ${snapshot.estateName}`);
  lines.push("");
  lines.push(`> Generated at ${snapshot.generatedAt}`);
  lines.push("");

  // Summary statistics
  const brokerNodes = snapshot.nodes.filter((n) => n.type === "broker");
  const vpnNodes = snapshot.nodes.filter((n) => n.type === "vpn");
  const clientNodes = snapshot.nodes.filter((n) => n.type === "client");
  const queueNodes = snapshot.nodes.filter((n) => n.type === "queue");

  const totalMsgRate = brokerNodes.reduce((sum, n) => sum + (n.metrics?.msgRate ?? 0), 0);
  const totalSpool = vpnNodes.reduce((sum, n) => sum + (n.metrics?.spoolUsage ?? 0), 0);

  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| ------ | ----- |`);
  lines.push(`| Brokers | ${brokerNodes.length} |`);
  lines.push(`| Message VPNs | ${vpnNodes.length} |`);
  lines.push(`| Connected Clients | ${clientNodes.length} |`);
  lines.push(`| Queues | ${queueNodes.length} |`);
  lines.push(`| Total Message Rate | ${formatRate(totalMsgRate)} |`);
  lines.push(`| Total Spool Usage | ${formatMB(totalSpool)} |`);
  lines.push(`| Brokers Connected | ${snapshot.brokerStatuses.filter((s) => s.status === "connected").length}/${snapshot.brokerStatuses.length} |`);
  lines.push("");

  // Per-broker table
  lines.push("## Brokers");
  lines.push("");
  lines.push("| Broker | VPNs | Clients | Queues | Msg Rate | Spool | Site | Region | Environment |");
  lines.push("| ------ | ---- | ------- | ------ | -------- | ----- | ---- | ------ | ----------- |");

  for (const broker of brokerNodes) {
    const vpnCount = vpnNodes.filter((n) => n.brokerId === broker.brokerId).length;
    const clientCount = clientNodes.filter((n) => n.brokerId === broker.brokerId).length;
    const queueCount = queueNodes.filter((n) => n.brokerId === broker.brokerId).length;
    const msgRate = broker.metrics?.msgRate ?? 0;
    const spool = vpnNodes
      .filter((n) => n.brokerId === broker.brokerId)
      .reduce((sum, n) => sum + (n.metrics?.spoolUsage ?? 0), 0);

    const site = broker.tags.site ?? "-";
    const region = broker.tags.region ?? "-";
    const env = broker.tags.environment ?? "-";

    lines.push(
      `| ${broker.label} | ${vpnCount} | ${clientCount} | ${queueCount} | ${formatRate(msgRate)} | ${formatMB(spool)} | ${site} | ${region} | ${env} |`
    );
  }

  lines.push("");

  // Rollup by tag dimensions
  lines.push(...generateRollup("Site", "site", brokerNodes, vpnNodes, clientNodes, queueNodes));
  lines.push(...generateRollup("Region", "region", brokerNodes, vpnNodes, clientNodes, queueNodes));
  lines.push(...generateRollup("Environment", "environment", brokerNodes, vpnNodes, clientNodes, queueNodes));

  // Unreachable brokers
  const unreachable = snapshot.brokerStatuses.filter((s) => s.status !== "connected");
  if (unreachable.length > 0) {
    lines.push("## Unreachable Brokers");
    lines.push("");
    lines.push("| Broker | Status | Error |");
    lines.push("| ------ | ------ | ----- |");
    for (const status of unreachable) {
      lines.push(`| ${status.displayName} | ${status.status} | ${status.error ?? "-"} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Rollup by Tag Dimension ────────────────────────────────────────────────

function generateRollup(
  title: string,
  tagKey: string,
  brokerNodes: EstateNode[],
  vpnNodes: EstateNode[],
  clientNodes: EstateNode[],
  queueNodes: EstateNode[]
): string[] {
  const lines: string[] = [];

  // Group brokers by tag value
  const groups = new Map<string, EstateNode[]>();
  for (const broker of brokerNodes) {
    const value = broker.tags[tagKey] ?? "(untagged)";
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value)!.push(broker);
  }

  if (groups.size <= 1) return lines; // No meaningful rollup if everything is in one group

  lines.push(`## By ${title}`);
  lines.push("");
  lines.push(`| ${title} | Brokers | VPNs | Clients | Queues | Msg Rate |`);
  lines.push(`| ${"-".repeat(title.length)} | ------- | ---- | ------- | ------ | -------- |`);

  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [value, brokers] of sortedGroups) {
    const brokerIds = new Set(brokers.map((b) => b.brokerId));
    const vpnCount = vpnNodes.filter((n) => brokerIds.has(n.brokerId)).length;
    const clientCount = clientNodes.filter((n) => brokerIds.has(n.brokerId)).length;
    const queueCount = queueNodes.filter((n) => brokerIds.has(n.brokerId)).length;
    const msgRate = brokers.reduce((sum, b) => sum + (b.metrics?.msgRate ?? 0), 0);

    lines.push(`| ${value} | ${brokers.length} | ${vpnCount} | ${clientCount} | ${queueCount} | ${formatRate(msgRate)} |`);
  }

  lines.push("");
  return lines;
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatRate(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M msg/s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k msg/s`;
  return `${value.toFixed(0)} msg/s`;
}

function formatMB(value: number): string {
  if (value >= 1_024) return `${(value / 1_024).toFixed(1)} GB`;
  return `${value.toFixed(1)} MB`;
}
