import z from "zod"
import { Tool } from "./tool"
import { ulid } from "ulid"
import { Database, eq, and } from "@/storage/db"
import { ScopeTable } from "@/audit/audit.sql"

interface ScopeEntry {
  id: string
  path: string
  name: string
  language: string
  status: "pending" | "in-progress" | "audited"
  findingsCount: number
}

function fromRow(row: typeof ScopeTable.$inferSelect): ScopeEntry {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    language: row.language,
    status: row.audit_status as ScopeEntry["status"],
    findingsCount: row.findings_count,
  }
}

export const ScopeTrackerTool = Tool.define("scope", {
  description:
    "Manage the audit scope — track which contracts are in scope, their audit progress, and findings count. Persists across sessions in the database. Use action 'init' to clear scope, 'add' to add a contract, 'list' to see all contracts, 'status' to update a contract's audit status.",
  parameters: z.object({
    action: z.enum(["init", "add", "remove", "list", "status"]).describe("The action to perform"),
    path: z.string().optional().describe("Contract file path (for add/remove/status actions)"),
    name: z.string().optional().describe("Contract name (for add action)"),
    language: z.string().optional().describe("Language: solidity, vyper, rust, move, cairo (for add action)"),
    audit_status: z
      .enum(["pending", "in-progress", "audited"])
      .optional()
      .describe("New audit status (for status action)"),
  }),
  async execute(args, ctx) {
    switch (args.action) {
      case "init": {
        Database.use((db) => db.delete(ScopeTable).where(eq(ScopeTable.session_id, ctx.sessionID)).run())
        return {
          title: "Scope initialized",
          output: "Audit scope initialized. Use 'add' to add contracts to scope.",
          metadata: {},
        }
      }
      case "add": {
        if (!args.path) return { title: "Error", output: "Path is required for add action", metadata: {} }
        const name = args.name ?? args.path.split("/").pop()?.replace(/\.\w+$/, "") ?? "unknown"
        const existing = Database.use((db) =>
          db
            .select()
            .from(ScopeTable)
            .where(and(eq(ScopeTable.session_id, ctx.sessionID), eq(ScopeTable.path, args.path!)))
            .get(),
        )
        if (existing) return { title: "Already in scope", output: `Contract already in scope: ${args.path}`, metadata: {} }
        Database.use((db) =>
          db
            .insert(ScopeTable)
            .values({
              id: ulid(),
              session_id: ctx.sessionID,
              path: args.path!,
              name,
              language: args.language ?? "solidity",
              audit_status: "pending",
              findings_count: 0,
            })
            .run(),
        )
        return {
          title: `Added ${name}`,
          output: `Added to scope: ${name} (${args.path}) [${args.language ?? "solidity"}]`,
          metadata: {},
        }
      }
      case "remove": {
        if (!args.path) return { title: "Error", output: "Path is required for remove action", metadata: {} }
        Database.use((db) =>
          db
            .delete(ScopeTable)
            .where(and(eq(ScopeTable.session_id, ctx.sessionID), eq(ScopeTable.path, args.path!)))
            .run(),
        )
        return {
          title: "Removed from scope",
          output: `Removed from scope: ${args.path}`,
          metadata: {},
        }
      }
      case "list": {
        const rows = Database.use((db) =>
          db.select().from(ScopeTable).where(eq(ScopeTable.session_id, ctx.sessionID)).all(),
        )
        if (rows.length === 0) return { title: "Scope empty", output: "No contracts in scope yet.", metadata: {} }
        const entries = rows.map(fromRow)
        const summary = {
          total: entries.length,
          pending: entries.filter((e) => e.status === "pending").length,
          inProgress: entries.filter((e) => e.status === "in-progress").length,
          audited: entries.filter((e) => e.status === "audited").length,
        }
        const lines = entries.map(
          (e) => `[${e.status.toUpperCase()}] ${e.name} (${e.path}) [${e.language}] — ${e.findingsCount} findings`,
        )
        return {
          title: `${entries.length} contracts in scope`,
          output: [
            `Scope: ${summary.total} contracts (${summary.pending} pending, ${summary.inProgress} in-progress, ${summary.audited} audited)`,
            "",
            ...lines,
          ].join("\n"),
          metadata: {},
        }
      }
      case "status": {
        if (!args.path) return { title: "Error", output: "Path is required for status action", metadata: {} }
        const row = Database.use((db) =>
          db
            .select()
            .from(ScopeTable)
            .where(and(eq(ScopeTable.session_id, ctx.sessionID), eq(ScopeTable.path, args.path!)))
            .get(),
        )
        if (!row) return { title: "Error", output: `Contract not in scope: ${args.path}`, metadata: {} }
        if (args.audit_status) {
          Database.use((db) =>
            db.update(ScopeTable).set({ audit_status: args.audit_status! }).where(eq(ScopeTable.id, row.id)).run(),
          )
        }
        const entry = fromRow({ ...row, audit_status: args.audit_status ?? row.audit_status })
        return {
          title: `${entry.name}: ${entry.status}`,
          output: `${entry.name} (${entry.path}): status=${entry.status}, findings=${entry.findingsCount}`,
          metadata: {},
        }
      }
    }
  },
})
