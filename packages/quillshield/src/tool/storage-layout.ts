import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { detectLanguage, getParser } from "../lang"
import { Filesystem } from "../util/filesystem"

export const StorageLayoutTool = Tool.define("storage-layout", {
  description:
    "Analyze the storage variable layout of a Solidity contract. Shows slot assignments with correct EVM packing, detects potential proxy storage collisions, and identifies mapping/array storage patterns. EVM-specific.",
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

    lines.push("Slot | Offset | Size | Type                    | Name")
    lines.push("-----|--------|------|-------------------------|-----")

    for (const v of storageVars) {
      const displayType = v.type.length > 24 ? v.type.slice(0, 21) + "..." : v.type.padEnd(24)
      const offset = v.offset ?? 0
      const size = v.size ?? 32

      lines.push(
        `${String(v.slot).padStart(4)} | ${String(offset).padStart(6)} | ${String(size).padStart(4)} | ${displayType} | ${v.name}`,
      )

      if (v.type.startsWith("mapping")) {
        lines.push(`     |        |      | -> values at keccak256(key, ${v.slot})`)
      } else if (v.type.includes("[]")) {
        lines.push(`     |        |      | -> elements at keccak256(${v.slot}), length at slot ${v.slot}`)
      }
    }

    const lastVar = storageVars[storageVars.length - 1]
    const totalSlots = lastVar ? (typeof lastVar.slot === "number" ? lastVar.slot + 1 : 0) : 0
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
          if (proxyVar.slot === implVar.slot && (proxyVar.type !== implVar.type || proxyVar.name !== implVar.name)) {
            collisions++
            lines.push(
              `  COLLISION at slot ${proxyVar.slot}: proxy has '${proxyVar.type} ${proxyVar.name}', impl has '${implVar.type} ${implVar.name}'`,
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
