import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Glob } from "../util/glob"
import { SolidityParser } from "../lang/solidity"

interface ResolvedContract {
  name: string
  file: string
  type: string
  inherits: string[]
  functions: { name: string; visibility: string; mutability: string; modifiers: string[] }[]
  stateVariables: { name: string; type: string; visibility: string }[]
  modifiers: string[]
  events: string[]
  errors: string[]
}

interface InheritanceNode {
  name: string
  file: string | null
  type: string
  children: InheritanceNode[]
  linearization: string[]
}

export const InheritanceResolverTool = Tool.define("inheritance-resolver", {
  description:
    "Resolve the full inheritance tree of a Solidity contract. Finds all parent contracts in the project, reads them, and returns the complete inheritance chain with functions, state variables, and modifiers from every ancestor. Essential for finding bugs that hide in parent contracts — storage ordering, overridden functions, missing super calls, access control inherited from base classes.",
  parameters: z.object({
    path: z.string().describe("Path to the Solidity contract file to resolve"),
    contract: z
      .string()
      .optional()
      .describe("Specific contract name in the file (if the file contains multiple contracts)"),
    depth: z.number().optional().describe("Max inheritance depth to resolve (default: 10)"),
  }),
  async execute(args) {
    const filepath = path.isAbsolute(args.path) ? args.path : path.resolve(Instance.directory, args.path)
    const maxDepth = args.depth ?? 10

    const content = await Filesystem.readText(filepath).catch(() => undefined)
    if (!content) return { title: "Error", output: `File not found: ${filepath}`, metadata: {} }

    if (!SolidityParser.detect(content))
      return { title: "Error", output: `Not a Solidity file: ${filepath}`, metadata: {} }

    // Build an index of all Solidity contracts in the project
    const solFiles = Glob.scanSync("**/*.sol", {
      cwd: Instance.directory,
      absolute: true,
    }).filter((f) => !f.includes("/node_modules/") && !f.includes("/cache/") && !f.includes("/artifacts/"))

    const contractIndex = new Map<string, { file: string; content: string }>()
    const fileCache = new Map<string, string>()

    for (const f of solFiles) {
      const src = await Filesystem.readText(f).catch(() => "")
      if (!src) continue
      fileCache.set(f, src)

      // Find all contract/interface/library declarations
      const pattern = /^\s*(abstract\s+)?(contract|interface|library)\s+(\w+)/gm
      let m
      while ((m = pattern.exec(src)) !== null) {
        const name = m[3]!
        // Prefer first occurrence (closer to src root), don't overwrite
        if (!contractIndex.has(name)) {
          contractIndex.set(name, { file: f, content: src })
        }
      }
    }

    // Parse the target file
    const contracts = SolidityParser.extractMetadata(content)
    if (contracts.length === 0)
      return { title: "No contracts", output: `No contract declarations found in ${filepath}`, metadata: {} }

    const target = args.contract
      ? contracts.find((c) => c.name === args.contract)
      : contracts.find((c) => c.type === "contract" || c.type === "abstract") ?? contracts[0]

    if (!target) {
      const names = contracts.map((c) => c.name).join(", ")
      return {
        title: "Not found",
        output: `Contract "${args.contract}" not found in file. Available: ${names}`,
        metadata: {},
      }
    }

    // Resolve the full inheritance tree recursively
    const resolved = new Map<string, ResolvedContract>()
    const missingContracts: string[] = []

    function resolveContract(name: string, depth: number): InheritanceNode {
      if (depth > maxDepth) return { name, file: null, type: "max-depth", children: [], linearization: [name] }

      // Check if already resolved
      const existing = resolved.get(name)
      if (existing)
        return {
          name,
          file: existing.file,
          type: existing.type,
          children: existing.inherits.map((p) => resolveContract(p, depth + 1)),
          linearization: [name],
        }

      // Look up in index
      const entry = contractIndex.get(name)
      if (!entry) {
        missingContracts.push(name)
        return { name, file: null, type: "not-found", children: [], linearization: [name] }
      }

      const metadata = SolidityParser.extractMetadata(entry.content)
      const contract = metadata.find((c) => c.name === name)
      if (!contract) {
        missingContracts.push(name)
        return { name, file: null, type: "not-found", children: [], linearization: [name] }
      }

      const relFile = path.relative(Instance.directory, entry.file)

      resolved.set(name, {
        name,
        file: relFile,
        type: contract.type,
        inherits: contract.inherits,
        functions: contract.functions.map((f) => ({
          name: f.name,
          visibility: f.visibility,
          mutability: f.mutability,
          modifiers: f.modifiers,
        })),
        stateVariables: contract.stateVariables.map((v) => ({
          name: v.name,
          type: v.type,
          visibility: v.visibility,
        })),
        modifiers: contract.modifiers,
        events: contract.events,
        errors: contract.errors,
      })

      const children = contract.inherits.map((p) => resolveContract(p, depth + 1))

      return { name, file: relFile, type: contract.type, children, linearization: [name] }
    }

    // Start resolution from the target contract
    const tree = resolveContract(target.name, 0)

    // C3 linearization (simplified — MRO order)
    const linearized = computeLinearization(target.name, resolved)

    // Build output
    const lines: string[] = []

    // Header
    lines.push(`Inheritance Tree for: ${target.name}`)
    lines.push(`Source: ${path.relative(Instance.directory, filepath)}`)
    lines.push(`Contracts resolved: ${resolved.size}`)
    if (missingContracts.length) {
      const unique = [...new Set(missingContracts)]
      lines.push(`Not found (likely OpenZeppelin/external): ${unique.join(", ")}`)
    }
    lines.push("")

    // Tree visualization
    lines.push("=== INHERITANCE TREE ===")
    printTree(tree, lines, "", true)
    lines.push("")

    // Linearization order (MRO)
    lines.push("=== LINEARIZATION ORDER (MRO) ===")
    lines.push(`${linearized.join(" → ")}`)
    lines.push("(State variables are laid out in this order — first in chain gets lowest storage slots)")
    lines.push("")

    // Per-contract details in linearization order
    lines.push("=== INHERITED MEMBERS ===")
    for (const name of linearized) {
      const contract = resolved.get(name)
      if (!contract) {
        lines.push(`\n--- ${name} (external/not found) ---`)
        continue
      }

      lines.push(`\n--- ${contract.type.toUpperCase()}: ${name} [${contract.file}] ---`)

      if (contract.stateVariables.length) {
        lines.push("  State Variables:")
        for (const v of contract.stateVariables) {
          lines.push(`    ${v.type} ${v.visibility} ${v.name}`)
        }
      }

      const externalFns = contract.functions.filter(
        (f) => f.visibility === "public" || f.visibility === "external",
      )
      const internalFns = contract.functions.filter(
        (f) => f.visibility === "internal" || f.visibility === "private",
      )

      if (externalFns.length) {
        lines.push("  Public/External Functions:")
        for (const f of externalFns) {
          const mods = f.modifiers.length ? ` [${f.modifiers.join(", ")}]` : ""
          lines.push(`    ${f.visibility} ${f.name} ${f.mutability}${mods}`)
        }
      }

      if (internalFns.length) {
        lines.push("  Internal/Private Functions:")
        for (const f of internalFns) {
          const mods = f.modifiers.length ? ` [${f.modifiers.join(", ")}]` : ""
          lines.push(`    ${f.visibility} ${f.name} ${f.mutability}${mods}`)
        }
      }

      if (contract.modifiers.length) {
        lines.push(`  Modifiers: ${contract.modifiers.join(", ")}`)
      }

      if (contract.events.length) {
        lines.push(`  Events: ${contract.events.join(", ")}`)
      }
    }

    // Security analysis
    lines.push("")
    lines.push("=== SECURITY OBSERVATIONS ===")
    const observations = analyzeInheritance(target.name, resolved, linearized, missingContracts)
    if (observations.length === 0) {
      lines.push("  No obvious inheritance issues detected.")
    }
    for (const obs of observations) {
      lines.push(`  ${obs}`)
    }

    return {
      title: `${target.name}: ${resolved.size} contracts, ${linearized.length} in chain`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})

function printTree(node: InheritanceNode, lines: string[], prefix: string, isLast: boolean) {
  const connector = isLast ? "└── " : "├── "
  const fileInfo = node.file ? ` [${node.file}]` : node.type === "not-found" ? " (external)" : ""
  lines.push(`${prefix}${connector}${node.name}${fileInfo}`)

  const childPrefix = prefix + (isLast ? "    " : "│   ")
  for (let i = 0; i < node.children.length; i++) {
    printTree(node.children[i]!, lines, childPrefix, i === node.children.length - 1)
  }
}

function computeLinearization(rootName: string, resolved: Map<string, ResolvedContract>): string[] {
  const visited = new Set<string>()
  const order: string[] = []

  function visit(name: string) {
    if (visited.has(name)) return
    visited.add(name)

    const contract = resolved.get(name)
    if (!contract) {
      order.push(name)
      return
    }

    // Visit parents in reverse order (C3 linearization: rightmost parent first)
    for (let i = contract.inherits.length - 1; i >= 0; i--) {
      visit(contract.inherits[i]!)
    }

    order.push(name)
  }

  visit(rootName)

  // Reverse so the root is last (matching Solidity's C3 linearization where most-derived is first)
  return order.reverse()
}

function analyzeInheritance(
  rootName: string,
  resolved: Map<string, ResolvedContract>,
  linearized: string[],
  missing: string[],
): string[] {
  const observations: string[] = []
  const allStateVars: { name: string; type: string; contract: string }[] = []
  const allFunctions = new Map<string, { contract: string; visibility: string; modifiers: string[] }[]>()
  const allModifiers = new Map<string, string[]>()

  for (const name of linearized) {
    const contract = resolved.get(name)
    if (!contract) continue

    for (const v of contract.stateVariables) {
      allStateVars.push({ name: v.name, type: v.type, contract: name })
    }

    for (const f of contract.functions) {
      const existing = allFunctions.get(f.name) ?? []
      existing.push({ contract: name, visibility: f.visibility, modifiers: f.modifiers })
      allFunctions.set(f.name, existing)
    }

    for (const m of contract.modifiers) {
      const existing = allModifiers.get(m) ?? []
      existing.push(name)
      allModifiers.set(m, existing)
    }
  }

  // Check for shadowed state variables
  const varNames = new Map<string, string>()
  for (const v of allStateVars) {
    if (varNames.has(v.name)) {
      observations.push(
        `[SHADOW] State variable "${v.name}" defined in both ${varNames.get(v.name)} and ${v.contract} — storage collision risk in upgradeable contracts`,
      )
    }
    varNames.set(v.name, v.contract)
  }

  // Check for overridden functions (same name in multiple contracts)
  for (const [fname, impls] of allFunctions) {
    if (impls.length > 1 && fname !== "constructor") {
      const contracts = impls.map((i) => i.contract).join(", ")
      observations.push(`[OVERRIDE] Function "${fname}" defined in: ${contracts} — check super call chain`)

      // Check if any override drops access control modifiers
      const withModifiers = impls.filter((i) => i.modifiers.length > 0)
      const withoutModifiers = impls.filter((i) => i.modifiers.length === 0)
      if (withModifiers.length > 0 && withoutModifiers.length > 0) {
        observations.push(
          `  ↳ [ACCESS CONTROL] "${fname}" has modifiers in ${withModifiers.map((i) => i.contract).join(", ")} but NOT in ${withoutModifiers.map((i) => i.contract).join(", ")}`,
        )
      }
    }
  }

  // Check for diamond inheritance (same parent appearing through multiple paths)
  const parentCount = new Map<string, number>()
  function countParents(name: string) {
    const contract = resolved.get(name)
    if (!contract) return
    for (const p of contract.inherits) {
      parentCount.set(p, (parentCount.get(p) ?? 0) + 1)
      countParents(p)
    }
  }
  countParents(rootName)
  for (const [name, count] of parentCount) {
    if (count > 1) {
      observations.push(
        `[DIAMOND] "${name}" is inherited through ${count} paths — verify C3 linearization is correct`,
      )
    }
  }

  // Check for storage gaps (upgradeable pattern)
  const hasGap = allStateVars.some((v) => v.name.startsWith("__gap") || v.name === "_gap")
  const hasUpgradeable = linearized.some(
    (n) => n.includes("Upgradeable") || n.includes("Initializable") || n.includes("Proxy"),
  )
  const missingUpgradeable = missing.some(
    (n) => n.includes("Upgradeable") || n.includes("Initializable") || n.includes("Proxy"),
  )
  if ((hasUpgradeable || missingUpgradeable) && !hasGap) {
    observations.push(
      `[UPGRADE] Contract uses upgradeable pattern but no __gap found in resolved contracts — storage collision risk on upgrade`,
    )
  }

  // State variable count for storage layout awareness
  if (allStateVars.length > 0) {
    observations.push(
      `[STORAGE] Total state variables across chain: ${allStateVars.length} (in ${[...new Set(allStateVars.map((v) => v.contract))].length} contracts)`,
    )
  }

  return observations
}
