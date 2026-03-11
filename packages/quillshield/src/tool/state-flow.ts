import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { analyzeProject, findContract, findContractsByPath } from "../solidity"

export const StateFlowTool = Tool.define("state-flow", {
  description:
    "Trace ordered Solidity state reads, writes, and external calls from compiler-backed facts. Highlights reentrancy windows and effects-after-interaction patterns.",
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
    const lines = [`State Flow: ${target.name}`, ""]

    functions.forEach((fn) => {
      lines.push(`=== ${fn.signature} ===`)
      if (!fn.operations.length) {
        lines.push("  no tracked state or call operations", "")
        return
      }
      fn.operations.forEach((op, idx) => {
        const extra =
          op.kind === "call"
            ? ` -> ${(op.target_contract ?? op.target ?? "unknown")}.${op.name} [${op.call_kind}]`
            : op.kind === "value"
              ? ` -> ${op.action}/${op.asset}`
              : ""
        lines.push(`  ${idx + 1}. L${op.line ?? "?"} ${op.kind} ${op.name}${extra}`)
      })

      const firstCall = fn.operations.findIndex((op) => op.kind === "call" && op.call_kind !== "internal")
      const writeAfterCall =
        firstCall >= 0 &&
        fn.operations.slice(firstCall + 1).some((op) => op.kind === "write")
      const callBeforeWrite =
        firstCall >= 0 &&
        fn.operations.slice(0, firstCall).every((op) => op.kind !== "write") &&
        fn.operations.slice(firstCall + 1).some((op) => op.kind === "write")

      if (callBeforeWrite) {
        lines.push("  ! external control transfer happens before a state write")
      }
      if (writeAfterCall) {
        lines.push("  ! state is still mutating after an external call/delegatecall")
      }
      if (fn.operations.some((op) => op.call_kind === "delegatecall")) {
        lines.push("  ! delegatecall present — storage context stays in caller")
      }
      lines.push("")
    })

    return {
      title: `State flow: ${target.name}`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})
