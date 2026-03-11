import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { analyzeProject, findContract, findContractsByPath } from "../solidity"

export const StorageLayoutTool = Tool.define("storage-layout", {
  description:
    "Analyze the storage variable layout of a Solidity contract using compiler storage metadata. Shows slot assignments, upgrade gaps, and proxy collision risks.",
  parameters: z.object({
    path: z.string().describe("Path to the Solidity contract file"),
    contract: z.string().optional().describe("Specific contract name in the file"),
    proxy_implementation: z.string().optional().describe("Path to implementation contract (for proxy collision detection)"),
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

    const lines = [`Storage Layout: ${target.name}`, "", "Slot | Offset | Bytes | Type                    | Name", "-----|--------|-------|-------------------------|-----"]

    target.storage.forEach((slot) => {
      const type = slot.type.length > 24 ? `${slot.type.slice(0, 21)}...` : slot.type.padEnd(24)
      lines.push(`${slot.slot.padStart(4)} | ${String(slot.offset).padStart(6)} | ${String(slot.bytes ?? 32).padStart(5)} | ${type} | ${slot.label}`)
    })

    lines.push("", `Total storage entries: ${target.storage.length}`)

    if (target.proxies.length) {
      lines.push("", "Upgrade Signals:")
      target.proxies.forEach((item) => lines.push(`  ${item.note}`))
    }

    if (args.proxy_implementation) {
      const implPath = path.isAbsolute(args.proxy_implementation)
        ? args.proxy_implementation
        : path.resolve(Instance.directory, args.proxy_implementation)
      const implementation = findContractsByPath(ir, implPath)[0]
      if (!implementation) {
        lines.push("", `Implementation not found in compiler output: ${args.proxy_implementation}`)
      } else {
        const collisions = target.storage.flatMap((slot, idx) => {
          const other = implementation.storage[idx]
          if (!other) return []
          if (slot.slot === other.slot && (slot.type !== other.type || slot.label !== other.label)) {
            return [`  slot ${slot.slot}: proxy has '${slot.type} ${slot.label}', implementation has '${other.type} ${other.label}'`]
          }
          return []
        })
        lines.push("", "Proxy Storage Collision Analysis:")
        if (!collisions.length) lines.push("  No storage collisions detected.")
        collisions.forEach((entry) => lines.push(entry))
      }
    }

    if (target.proxies.length && !target.storage.some((slot) => /__gap|gap/.test(slot.label))) {
      lines.push("", "Warnings:", "  ! Upgradeable contract without storage gap — future upgrades can collide with existing slots")
    }

    return {
      title: `Storage: ${target.storage.length} entries`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})
