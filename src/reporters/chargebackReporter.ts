/**
 * Chargeback Reporter — generates a consumption-based chargeback report.
 *
 * Groups message volume by a specified tag dimension (e.g. team, cost center,
 * environment) and produces markdown tables showing per-group consumption.
 *
 * Uses Tier 1 data (SEMP Monitor aggregate rates) by default.
 * Notes when figures are Tier 1 (aggregate) vs Tier 2 (per-topic traced).
 */

import type { EstateSnapshot } from "../model/types.js";

/** Consumption data for a single group. */
interface GroupConsumption {
  groupName: string;
  brokerCount: number;
  vpnCount: number;
  clientCount: number;
  queueCount: number;
  ingressMsgRate: number;
  egressMsgRate: number;
  totalMsgRate: number;
  ingressByteRate: number;
  egressByteRate: number;
}

/**
 * Generates a markdown chargeback report from an estate snapshot.
 *
 * @param snapshot - Current estate snapshot.
 * @param groupBy - Tag key to group consumption by (e.g. "site", "environment", "team").
 * @param period - Reporting period label (e.g. "2024-W03", "January 2024").
 * @returns Markdown-formatted chargeback report.
 *
 * @example
 * ```ts
 * const report = generateChargebackReport(snapshot, "environment", "July 2024");
 * console.log(report);
 * ```
 */
export function generateChargebackReport(
  snapshot: EstateSnapshot,
  groupBy: string,
  period: string
): string {
  const lines: string[] = [];

  lines.push(`# Chargeback Report: ${snapshot.estateName}`);
  lines.push("");
  lines.push(`> **Period:** ${period}`);
  lines.push(`> **Grouped by:** ${groupBy}`);
  lines.push(`> **Generated at:** ${snapshot.generatedAt}`);
  lines.push(`> **Data tier:** Tier 1 (SEMP Monitor aggregate rates)`);
  lines.push("");

  // Build consumption groups
  const groups = buildGroups(snapshot, groupBy);

  if (groups.length === 0) {
    lines.push(`*No data found for grouping dimension "${groupBy}".*`);
    lines.push("");
    lines.push(`Available tag keys in this estate: ${getAvailableTags(snapshot).join(", ") || "(none)"}`);
    return lines.join("\n");
  }

  // Grand totals
  const totalIngress = groups.reduce((sum, g) => sum + g.ingressMsgRate, 0);
  const totalEgress = groups.reduce((sum, g) => sum + g.egressMsgRate, 0);
  const totalMsg = groups.reduce((sum, g) => sum + g.totalMsgRate, 0);

  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| ------ | ----- |`);
  lines.push(`| Groups | ${groups.length} |`);
  lines.push(`| Total Ingress Rate | ${formatRate(totalIngress)} |`);
  lines.push(`| Total Egress Rate | ${formatRate(totalEgress)} |`);
  lines.push(`| Total Message Rate | ${formatRate(totalMsg)} |`);
  lines.push("");

  // Per-group consumption table
  lines.push("## Consumption by Group");
  lines.push("");
  lines.push(`| ${capitalize(groupBy)} | Brokers | Clients | Queues | Ingress | Egress | Total Rate | Share |`);
  lines.push(`| ${"-".repeat(groupBy.length + 2)} | ------- | ------- | ------ | ------- | ------ | ---------- | ----- |`);

  const sorted = [...groups].sort((a, b) => b.totalMsgRate - a.totalMsgRate);
  for (const group of sorted) {
    const share = totalMsg > 0 ? ((group.totalMsgRate / totalMsg) * 100).toFixed(1) : "0.0";
    lines.push(
      `| ${group.groupName} | ${group.brokerCount} | ${group.clientCount} | ${group.queueCount} | ${formatRate(group.ingressMsgRate)} | ${formatRate(group.egressMsgRate)} | ${formatRate(group.totalMsgRate)} | ${share}% |`
    );
  }

  lines.push("");

  // Provider → Consumer volume matrix (top groups)
  lines.push("## Volume Distribution");
  lines.push("");
  lines.push("Top groups by message volume (Tier 1 — aggregate rates from SEMP Monitor):");
  lines.push("");

  const topGroups = sorted.slice(0, 10);
  lines.push(`| ${capitalize(groupBy)} | Ingress (msg/s) | Egress (msg/s) | Ingress (B/s) | Egress (B/s) |`);
  lines.push(`| ${"-".repeat(groupBy.length + 2)} | --------------- | -------------- | ------------- | ------------ |`);

  for (const group of topGroups) {
    lines.push(
      `| ${group.groupName} | ${formatRate(group.ingressMsgRate)} | ${formatRate(group.egressMsgRate)} | ${formatBytes(group.ingressByteRate)} | ${formatBytes(group.egressByteRate)} |`
    );
  }

  lines.push("");

  // Notes
  lines.push("## Notes");
  lines.push("");
  lines.push("- **Tier 1 figures** are derived from SEMP Monitor API aggregate rates (msg/s, byte/s).");
  lines.push("  They represent instantaneous rates at poll time, not cumulative volume over the period.");
  lines.push("- For per-topic attribution and cumulative volume, **Tier 2** (OpenTelemetry distributed tracing) is required.");
  lines.push("  Tier 2 adds ~2x message volume to the broker — enable only with explicit approval.");
  lines.push("- Ingress = messages received by the broker from producers in this group.");
  lines.push("- Egress = messages delivered by the broker to consumers in this group.");
  lines.push(`- Grouping is based on the \`${groupBy}\` tag assigned to each broker in the estate configuration.`);
  lines.push("");

  return lines.join("\n");
}

