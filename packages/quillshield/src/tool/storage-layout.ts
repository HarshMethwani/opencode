import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { detectLanguage, getParser } from "../lang"
import { Filesystem } from "../util/filesystem"

// Solidity type sizes in bytes
const TYPE_SIZES: Record<string, number> = {
  bool: 1,
  address: 20,
  uint8: 1,
  uint16: 2,
  uint32: 4,
  uint64: 8,
  uint128: 16,
  uint256: 32,
  int8: 1,
  int16: 2,
  int32: 4,
  int64: 8,
  int128: 16,
  int256: 32,
  bytes1: 1,
  bytes2: 2,
  bytes4: 4,
  bytes8: 8,
  bytes16: 16,
  bytes32: 32,
}

function getTypeSize(type: string): number {
  if (type in TYPE_SIZES) return TYPE_SIZES[type]!
  if (type === "uint" || type === "int") return 32
  if (type.startsWith("mapping")) return 32 // mapping takes one slot (base)
  if (type.includes("[]")) return 32 // dynamic array takes one slot (length)
  if (type === "string" || type === "bytes") return 32 // dynamic, one slot for length/pointer
  if (type.startsWith("address")) return 20
  if (type.startsWith("enum")) return 1
  // Fixed-size arrays: type[N]
  const fixedMatch = type.match(/(\w+)\[(\d+)\]/)
  if (fixedMatch) {
    const elementSize = getTypeSize(fixedMatch[1]!)
    const count = parseInt(fixedMatch[2]!)
    return Math.ceil((elementSize * count) / 32) * 32
  }
  // Structs and unknown types — assume 32 bytes
  return 32
}

export const StorageLayoutTool = Tool.define("storage-layout", {
  description:
    "Analyze the storage variable layout of a Solidity contract. Shows slot assignments (order-dependent), detects potential proxy storage collisions, and identifies mapping/array storage patterns. EVM-specific.",
  parameters: z.object({
    path: z.string().describe("Path to the Solidity contract file"),
    proxy_implementation: z
      .string()
      .optional()
      .describe("Path to implementation contract (for proxy collision detection)"),
  }),
  async execute(args, ctx) {
    const filepath = path.isAbsolute(args.path) ? args.path : path.resolve(Instance.directory, args.path)

    const content = await Filesystem.readText(filepath).catch(() => undefined)
    if (!content) {
      return { title: "Error", output: `File not found: ${filepath}`, metadata: {} }
    }

    const language = detectLanguage(filepath, content)
    if (language !== "solidity") {
      return {
        title: "EVM only",
        output: "Storage layout analysis is only available for Solidity contracts (EVM storage model).",
        metadata: {},
      }
    }

    const parser = getParser("solidity")!
    const contracts = parser.extractMetadata(content)
    const storageVars = parser.extractStorage(content)

    const lines: string[] = [`Storage Layout: ${path.basename(filepath)}`, ""]

    // Build detailed layout
    let currentSlot = 0
    let slotOffset = 0

    lines.push("Slot | Offset | Type                    | Name")
    lines.push("-----|--------|-------------------------|-----")

    for (const v of storageVars) {
      const size = getTypeSize(v.type)
      const displayType = v.type.length > 24 ? v.type.slice(0, 21) + "..." : v.type.padEnd(24)

      if (size >= 32 || slotOffset + size > 32) {
        if (slotOffset > 0) currentSlot++
        slotOffset = 0
      }

      lines.push(
        `${String(currentSlot).padStart(4)} | ${String(slotOffset).padStart(6)} | ${displayType} | ${v.name}`,
      )

      if (v.type.startsWith("mapping")) {
        lines.push(`     |        | -> values at keccak256(key, ${currentSlot})`)
      } else if (v.type.includes("[]")) {
        lines.push(`     |        | -> elements at keccak256(${currentSlot}), length at slot ${currentSlot}`)
      }

      if (size < 32) {
        slotOffset += size
        if (slotOffset >= 32) {
          currentSlot++
          slotOffset = 0
        }
      } else {
        currentSlot += Math.ceil(size / 32)
      }
    }

    const totalSlots = slotOffset > 0 ? currentSlot + 1 : currentSlot
    lines.push("", `Total storage slots used: ${totalSlots}`)

    // Proxy collision detection
    if (args.proxy_implementation) {
      const implPath = path.isAbsolute(args.proxy_implementation)
        ? args.proxy_implementation
        : path.resolve(Instance.directory, args.proxy_implementation)

      const implContent = await Filesystem.readText(implPath).catch(() => undefined)
      if (implContent) {
        const implStorage = parser.extractStorage(implContent)
        lines.push("", "Proxy Storage Collision Analysis:")

        const maxCheck = Math.min(storageVars.length, implStorage.length)
        let collisions = 0
        for (let i = 0; i < maxCheck; i++) {
          const proxyVar = storageVars[i]!
          const implVar = implStorage[i]!
          if (proxyVar.type !== implVar.type || proxyVar.name !== implVar.name) {
            collisions++
            lines.push(
              `  COLLISION at slot ${i}: proxy has '${proxyVar.type} ${proxyVar.name}', impl has '${implVar.type} ${implVar.name}'`,
            )
          }
        }
        if (collisions === 0) lines.push("  No storage collisions detected.")
      }
    }

    // Known dangerous patterns
    const warnings: string[] = []
    for (const contract of contracts) {
      if (contract.inherits.some((i) => i.includes("Upgradeable") || i.includes("Proxy"))) {
        const hasGap = storageVars.some((v) => v.name.includes("gap") || v.name.includes("__gap"))
        if (!hasGap) {
          warnings.push("Upgradeable contract without storage gap — risk of slot collision on upgrade")
        }
      }
    }

    if (warnings.length) {
      lines.push("", "Warnings:")
      for (const w of warnings) lines.push(`  ! ${w}`)
    }

    return {
      title: `Storage: ${totalSlots} slots`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})
