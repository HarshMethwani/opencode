import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { analyzeProject, findContract, findContractsByPath } from "../solidity"

export const ValueFlowTool = Tool.define("value-flow", {
  description:
    "Analyze Solidity ETH and token movement from compiler-backed facts. Shows incoming value, outgoing transfers, accounting writes, and common integration-risk assumptions.",
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

    const functions = target.functions.filter((fn) => !args.function || fn.name === args.function)
    const lines = [`Value Flow: ${target.name}`, ""]
    const warnings = [] as string[]

    functions.forEach((fn) => {
      const values = fn.values
      if (!values.length) return
      lines.push(`=== ${fn.signature} ===`)
      values.forEach((value) => {
        const targetName = value.target ? ` -> ${value.target}` : ""
        lines.push(`  L${value.line ?? "?"} ${value.asset} ${value.action}${targetName}`)
      })
      if (fn.writes.length) lines.push(`  accounting writes: ${fn.writes.join(", ")}`)
      if (values.some((value) => value.asset === "erc20" && value.action === "transfer_from") && !fn.writes.length) {
        warnings.push(`${fn.signature} moves tokens without any tracked accounting write`)
      }
      if (values.some((value) => value.asset === "eth" && value.action === "send") && fn.operations.some((op) => op.kind === "call" && op.call_kind !== "internal")) {
        warnings.push(`${fn.signature} transfers ETH through an external control handoff`)
      }
      if (values.some((value) => value.asset === "erc20" && value.action === "transfer")) {
        warnings.push(`${fn.signature} uses token transfers — verify fee-on-transfer and rebasing assumptions manually`)
      }
      lines.push("")
    })

    if (warnings.length) {
      lines.push("Warnings:")
      const items = [...new Set(warnings)]
      items.forEach((warning) => lines.push(`  ! ${warning}`))
    }

    return {
      title: `Value flow: ${target.name}`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})
