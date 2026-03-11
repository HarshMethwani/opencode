import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { analyzeProject, findContract, findContractsByPath } from "../solidity"
import type { ContractIR } from "../solidity/ir"

type Node = {
  name: string
  file: string | null
  kind: string
  children: Node[]
}

function tree(contracts: ContractIR[], name: string, depth: number, maxDepth: number, seen: Set<string>): Node {
  const contract = contracts.find((item) => item.name === name)
  if (seen.has(name) || depth >= maxDepth) {
    return {
      name,
      file: contract?.source ?? null,
      kind: contract?.kind ?? "external",
      children: [],
    }
  }

  if (!contract) {
    return {
      name,
      file: null,
      kind: "external",
      children: [],
    }
  }

  seen.add(name)
  const children = contract.bases.map((base) => tree(contracts, base, depth + 1, maxDepth, seen))
  seen.delete(name)
  return {
    name,
    file: contract.source,
    kind: contract.kind,
    children,
  }
}

function print(node: Node, lines: string[], prefix: string, last: boolean) {
  const connector = last ? "└── " : "├── "
  const file = node.file ? ` [${node.file}]` : node.kind === "external" ? " (external)" : ""
  lines.push(`${prefix}${connector}${node.name}${file}`)
  const next = prefix + (last ? "    " : "│   ")
  node.children.forEach((child, idx) => {
    print(child, lines, next, idx === node.children.length - 1)
  })
}

function observations(contracts: ContractIR[], target: ContractIR) {
  const chain = target.linearized_bases
    .map((name) => contracts.find((item) => item.name === name))
    .filter(Boolean) as ContractIR[]
  const result = [] as string[]
  const vars = new Map<string, string>()
  chain.forEach((contract) => {
    contract.state.forEach((state) => {
      const seen = vars.get(state.name)
      if (seen) {
        result.push(`[SHADOW] ${state.name} appears in both ${seen} and ${contract.name}`)
        return
      }
      vars.set(state.name, contract.name)
    })
  })

  const fns = new Map<string, Array<{ contract: string; modifiers: string[] }>>()
  chain.forEach((contract) => {
    contract.functions.forEach((fn) => {
      const list = fns.get(fn.name) ?? []
      list.push({ contract: contract.name, modifiers: fn.modifiers })
      fns.set(fn.name, list)
    })
  })

  fns.forEach((entries, name) => {
    if (entries.length < 2 || name === "constructor") return
    result.push(`[OVERRIDE] ${name} defined in ${entries.map((item) => item.contract).join(", ")}`)
    const guarded = entries.filter((item) => item.modifiers.some((mod) => /only|owner|role|admin|auth/i.test(mod)))
    const open = entries.filter((item) => !item.modifiers.some((mod) => /only|owner|role|admin|auth/i.test(mod)))
    if (guarded.length && open.length) {
      result.push(`  ↳ access control weakens across override chain (${guarded.map((item) => item.contract).join(", ")} -> ${open.map((item) => item.contract).join(", ")})`)
    }
  })

  if (target.proxies.length && !target.storage.some((slot) => /__gap|gap/.test(slot.label))) {
    result.push("[UPGRADE] upgradeable pattern detected without storage gap")
  }

  return result
}

export const InheritanceResolverTool = Tool.define("inheritance-resolver", {
  description:
    "Resolve the full inheritance tree of a Solidity contract using compiler-backed metadata. Returns inheritance order, inherited members, storage order, and upgrade-related observations.",
  parameters: z.object({
    path: z.string().describe("Path to the Solidity contract file to resolve"),
    contract: z.string().optional().describe("Specific contract name in the file (if the file contains multiple contracts)"),
    depth: z.number().optional().describe("Max inheritance depth to resolve (default: 10)"),
  }),
  async execute(args) {
    const filepath = path.isAbsolute(args.path) ? args.path : path.resolve(Instance.directory, args.path)
    const depth = args.depth ?? 10
    const ir = await analyzeProject(path.dirname(filepath))
    const target =
      findContract(ir, { file: filepath, name: args.contract }) ??
      findContractsByPath(ir, filepath).find((contract) => contract.kind === "contract" || contract.kind === "abstract") ??
      findContractsByPath(ir, filepath)[0]

    if (!target) {
      return {
        title: "Not found",
        output: `No Solidity contracts from compiler output matched: ${args.path}`,
        metadata: {},
      }
    }

    const root = tree(ir.contracts, target.name, 0, depth, new Set())
    const lines = [
      `Inheritance Tree for: ${target.name}`,
      `Source: ${target.source}`,
      `Contracts resolved: ${target.linearized_bases.length}`,
      "",
      "=== INHERITANCE TREE ===",
    ]
    print(root, lines, "", true)
    lines.push("", "=== LINEARIZATION ORDER (MRO) ===", target.linearized_bases.join(" -> "))
    lines.push("(State variables are laid out in this order)")
    lines.push("", "=== INHERITED MEMBERS ===")

    target.linearized_bases.forEach((name) => {
      const contract = ir.contracts.find((item) => item.name === name)
      if (!contract) {
        lines.push(`\n--- ${name} (external) ---`)
        return
      }
      lines.push(`\n--- ${contract.kind.toUpperCase()}: ${contract.name} [${contract.source}] ---`)
      if (contract.state.length) {
        lines.push("  State Variables:")
        contract.state.forEach((state) => lines.push(`    ${state.type} ${state.visibility} ${state.name}`))
      }
      const external = contract.functions.filter((fn) => fn.visibility === "public" || fn.visibility === "external")
      if (external.length) {
        lines.push("  Public/External Functions:")
        external.forEach((fn) => {
          const mods = fn.modifiers.length ? ` [${fn.modifiers.join(", ")}]` : ""
          lines.push(`    ${fn.visibility} ${fn.name} ${fn.mutability}${mods}`)
        })
      }
      const internal = contract.functions.filter((fn) => fn.visibility === "internal" || fn.visibility === "private")
      if (internal.length) {
        lines.push("  Internal/Private Functions:")
        internal.forEach((fn) => {
          const mods = fn.modifiers.length ? ` [${fn.modifiers.join(", ")}]` : ""
          lines.push(`    ${fn.visibility} ${fn.name} ${fn.mutability}${mods}`)
        })
      }
      if (contract.modifiers.length) lines.push(`  Modifiers: ${contract.modifiers.map((item) => item.name).join(", ")}`)
      if (contract.events.length) lines.push(`  Events: ${contract.events.join(", ")}`)
    })

    const notes = observations(ir.contracts, target)
    lines.push("", "=== SECURITY OBSERVATIONS ===")
    if (!notes.length) lines.push("  No obvious inheritance issues detected.")
    notes.forEach((note) => lines.push(`  ${note}`))

    return {
      title: `${target.name}: ${target.linearized_bases.length} in chain`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})
