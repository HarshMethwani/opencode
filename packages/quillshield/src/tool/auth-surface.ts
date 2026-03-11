import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { analyzeProject, findContract, findContractsByPath } from "../solidity"

export const AuthSurfaceTool = Tool.define("auth-surface", {
  description:
    "Analyze Solidity authorization surface from compiler-backed facts. Shows who can call state-changing functions, what modifiers/checks protect them, and where access control looks weak or missing.",
  parameters: z.object({
    path: z.string().describe("Path to the Solidity contract file"),
    contract: z.string().optional().describe("Specific contract name in the file"),
    function: z.string().optional().describe("Optional function name filter"),
  }),
  async execute(args) {
    const filepath = path.isAbsolute(args.path) ? args.path : path.resolve(Instance.directory, args.path)
    const ir = await analyzeProject(path.dirname(filepath))
    const target =
      findContract(ir, { file: filepath, name: args.contract }) ??
      findContractsByPath(ir, filepath)[0]

    if (!target) {
      return {
        title: "Not found",
        output: `No Solidity contracts from compiler output matched: ${args.path}`,
        metadata: {},
      }
    }

    const functions = target.functions.filter((fn) => {
      if (args.function && fn.name !== args.function) return false
      return fn.visibility === "public" || fn.visibility === "external"
    })
    const lines = [`Auth Surface: ${target.name}`, `Functions analyzed: ${functions.length}`, ""]
    const warnings = [] as string[]

    functions.forEach((fn) => {
      const stateful = fn.writes.length > 0 || fn.values.length > 0
      const labels = [...new Set(fn.auth.map((item) => item.label))]
      const auth = labels.length ? labels.join(", ") : "NONE"
      lines.push(`- ${fn.visibility} ${fn.signature}`)
      lines.push(`  state-changing: ${stateful ? "yes" : "no"}`)
      lines.push(`  auth: ${auth}`)
      if (fn.modifiers.length) lines.push(`  modifiers: ${fn.modifiers.join(", ")}`)
      if (fn.reads.length) lines.push(`  reads: ${fn.reads.join(", ")}`)
      if (fn.writes.length) lines.push(`  writes: ${fn.writes.join(", ")}`)
      if (stateful && !labels.length && !fn.modifiers.some((item) => /only|owner|role|admin|auth/i.test(item))) {
        warnings.push(`${fn.signature} mutates state without an obvious authorization gate`)
      }
      if (/upgradeTo|set[A-Z]|sweep|withdraw|mint|burn|pause|unpause/i.test(fn.name) && !labels.length) {
        warnings.push(`${fn.signature} looks sensitive but has no explicit auth signal`)
      }
      if (/initialize|reinitialize/i.test(fn.name) && !labels.some((item) => /initializer/i.test(item))) {
        warnings.push(`${fn.signature} is an initializer-like function without initializer signal`)
      }
      lines.push("")
    })

    if (warnings.length) {
      lines.push("Warnings:")
      warnings.forEach((warning) => lines.push(`  ! ${warning}`))
    }

    return {
      title: `Auth surface: ${target.name}`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})
