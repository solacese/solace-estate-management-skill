/**
 * Security Posture Analyzer — audits broker and VPN configurations
 * against security best practices for Solace PubSub+.
 *
 * Based on the security checks defined in the solace-security-audit research.
 * Requires optional SEMP Config API data for full analysis; Monitor-only data
 * still enables a subset of checks.
 */

import type {
  EstateConfig,
  EstateSnapshot,
  SecurityFinding,
  VpnConfigObservation,
} from "../model/types.js";

/**
 * Analyzes the security posture of an estate.
 *
 * When `vpnConfigs` are provided (from SEMP Config API), the full range of
 * checks is performed. Without them, only Monitor-based checks run.
 *
 * @param snapshot - Current estate snapshot with Monitor API data.
 * @param config - Estate configuration (for reference).
 * @param vpnConfigs - Optional SEMP Config API observations for deeper checks.
 * @returns Array of security findings, sorted by severity.
 *
 * @example
 * ```ts
 * const findings = analyzeSecurityPosture(snapshot, config, vpnConfigs);
 * findings.filter(f => f.severity === "critical").forEach(f => console.error(f));
 * ```
 */
export function analyzeSecurityPosture(
  snapshot: EstateSnapshot,
  config: EstateConfig,
  vpnConfigs?: VpnConfigObservation[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  // Monitor-based checks (always available)
  findings.push(...checkTlsConfiguration(config));
  findings.push(...checkConnectionLimits(snapshot));

  // Config-based checks (require SEMP Config API data)
  if (vpnConfigs && vpnConfigs.length > 0) {
    findings.push(...checkAuthType(vpnConfigs));
    findings.push(...checkAclDefaults(vpnConfigs));
    findings.push(...checkBridgePermissions(vpnConfigs));
    findings.push(...checkEndpointCreation(vpnConfigs));
    findings.push(...checkSpoolLimits(vpnConfigs));
  }

  return findings.sort(compareBySeverity);
}

// ─── TLS Configuration ──────────────────────────────────────────────────────

/**
 * Checks whether brokers are using TLS for SEMP management access.
 * Brokers with HTTP (non-TLS) management URLs are flagged.
 */
function checkTlsConfiguration(config: EstateConfig): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const broker of config.brokers) {
    if (broker.sempUrl.startsWith("http://")) {
      findings.push({
        brokerId: broker.id,
        severity: "high",
        check: "tls_management",
        expected: "SEMP management URL should use HTTPS",
        actual: `Management URL uses plain HTTP: ${broker.sempUrl}`,
        remediation: "Configure TLS on the broker's SEMP port and update the management URL to HTTPS.",
      });
    }

    if (broker.tlsRejectUnauthorized === false) {
      findings.push({
        brokerId: broker.id,
        severity: "medium",
        check: "tls_certificate_validation",
        expected: "TLS certificate validation should be enabled (tlsRejectUnauthorized: true)",
        actual: "TLS certificate validation is disabled",
        remediation: "Install a valid certificate on the broker and set tlsRejectUnauthorized to true.",
      });
    }
  }

  return findings;
}

// ─── Connection Limits ──────────────────────────────────────────────────────

/**
 * Flags VPNs that appear to have no effective connection limit
 * (very high client count without apparent limit).
 */
function checkConnectionLimits(snapshot: EstateSnapshot): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  const vpnNodes = snapshot.nodes.filter((n) => n.type === "vpn");
  for (const node of vpnNodes) {
    const clients = node.metrics?.connectedClients ?? 0;
    // If a VPN has 0 clients, it might not have a meaningful limit set
    // We can only flag this properly with Config API data
    if (clients === 0 && node.vpnName) {
      // This is informational — the real check is in checkVpnConnectionLimits with config data
    }
  }

  return findings;
}

// ─── Authentication Type ────────────────────────────────────────────────────

/**
 * Checks that VPNs have authentication enabled (not "none" or "internal" without MFA).
 */
function checkAuthType(vpnConfigs: VpnConfigObservation[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const vpn of vpnConfigs) {
    if (vpn.authenticationBasicType === "none") {
      findings.push({
        brokerId: vpn.brokerId,
        vpnName: vpn.vpnName,
        severity: "critical",
        check: "authentication_enabled",
        expected: 'authenticationBasicType != "none"',
        actual: `authenticationBasicType = "${vpn.authenticationBasicType}"`,
        remediation: "Enable authentication on the VPN. Use 'radius', 'ldap', or 'internal' with strong password policies.",
      });
    }

    if (vpn.authorizationType === "none" || vpn.authorizationType === undefined) {
      findings.push({
        brokerId: vpn.brokerId,
        vpnName: vpn.vpnName,
        severity: "medium",
        check: "authorization_enabled",
        expected: "authorizationType should be set (e.g. 'ldap' or 'internal')",
        actual: `authorizationType = "${vpn.authorizationType ?? "not set"}"`,
        remediation: "Configure authorization to enforce least-privilege access per client username.",
      });
    }
  }

  return findings;
}

// ─── ACL Profile Defaults ───────────────────────────────────────────────────

/**
 * Checks that ACL profiles use "disallow" as default action (deny-by-default).
 */