// ─── Group Builder ──────────────────────────────────────────────────────────

function buildGroups(snapshot: EstateSnapshot, groupBy: string): GroupConsumption[] {
  const brokerNodes = snapshot.nodes.filter((n) => n.type === "broker");
  const vpnNodes = snapshot.nodes.filter((n) => n.type === "vpn");
  const clientNodes = snapshot.nodes.filter((n) => n.type === "client");
  const queueNodes = snapshot.nodes.filter((n) => n.type === "queue");

  // Group broker nodes by the specified tag
  const groupMap = new Map<string, Set<string>>();
  for (const broker of brokerNodes) {
    const tagValue = broker.tags[groupBy];
    if (!tagValue) continue;
    if (!groupMap.has(tagValue)) groupMap.set(tagValue, new Set());
    groupMap.get(tagValue)!.add(broker.brokerId);
  }

  const groups: GroupConsumption[] = [];

  for (const [groupName, brokerIds] of groupMap) {
    const groupVpns = vpnNodes.filter((n) => brokerIds.has(n.brokerId));
    const groupClients = clientNodes.filter((n) => brokerIds.has(n.brokerId));
    const groupQueues = queueNodes.filter((n) => brokerIds.has(n.brokerId));

    const ingressMsgRate = groupClients.reduce((sum, c) => sum + (c.metrics?.ingressMsgRate ?? 0), 0) +
      groupQueues.reduce((sum, q) => sum + (q.metrics?.ingressMsgRate ?? 0), 0);
    const egressMsgRate = groupClients.reduce((sum, c) => sum + (c.metrics?.egressMsgRate ?? 0), 0) +
      groupQueues.reduce((sum, q) => sum + (q.metrics?.egressMsgRate ?? 0), 0);

    // Byte rates from VPN-level aggregates (more accurate than summing clients)
    const ingressByteRate = groupVpns.reduce((sum, v) => sum + ((v.metrics?.byteRate ?? 0) / 2), 0);
    const egressByteRate = groupVpns.reduce((sum, v) => sum + ((v.metrics?.byteRate ?? 0) / 2), 0);

    groups.push({
      groupName,
      brokerCount: brokerIds.size,
      vpnCount: groupVpns.length,
      clientCount: groupClients.length,
      queueCount: groupQueues.length,
      ingressMsgRate,
      egressMsgRate,
      totalMsgRate: ingressMsgRate + egressMsgRate,
      ingressByteRate,
      egressByteRate,
    });
  }

  return groups;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function getAvailableTags(snapshot: EstateSnapshot): string[] {
  const tags = new Set<string>();
  for (const node of snapshot.nodes) {
    for (const key of Object.keys(node.tags)) {
      tags.add(key);
    }
  }
  return [...tags].sort();
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatRate(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value.toFixed(0)}`;
}

function formatBytes(value: number): string {
  if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB/s`;
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB/s`;
  if (value >= 1_024) return `${(value / 1_024).toFixed(1)} KB/s`;
  return `${value.toFixed(0)} B/s`;
}
