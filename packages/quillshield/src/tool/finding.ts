import z from "zod"
import { Tool } from "./tool"
import { ulid } from "ulid"

export interface Finding {
  id: string
  severity: "critical" | "high" | "medium" | "low" | "informational"
  title: string
  description: string
  impact: string
  contracts: string[]
  status: "draft" | "confirmed" | "false-positive"
  pocStatus: "none" | "written" | "passing" | "failing"
  recommendation: string
  createdAt: string
}

const findingsState = new Map<string, Finding[]>()

function getFindings(sessionID: string): Finding[] {
  if (!findingsState.has(sessionID)) findingsState.set(sessionID, [])
  return findingsState.get(sessionID)!
}

export const FindingTool = Tool.define("finding", {
  description:
    "Manage audit findings — add, update, list, or get details of security findings. Findings persist across the audit session.",
  parameters: z.object({
    action: z.enum(["add", "update", "list", "get"]).describe("The action to perform"),
    id: z.string().optional().describe("Finding ID (for update/get actions)"),
    severity: z
      .enum(["critical", "high", "medium", "low", "informational"])
      .optional()
      .describe("Severity level (for add/update)"),
    title: z.string().optional().describe("Finding title (for add/update)"),
    description: z.string().optional().describe("Detailed description (for add/update)"),
    impact: z.string().optional().describe("Impact description (for add/update)"),
    contracts: z.array(z.string()).optional().describe("Affected contract paths (for add/update)"),
    status: z.enum(["draft", "confirmed", "false-positive"]).optional().describe("Finding status (for update)"),
    poc_status: z.enum(["none", "written", "passing", "failing"]).optional().describe("PoC status (for update)"),
    recommendation: z.string().optional().describe("Fix recommendation (for add/update)"),
  }),
  async execute(args, ctx) {
    const findings = getFindings(ctx.sessionID)

    switch (args.action) {
      case "add": {
        if (!args.title || !args.severity)
          return { title: "Error", output: "Title and severity are required for add action", metadata: {} }
        const finding: Finding = {
          id: ulid(),
          severity: args.severity,
          title: args.title,
          description: args.description ?? "",
          impact: args.impact ?? "",
          contracts: args.contracts ?? [],
          status: "draft",
          pocStatus: "none",
          recommendation: args.recommendation ?? "",
          createdAt: new Date().toISOString(),
        }
        findings.push(finding)
        return {
          title: `[${finding.severity.toUpperCase()}] ${finding.title}`,
          output: `Finding added: ${finding.id}\n[${finding.severity.toUpperCase()}] ${finding.title}\nStatus: ${finding.status} | PoC: ${finding.pocStatus}\nContracts: ${finding.contracts.join(", ") || "none specified"}`,
          metadata: {},
        }
      }
      case "update": {
        if (!args.id) return { title: "Error", output: "ID is required for update action", metadata: {} }
        const finding = findings.find((f) => f.id === args.id)
        if (!finding) return { title: "Error", output: `Finding not found: ${args.id}`, metadata: {} }
        if (args.severity) finding.severity = args.severity
        if (args.title) finding.title = args.title
        if (args.description) finding.description = args.description
        if (args.impact) finding.impact = args.impact
        if (args.contracts) finding.contracts = args.contracts
        if (args.status) finding.status = args.status
        if (args.poc_status) finding.pocStatus = args.poc_status
        if (args.recommendation) finding.recommendation = args.recommendation
        return {
          title: `Updated: ${finding.title}`,
          output: `Finding updated: ${finding.id}\n[${finding.severity.toUpperCase()}] ${finding.title}\nStatus: ${finding.status} | PoC: ${finding.pocStatus}`,
          metadata: {},
        }
      }
      case "list": {
        if (findings.length === 0) return { title: "No findings", output: "No findings recorded yet.", metadata: {} }
        const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 }
        for (const f of findings) bySeverity[f.severity]++
        const lines = findings.map(
          (f) =>
            `${f.id} [${f.severity.toUpperCase()}] ${f.title} (${f.status}${f.pocStatus !== "none" ? `, PoC: ${f.pocStatus}` : ""})`,
        )
        return {
          title: `${findings.length} findings`,
          output: [
            `Findings: ${findings.length} total — ${bySeverity.critical}C / ${bySeverity.high}H / ${bySeverity.medium}M / ${bySeverity.low}L / ${bySeverity.informational}I`,
            "",
            ...lines,
          ].join("\n"),
          metadata: {},
        }
      }
      case "get": {
        if (!args.id) return { title: "Error", output: "ID is required for get action", metadata: {} }
        const finding = findings.find((f) => f.id === args.id)
        if (!finding) return { title: "Error", output: `Finding not found: ${args.id}`, metadata: {} }
        return {
          title: `[${finding.severity.toUpperCase()}] ${finding.title}`,
          output: [
            `ID: ${finding.id}`,
            `Severity: ${finding.severity}`,
            `Title: ${finding.title}`,
            `Status: ${finding.status}`,
            `PoC Status: ${finding.pocStatus}`,
            `Contracts: ${finding.contracts.join(", ") || "none"}`,
            `Created: ${finding.createdAt}`,
            "",
            "Description:",
            finding.description,
            "",
            "Impact:",
            finding.impact,
            "",
            "Recommendation:",
            finding.recommendation,
          ].join("\n"),
          metadata: {},
        }
      }
    }
  },
})
