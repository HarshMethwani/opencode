import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { detectLanguage, getParser } from "../lang"
import { Filesystem } from "../util/filesystem"
import { Glob } from "../util/glob"

export const CallGraphTool = Tool.define("call-graph", {
  description:
    "Build a call graph starting from a function, following internal calls, external calls to other contracts, delegatecall/staticcall patterns, and callback patterns (reentrancy surface). Output is a text tree showing the call hierarchy.",
  parameters: z.object({
    entryPoint: z
      .string()
      .describe("Entry point in format 'ContractName.functionName' or just 'functionName' to search all contracts"),
    depth: z.number().optional().describe("Maximum depth to trace (default: 5)"),
    directory: z.string().optional().describe("Directory to search for contracts (default: project root)"),
  }),
  async execute(args, ctx) {
    const maxDepth = args.depth ?? 5
    const searchDir = args.directory
      ? path.isAbsolute(args.directory)
        ? args.directory
        : path.resolve(Instance.directory, args.directory)
      : Instance.directory

    // Find all Solidity files
    const files = Glob.scanSync("**/*.sol", {
      cwd: searchDir,
      absolute: true,
      dot: false,
      symlink: false,
    }).filter((f) => !f.includes("node_modules") && !f.includes("/lib/"))

    if (files.length === 0) {
      return { title: "No contracts", output: `No .sol files found in: ${searchDir}`, metadata: {} }
    }

    // Build a map of all contracts and their functions/calls
    const contractMap = new Map<
      string,
      {
        filepath: string
        functions: Set<string>
        calls: Array<{ from: string; target: string; method: string; isDelegatecall: boolean }>
      }
    >()

    for (const filepath of files) {
      const content = await Filesystem.readText(filepath).catch(() => undefined)
      if (!content) continue

      const language = detectLanguage(filepath, content)
      if (!language) continue

      const parser = getParser(language)
      if (!parser) continue

      const metadata = parser.extractMetadata(content)
      const calls = parser.extractCalls(content)

      for (const contract of metadata) {
        const entry = {
          filepath,
          functions: new Set(contract.functions.map((f) => f.name)),
          calls: calls.map((c) => ({
            from: c.callingFunction,
            target: c.target,
            method: c.method,
            isDelegatecall: c.isDelegatecall,
          })),
        }
        contractMap.set(contract.name, entry)
      }
    }

    // Parse entry point
    const parts = args.entryPoint.split(".")
    let targetContract: string | undefined
    let targetFunction: string

    if (parts.length === 2) {
      targetContract = parts[0]!
      targetFunction = parts[1]!
    } else {
      targetFunction = parts[0]!
      // Search all contracts for this function
      for (const [name, info] of contractMap) {
        if (info.functions.has(targetFunction)) {
          targetContract = name
          break
        }
      }
    }

    if (!targetContract) {
      return {
        title: "Function not found",
        output: `Could not find function '${targetFunction}' in any contract. Available contracts: ${Array.from(contractMap.keys()).join(", ")}`,
        metadata: {},
      }
    }

    // Build call tree
    const visited = new Set<string>()
    const tree = buildCallTree(contractMap, targetContract, targetFunction, 0, maxDepth, visited)

    const lines: string[] = [
      `Call Graph: ${targetContract}.${targetFunction}()`,
      `Depth: ${maxDepth}`,
      `Contracts analyzed: ${contractMap.size}`,
      "",
      ...tree,
    ]

    // Identify reentrancy surface
    const reentrancySurface = findReentrancySurface(contractMap, targetContract, targetFunction)
    if (reentrancySurface.length) {
      lines.push("", "Reentrancy Surface (external calls that could callback):")
      for (const entry of reentrancySurface) {
        lines.push(`  ${entry}`)
      }
    }

    return {
      title: `Call graph: ${targetContract}.${targetFunction}`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})

function buildCallTree(
  contractMap: Map<string, { functions: Set<string>; calls: Array<{ from: string; target: string; method: string; isDelegatecall: boolean }> }>,
  contractName: string,
  functionName: string,
  depth: number,
  maxDepth: number,
  visited: Set<string>,
): string[] {
  const key = `${contractName}.${functionName}`
  const indent = "  ".repeat(depth)
  const lines: string[] = []

  if (visited.has(key)) {
    lines.push(`${indent}-> ${key}() [RECURSIVE]`)
    return lines
  }

  if (depth >= maxDepth) {
    lines.push(`${indent}-> ${key}() [MAX DEPTH]`)
    return lines
  }

  visited.add(key)
  const contract = contractMap.get(contractName)

  lines.push(`${indent}${depth === 0 ? "" : "-> "}${key}()`)

  if (!contract) {
    lines.push(`${indent}  [external contract - not in project]`)
    return lines
  }

  // Find all calls from this function
  const calls = contract.calls.filter((c) => c.from === functionName)
  for (const call of calls) {
    const tag = call.isDelegatecall ? " [DELEGATECALL]" : ""

    // Check if target is a known contract
    if (contractMap.has(call.target)) {
      lines.push(...buildCallTree(contractMap, call.target, call.method, depth + 1, maxDepth, visited))
    } else {
      lines.push(`${indent}  -> ${call.target}.${call.method}()${tag} [external]`)
    }
  }

  visited.delete(key)
  return lines
}

function findReentrancySurface(
  contractMap: Map<string, { calls: Array<{ from: string; target: string; method: string; isDelegatecall: boolean }> }>,
  contractName: string,
  functionName: string,
): string[] {
  const surface: string[] = []
  const contract = contractMap.get(contractName)
  if (!contract) return surface

  const calls = contract.calls.filter((c) => c.from === functionName)
  for (const call of calls) {
    // External calls (not in our project) are reentrancy surface
    if (!contractMap.has(call.target)) {
      surface.push(`${call.target}.${call.method}() — could callback into ${contractName}`)
    }
    // Low-level calls are always reentrancy surface
    if (["call", "delegatecall", "staticcall"].includes(call.method)) {
      surface.push(`${call.target}.${call.method}() — low-level call, full reentrancy surface`)
    }
  }

  return surface
}
