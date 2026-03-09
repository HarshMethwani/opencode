import z from "zod"
import { Tool } from "./tool"
import { ulid } from "ulid"
import { Database, eq } from "@/storage/db"
import { FindingTable, type CodeLocation, type TraceStep } from "@/audit/audit.sql"

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
  confidence: "high" | "medium" | "low"
  invariant: string
  locations: CodeLocation[]
  trace: TraceStep[]
  pocFile: string
  category: string
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
    confidence: row.confidence as Finding["confidence"],
    invariant: row.invariant,
    locations: row.locations,
    trace: row.trace,
    pocFile: row.poc_file,
    category: row.category,
    createdAt: row.time_created,
  }
}

const LocationSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  function: z.string().optional(),
})

const TraceStepSchema = z.object({
  location: LocationSchema,
  action: z.string(),
  note: z.string().optional(),
})

export const FindingTool = Tool.define("finding", {
  description:
    "Manage audit findings with full evidence tracking. Records severity, code locations, execution trace, invariant violated, confidence level, and PoC references. Findings persist across sessions in the database.",
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
    confidence: z
      .enum(["high", "medium", "low"])
      .optional()
      .describe("Confidence level — high: proven with PoC, medium: traced but unproven, low: hypothesis (for add/update)"),
    invariant: z
      .string()
      .optional()
      .describe("The invariant or assumption that is violated, e.g. 'balance[user] >= withdrawAmount at L45' (for add/update)"),
    locations: z
      .array(LocationSchema)
      .optional()
      .describe("Code locations relevant to this finding — file path, line number, function name (for add/update)"),
    trace: z
      .array(TraceStepSchema)
      .optional()
      .describe("Execution trace proving the vulnerability — ordered steps with location, action, and notes (for add/update)"),
    poc_file: z.string().optional().describe("Path to the PoC test file (for update)"),
    category: z
      .string()
      .optional()
      .describe("Vulnerability category, e.g. 'reentrancy', 'missing-signer', 'pda-manipulation', 'access-control' (for add/update)"),
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
              confidence: args.confidence ?? "medium",
              invariant: args.invariant ?? "",
              locations: args.locations ?? [],
              trace: args.trace ?? [],
              poc_file: args.poc_file ?? "",
              category: args.category ?? "",
            })
            .run(),
        )
        const confidenceTag = args.confidence ? ` [${args.confidence} confidence]` : ""
        const categoryTag = args.category ? ` (${args.category})` : ""
        const locationSummary = (args.locations ?? []).map((l) => `${l.file}${l.line ? `:${l.line}` : ""}`).join(", ")
        return {
          title: `[${args.severity.toUpperCase()}] ${args.title}`,
          output: [
            `Finding added: ${id}`,
            `[${args.severity.toUpperCase()}] ${args.title}${categoryTag}${confidenceTag}`,
            `Status: draft | PoC: none`,
            `Contracts: ${(args.contracts ?? []).join(", ") || "none specified"}`,
            locationSummary ? `Locations: ${locationSummary}` : "",
            args.invariant ? `Invariant: ${args.invariant}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
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
        if (args.confidence) updates.confidence = args.confidence
        if (args.invariant) updates.invariant = args.invariant
        if (args.locations) updates.locations = args.locations
        if (args.trace) updates.trace = args.trace
        if (args.poc_file) updates.poc_file = args.poc_file
        if (args.category) updates.category = args.category
        Database.use((db) => db.update(FindingTable).set(updates).where(eq(FindingTable.id, args.id!)).run())
        const updated = fromRow({ ...row, ...updates } as typeof row)
        return {
          title: `Updated: ${updated.title}`,
          output: `Finding updated: ${updated.id}\n[${updated.severity.toUpperCase()}] ${updated.title}\nStatus: ${updated.status} | PoC: ${updated.pocStatus} | Confidence: ${updated.confidence}`,
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
        const lines = findings.map((f) => {
          const conf = f.confidence !== "medium" ? ` [${f.confidence}]` : ""
          const cat = f.category ? ` (${f.category})` : ""
          const poc = f.pocStatus !== "none" ? ` PoC:${f.pocStatus}` : ""
          return `${f.id} [${f.severity.toUpperCase()}] ${f.title}${cat} — ${f.status}${poc}${conf}`
        })
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
        const sections = [
          `ID: ${finding.id}`,
          `Severity: ${finding.severity}`,
          `Category: ${finding.category || "unclassified"}`,
          `Title: ${finding.title}`,
          `Status: ${finding.status}`,
          `Confidence: ${finding.confidence}`,
          `PoC Status: ${finding.pocStatus}`,
          finding.pocFile ? `PoC File: ${finding.pocFile}` : "",
          `Contracts: ${finding.contracts.join(", ") || "none"}`,
          `Created: ${new Date(finding.createdAt).toISOString()}`,
        ]

        if (finding.invariant) {
          sections.push("", `Invariant Violated: ${finding.invariant}`)
        }

        if (finding.locations.length) {
          sections.push("", "Code Locations:")
          for (const loc of finding.locations) {
            const fn = loc.function ? ` in ${loc.function}` : ""
            sections.push(`  ${loc.file}${loc.line ? `:${loc.line}` : ""}${fn}`)
          }
        }

        if (finding.trace.length) {
          sections.push("", "Execution Trace:")
          for (let i = 0; i < finding.trace.length; i++) {
            const step = finding.trace[i]!
            const loc = `${step.location.file}${step.location.line ? `:${step.location.line}` : ""}`
            const note = step.note ? ` — ${step.note}` : ""
            sections.push(`  ${i + 1}. [${loc}] ${step.action}${note}`)
          }
        }

        sections.push(
          "",
          "Description:",
          finding.description,
          "",
          "Impact:",
          finding.impact,
          "",
          "Recommendation:",
          finding.recommendation,
        )

        return {
          title: `[${finding.severity.toUpperCase()}] ${finding.title}`,
          output: sections.filter((s) => s !== undefined).join("\n"),
          metadata: {},
        }
      }
    }
  },
})