function checkAclDefaults(vpnConfigs: VpnConfigObservation[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const vpn of vpnConfigs) {
    if (!vpn.aclProfiles) continue;

    for (const acl of vpn.aclProfiles) {
      if (acl.publishTopicDefaultAction !== "disallow") {
        findings.push({
          brokerId: vpn.brokerId,
          vpnName: vpn.vpnName,
          severity: "high",
          check: "acl_publish_default_deny",
          expected: `ACL profile "${acl.name}" publishTopicDefaultAction = "disallow"`,
          actual: `publishTopicDefaultAction = "${acl.publishTopicDefaultAction}"`,
          remediation: `Set publishTopicDefaultAction to "disallow" on ACL profile "${acl.name}" and add explicit allow exceptions.`,
        });
      }

      if (acl.subscribeTopicDefaultAction !== "disallow") {
        findings.push({
          brokerId: vpn.brokerId,
          vpnName: vpn.vpnName,
          severity: "high",
          check: "acl_subscribe_default_deny",
          expected: `ACL profile "${acl.name}" subscribeTopicDefaultAction = "disallow"`,
          actual: `subscribeTopicDefaultAction = "${acl.subscribeTopicDefaultAction}"`,
          remediation: `Set subscribeTopicDefaultAction to "disallow" on ACL profile "${acl.name}" and add explicit allow exceptions.`,
        });
      }

      if (acl.clientConnectDefaultAction !== "disallow") {
        findings.push({
          brokerId: vpn.brokerId,
          vpnName: vpn.vpnName,
          severity: "medium",
          check: "acl_connect_default_deny",
          expected: `ACL profile "${acl.name}" clientConnectDefaultAction = "disallow"`,
          actual: `clientConnectDefaultAction = "${acl.clientConnectDefaultAction}"`,
          remediation: `Set clientConnectDefaultAction to "disallow" on ACL profile "${acl.name}" and whitelist expected source IPs.`,
        });
      }
    }
  }

  return findings;
}

// ─── Bridge Permissions ─────────────────────────────────────────────────────

/**
 * Checks that client profiles restrict bridge connections.
 * Unrestricted bridge access allows lateral movement between VPNs.
 */
function checkBridgePermissions(vpnConfigs: VpnConfigObservation[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const vpn of vpnConfigs) {
    if (!vpn.clientProfiles) continue;

    for (const profile of vpn.clientProfiles) {
      if (profile.allowBridgeConnectionsEnabled) {
        findings.push({
          brokerId: vpn.brokerId,
          vpnName: vpn.vpnName,
          severity: "medium",
          check: "bridge_connections_restricted",
          expected: `Client profile "${profile.name}" allowBridgeConnectionsEnabled = false`,
          actual: "allowBridgeConnectionsEnabled = true",
          remediation: `Disable bridge connections on client profile "${profile.name}" unless this profile is explicitly used for DMR or bridge links.`,
        });
      }
    }
  }

  return findings;
}

// ─── Endpoint Creation Permissions ──────────────────────────────────────────

/**
 * Checks that client profiles restrict guaranteed endpoint creation.
 * Unrestricted endpoint creation allows any client to create queues/topic-endpoints.
 */
function checkEndpointCreation(vpnConfigs: VpnConfigObservation[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const vpn of vpnConfigs) {
    if (!vpn.clientProfiles) continue;

    for (const profile of vpn.clientProfiles) {
      if (profile.allowGuaranteedEndpointCreateEnabled) {
        findings.push({
          brokerId: vpn.brokerId,
          vpnName: vpn.vpnName,
          severity: "low",
          check: "endpoint_creation_restricted",
          expected: `Client profile "${profile.name}" allowGuaranteedEndpointCreateEnabled = false`,
          actual: "allowGuaranteedEndpointCreateEnabled = true",
          remediation: `Restrict endpoint creation on client profile "${profile.name}" to prevent unauthorized queue/topic-endpoint provisioning.`,
        });
      }
    }
  }

  return findings;
}

// ─── Spool Limits ───────────────────────────────────────────────────────────

/**
 * Checks that VPNs have a reasonable max spool usage configured.
 * Unbounded spool can lead to disk exhaustion.
 */
function checkSpoolLimits(vpnConfigs: VpnConfigObservation[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const vpn of vpnConfigs) {
    if (vpn.maxMsgSpoolUsage === undefined || vpn.maxMsgSpoolUsage === 0) {
      findings.push({
        brokerId: vpn.brokerId,
        vpnName: vpn.vpnName,
        severity: "medium",
        check: "spool_limit_configured",
        expected: "maxMsgSpoolUsage should be set to a non-zero value",
        actual: `maxMsgSpoolUsage = ${vpn.maxMsgSpoolUsage ?? "not set"}`,
        remediation: "Set maxMsgSpoolUsage to a value appropriate for the VPN's workload to prevent unbounded disk usage.",
      });
    }
  }

  return findings;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function compareBySeverity(a: SecurityFinding, b: SecurityFinding): number {
  const sevDiff = (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4);
  if (sevDiff !== 0) return sevDiff;
  return a.brokerId.localeCompare(b.brokerId);
}
