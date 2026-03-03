import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"

interface ScopeEntry {
  path: string
  name: string
  language: string
  status: "pending" | "in-progress" | "audited"
  findings: number
}

const scopeState = new Map<string, Map<string, ScopeEntry>>()

function getScope(sessionID: string): Map<string, ScopeEntry> {
  if (!scopeState.has(sessionID)) scopeState.set(sessionID, new Map())
  return scopeState.get(sessionID)!
}

export const ScopeTrackerTool = Tool.define("scope", {
  description:
    "Manage the audit scope — track which contracts are in scope, their audit progress, and findings count. Use action 'init' to set up scope from a directory, 'add' to add a contract, 'list' to see all contracts, 'status' to update a contract's audit status.",
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
    const scope = getScope(ctx.sessionID)

    switch (args.action) {
      case "init": {
        scope.clear()
        return {
          title: "Scope initialized",
          output: "Audit scope initialized. Use 'add' to add contracts to scope.",
          metadata: {},
        }
      }
      case "add": {
        if (!args.path) return { title: "Error", output: "Path is required for add action", metadata: {} }
        const entry: ScopeEntry = {
          path: args.path,
          name: args.name ?? args.path.split("/").pop()?.replace(/\.\w+$/, "") ?? "unknown",
          language: args.language ?? "solidity",
          status: "pending",
          findings: 0,
        }
        scope.set(args.path, entry)
        return {
          title: `Added ${entry.name}`,
          output: `Added to scope: ${entry.name} (${entry.path}) [${entry.language}]`,
          metadata: {},
        }
      }
      case "remove": {
        if (!args.path) return { title: "Error", output: "Path is required for remove action", metadata: {} }
        scope.delete(args.path)
        return {
          title: `Removed from scope`,
          output: `Removed from scope: ${args.path}`,
          metadata: {},
        }
      }
      case "list": {
        if (scope.size === 0) return { title: "Scope empty", output: "No contracts in scope yet.", metadata: {} }
        const lines = Array.from(scope.values()).map(
          (e) => `[${e.status.toUpperCase()}] ${e.name} (${e.path}) [${e.language}] — ${e.findings} findings`,
        )
        const summary = {
          total: scope.size,
          pending: Array.from(scope.values()).filter((e) => e.status === "pending").length,
          inProgress: Array.from(scope.values()).filter((e) => e.status === "in-progress").length,
          audited: Array.from(scope.values()).filter((e) => e.status === "audited").length,
        }
        return {
          title: `${scope.size} contracts in scope`,
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
        const entry = scope.get(args.path)
        if (!entry) return { title: "Error", output: `Contract not in scope: ${args.path}`, metadata: {} }
        if (args.audit_status) entry.status = args.audit_status
        return {
          title: `${entry.name}: ${entry.status}`,
          output: `${entry.name} (${entry.path}): status=${entry.status}, findings=${entry.findings}`,
          metadata: {},
        }
      }
    }
  },
})
