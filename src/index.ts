/**
 * Solace Estate Management — CLI entry point.
 *
 * Commands:
 *   inventory   — Generate estate inventory report
 *   health      — Analyze estate health and capacity
 *   security    — Audit security posture
 *   topology    — Export estate topology as JSON snapshot
 *   chargeback  — Generate consumption chargeback report
 *   serve       — Start API server (not yet implemented)
 *
 * Configuration is loaded from config/estate.yaml (or ESTATE_CONFIG_PATH env var).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BrokerAuth, BrokerConfig, EstateConfig } from "./model/types.js";
import { EstateCollector } from "./collector/estateCollector.js";
import { analyzeHealth } from "./analyzers/healthAnalyzer.js";
import { analyzeSecurityPosture } from "./analyzers/securityAnalyzer.js";
import { generateInventoryReport } from "./reporters/inventoryReporter.js";
import { generateChargebackReport } from "./reporters/chargebackReporter.js";

// ─── Config Loader ──────────────────────────────────────────────────────────

/** Raw YAML structure for the estate config file. */
interface RawEstateYaml {
  estate?: {
    name?: string;
    poll_interval_seconds?: number;
  };
  brokers?: Array<{
    id: string;
    display_name?: string;
    semp_url: string;
    vpns?: string[];
    auth?: {
      mode?: "basic" | "bearer";
      username_env?: string;
      password_env?: string;
      token_env?: string;
    };
    tags?: Record<string, string>;
    tls_reject_unauthorized?: boolean;
  }>;
}

/**
 * Loads and validates the estate configuration from a YAML file.
 */
function loadConfig(configPath: string): EstateConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) as RawEstateYaml;

  if (!parsed.brokers || parsed.brokers.length === 0) {
    throw new Error(`No brokers defined in config: ${configPath}`);
  }

  const brokers: BrokerConfig[] = parsed.brokers.map((b) => {
    const auth: BrokerAuth = {
      mode: b.auth?.mode ?? "basic",
      usernameEnv: b.auth?.username_env,
      passwordEnv: b.auth?.password_env,
      tokenEnv: b.auth?.token_env,
    };

    return {
      id: b.id,
      displayName: b.display_name ?? b.id,
      sempUrl: b.semp_url,
      vpns: b.vpns ?? ["default"],
      auth,
      tags: b.tags ?? {},
      tlsRejectUnauthorized: b.tls_reject_unauthorized ?? true,
    };
  });

  return {
    name: parsed.estate?.name ?? "Unnamed Estate",
    pollIntervalSeconds: parsed.estate?.poll_interval_seconds ?? 30,
    brokers,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `
Solace Estate Management CLI

Usage: npx tsx src/index.ts <command> [options]

Commands:
  inventory                    Generate estate inventory report (markdown)
  health                       Analyze estate health and capacity
  security                     Audit security posture
  topology                     Export estate topology as JSON snapshot
  chargeback [--group-by TAG]  Generate consumption chargeback report
  serve                        Start API server (coming soon)

Options:
  --config PATH    Config file path (default: config/estate.yaml or ESTATE_CONFIG_PATH)
  --group-by TAG   Tag dimension for chargeback grouping (default: "environment")
  --period LABEL   Reporting period label for chargeback (default: current month)
  --help           Show this help message
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];

  // Parse options
  const configPath = getOption(args, "--config") ??
    process.env.ESTATE_CONFIG_PATH ??
    resolve("config/estate.yaml");
  const groupBy = getOption(args, "--group-by") ?? "environment";
  const period = getOption(args, "--period") ?? getCurrentMonth();

  // Load config
  let config: EstateConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error loading config from ${configPath}: ${message}`);
    process.exit(1);
  }

  console.error(`[estate] Loaded config: "${config.name}" with ${config.brokers.length} broker(s)`);

  switch (command) {
    case "inventory": {
      const snapshot = await collect(config);
      const report = generateInventoryReport(snapshot);
      console.log(report);
      break;
    }

    case "health": {
      const snapshot = await collect(config);
      const findings = analyzeHealth(snapshot);
      if (findings.length === 0) {
        console.log("✓ No health issues detected.");
      } else {
        console.log(`# Health Analysis: ${config.name}\n`);
        console.log(`Found ${findings.length} finding(s):\n`);
        for (const f of findings) {
          const icon = f.severity === "critical" ? "🔴" : f.severity === "high" ? "🟠" : f.severity === "medium" ? "🟡" : "⚪";
          console.log(`${icon} [${f.severity.toUpperCase()}] ${f.message}`);
          if (f.value !== undefined) {
            console.log(`   Value: ${f.value}${f.limit !== undefined ? ` / Limit: ${f.limit}` : ""}`);
          }
          console.log("");
        }
      }
      break;
    }

    case "security": {
      const snapshot = await collect(config);
      const findings = analyzeSecurityPosture(snapshot, config);
      if (findings.length === 0) {
        console.log("✓ No security issues detected (note: full audit requires SEMP Config API access).");
      } else {
        console.log(`# Security Posture: ${config.name}\n`);
        console.log(`Found ${findings.length} finding(s):\n`);
        for (const f of findings) {
          const icon = f.severity === "critical" ? "🔴" : f.severity === "high" ? "🟠" : f.severity === "medium" ? "🟡" : "⚪";
          console.log(`${icon} [${f.severity.toUpperCase()}] ${f.check}`);
          console.log(`   Broker: ${f.brokerId}${f.vpnName ? ` / VPN: ${f.vpnName}` : ""}`);
          console.log(`   Expected: ${f.expected}`);
          console.log(`   Actual: ${f.actual}`);
          console.log(`   Fix: ${f.remediation}`);
          console.log("");
        }
      }
      break;
    }

    case "topology": {
      const snapshot = await collect(config);
      console.log(JSON.stringify(snapshot, null, 2));
      break;
    }

    case "chargeback": {
      const snapshot = await collect(config);
      const report = generateChargebackReport(snapshot, groupBy, period);
      console.log(report);
      break;
    }

    case "serve": {
      console.error("[estate] API server not yet implemented. Use 'inventory', 'health', 'security', 'topology', or 'chargeback' commands.");
      process.exit(1);
      break;
    }

    default: {
      console.error(`Unknown command: "${command}"\n`);
      console.log(USAGE);
      process.exit(1);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function collect(config: EstateConfig) {
  console.error("[estate] Collecting from all brokers...");
  const collector = new EstateCollector(config);
  const snapshot = await collector.collect();
  const connected = snapshot.brokerStatuses.filter((s) => s.status === "connected").length;
  const total = snapshot.brokerStatuses.length;
  console.error(`[estate] Collection complete: ${connected}/${total} brokers connected, ${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges`);
  return snapshot;
}

function getOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx >= args.length - 1) return undefined;
  return args[idx + 1];
}

function getCurrentMonth(): string {
  const now = new Date();
  return now.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`[estate] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
