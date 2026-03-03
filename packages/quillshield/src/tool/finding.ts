import z from "zod"
import { Tool } from "./tool"
import { ulid } from "ulid"
import { Database, eq } from "@/storage/db"
import { FindingTable } from "@/audit/audit.sql"

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
  createdAt: number
}

function fromRow(row: typeof FindingTable.$inferSelect): Finding {
  return {
    id: row.id,
    severity: row.severity as Finding["severity"],
    title: row.title,
    description: row.description,
    impact: row.impact,
    contracts: row.contracts,
    status: row.status as Finding["status"],
    pocStatus: row.poc_status as Finding["pocStatus"],
    recommendation: row.recommendation,
    createdAt: row.time_created,
  }
}

export const FindingTool = Tool.define("finding", {
  description:
    "Manage audit findings — add, update, list, or get details of security findings. Findings persist across sessions in the database.",
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
    switch (args.action) {
      case "add": {
        if (!args.title || !args.severity)
          return { title: "Error", output: "Title and severity are required for add action", metadata: {} }
        const id = ulid()
        Database.use((db) =>
          db
            .insert(FindingTable)
            .values({
              id,
              session_id: ctx.sessionID,
              severity: args.severity!,
              title: args.title!,
              description: args.description ?? "",
              impact: args.impact ?? "",
              contracts: args.contracts ?? [],
              status: "draft",
              poc_status: "none",
              recommendation: args.recommendation ?? "",
            })
            .run(),
        )
        return {
          title: `[${args.severity.toUpperCase()}] ${args.title}`,
          output: `Finding added: ${id}\n[${args.severity.toUpperCase()}] ${args.title}\nStatus: draft | PoC: none\nContracts: ${(args.contracts ?? []).join(", ") || "none specified"}`,
          metadata: {},
        }
      }
      case "update": {
        if (!args.id) return { title: "Error", output: "ID is required for update action", metadata: {} }
        const row = Database.use((db) =>
          db.select().from(FindingTable).where(eq(FindingTable.id, args.id!)).get(),
        )
        if (!row) return { title: "Error", output: `Finding not found: ${args.id}`, metadata: {} }
        const updates: Record<string, unknown> = {}
        if (args.severity) updates.severity = args.severity
        if (args.title) updates.title = args.title
        if (args.description) updates.description = args.description
        if (args.impact) updates.impact = args.impact
        if (args.contracts) updates.contracts = args.contracts
        if (args.status) updates.status = args.status
        if (args.poc_status) updates.poc_status = args.poc_status
        if (args.recommendation) updates.recommendation = args.recommendation
        Database.use((db) => db.update(FindingTable).set(updates).where(eq(FindingTable.id, args.id!)).run())
        const updated = fromRow({ ...row, ...updates } as typeof row)
        return {
          title: `Updated: ${updated.title}`,
          output: `Finding updated: ${updated.id}\n[${updated.severity.toUpperCase()}] ${updated.title}\nStatus: ${updated.status} | PoC: ${updated.pocStatus}`,
          metadata: {},
        }
      }
      case "list": {
        const rows = Database.use((db) =>
          db.select().from(FindingTable).where(eq(FindingTable.session_id, ctx.sessionID)).all(),
        )
        if (rows.length === 0) return { title: "No findings", output: "No findings recorded yet.", metadata: {} }
        const findings = rows.map(fromRow)
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
        const row = Database.use((db) =>
          db.select().from(FindingTable).where(eq(FindingTable.id, args.id!)).get(),
        )
        if (!row) return { title: "Error", output: `Finding not found: ${args.id}`, metadata: {} }
        const finding = fromRow(row)
        return {
          title: `[${finding.severity.toUpperCase()}] ${finding.title}`,
          output: [
            `ID: ${finding.id}`,
            `Severity: ${finding.severity}`,
            `Title: ${finding.title}`,
            `Status: ${finding.status}`,
            `PoC Status: ${finding.pocStatus}`,
            `Contracts: ${finding.contracts.join(", ") || "none"}`,
            `Created: ${new Date(finding.createdAt).toISOString()}`,
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
