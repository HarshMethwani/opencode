import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { detectLanguage, getParser } from "../lang"
import { Filesystem } from "../util/filesystem"

export const ContractInfoTool = Tool.define("contract-info", {
  description:
    "Parse a smart contract file and extract structured metadata: language, contract name, inheritance, function signatures, state variables, events, errors, external calls, and imports. For Anchor programs, also extracts account constraints, signer requirements, PDA seeds, and validation status per account.",
  parameters: z.object({
    path: z.string().describe("Path to the smart contract file"),
    language: z
      .string()
      .optional()
      .describe("Override language detection: solidity, vyper, anchor, cosmwasm, move, cairo"),
  }),
  async execute(args, ctx) {
    const filepath = path.isAbsolute(args.path) ? args.path : path.resolve(Instance.directory, args.path)

    const content = await Filesystem.readText(filepath).catch(() => undefined)
    if (!content) {
      return { title: "Error", output: `File not found: ${filepath}`, metadata: {} }
    }

    const language = args.language ?? detectLanguage(filepath, content)
    if (!language) {
      return {
        title: "Unknown language",
        output: `Could not detect smart contract language for: ${filepath}. Supported: solidity, vyper, anchor, cosmwasm, move, cairo`,
        metadata: {},
      }
    }

    const parser = getParser(language)
    if (!parser) {
      return {
        title: `Unsupported: ${language}`,
        output: `Parser not yet implemented for: ${language}. Currently supported: solidity, vyper, anchor, cosmwasm, move, cairo`,
        metadata: {},
      }
    }

    const contracts = parser.extractMetadata(content)
    const calls = parser.extractCalls(content)

    if (contracts.length === 0) {
      return {
        title: "No contracts found",
        output: `No contract/interface/library declarations found in: ${filepath}`,
        metadata: {},
      }
    }

    const lines: string[] = [`File: ${args.path}`, `Language: ${language}`, `Contracts: ${contracts.length}`, ""]

    for (const c of contracts) {
      lines.push(`=== ${c.type.toUpperCase()}: ${c.name} ===`)
      if (c.inherits.length) lines.push(`Inherits: ${c.inherits.join(", ")}`)
      if (c.implements.length) lines.push(`Implements: ${c.implements.join(", ")}`)
      if (c.imports.length) lines.push(`Imports: ${c.imports.join(", ")}`)

      if (c.functions.length) {
        lines.push("", "Functions:")
        for (const f of c.functions) {
          const mods = f.modifiers.length ? ` [${f.modifiers.join(", ")}]` : ""
          const ret = f.returns ? ` -> (${f.returns})` : ""
          lines.push(`  ${f.visibility} ${f.name}(${f.parameters}) ${f.mutability}${mods}${ret}`)
        }
      }

      if (c.stateVariables.length) {
        lines.push("", "State Variables:")
        for (const v of c.stateVariables) {
          const flags = [v.constant && "constant", v.immutable && "immutable"].filter(Boolean).join(" ")
          lines.push(`  ${v.type} ${v.visibility} ${flags} ${v.name}`.replace(/\s+/g, " ").trim())
        }
      }

      // Anchor account constraints — the security-critical section
      if (c.accounts?.length) {
        lines.push("", "Account Validation:")
        for (const a of c.accounts) {
          const flags: string[] = []
          if (a.isSigner) flags.push("SIGNER")
          if (a.isMut) flags.push("MUT")
          if (a.isInit) flags.push("INIT")
          if (a.isClose) flags.push(`CLOSE(${a.isClose})`)
          if (a.accountType === "unchecked") flags.push("!! UNCHECKED !!")

          const flagStr = flags.length ? ` [${flags.join(", ")}]` : ""
          lines.push(`  ${a.name}: ${a.type}${flagStr}`)

          if (a.innerType) lines.push(`    -> Validated type: ${a.innerType}`)
          if (a.hasOne.length) lines.push(`    -> has_one: ${a.hasOne.join(", ")}`)
          if (a.seeds.length) {
            lines.push(`    -> PDA seeds: [${a.seeds.join(", ")}]`)
            lines.push(`    -> bump: ${a.hasBump ? "yes" : "NO BUMP - potential issue"}`)
          }
          if (a.constraints.length) {
            for (const c of a.constraints) lines.push(`    -> constraint: ${c}`)
          }

          // Security warnings
          if (a.accountType === "unchecked" && !a.constraints.length && !a.hasOne.length) {
            lines.push(`    !! WARNING: Unvalidated account — no type check, no constraints`)
          }
        }
      }

      // Sui Move object analysis — the security-critical section
      if (c.suiObjects?.length) {
        lines.push("", "Object Analysis:")
        for (const obj of c.suiObjects) {
          const abStr = obj.abilities.length ? `has ${obj.abilities.join(", ")}` : "(no abilities — HOT POTATO)"
          lines.push(`  ${obj.name}: ${abStr}`)

          if (obj.fields.length) {
            lines.push(`    Fields: ${obj.fields.map((f) => `${f.name}: ${f.type}`).join(", ")}`)
          }

          // Security warnings for ability combinations
          if (obj.hasCopy && (obj.name.includes("Coin") || obj.name.includes("Token") || obj.name.includes("Balance"))) {
            lines.push(`    !! CRITICAL: Asset type "${obj.name}" has \`copy\` — enables infinite duplication`)
          }
          if (obj.hasDrop && (obj.name.includes("Coin") || obj.name.includes("Token") || obj.name.includes("Balance"))) {
            lines.push(`    !! CRITICAL: Asset type "${obj.name}" has \`drop\` — enables silent destruction`)
          }
          if (obj.hasDrop && (obj.name.includes("Receipt") || obj.name.includes("Loan") || obj.name.includes("Proof"))) {
            lines.push(`    !! WARNING: Receipt/proof type "${obj.name}" has \`drop\` — hot potato pattern BROKEN, repayment not enforced`)
          }
          if (obj.hasStore && (obj.name.includes("Cap") || obj.name.includes("Admin") || obj.name.includes("Authority"))) {
            lines.push(`    !! WARNING: Capability "${obj.name}" has \`store\` — can be transferred by anyone via public_transfer`)
          }
          if (obj.hasKey && !obj.hasStore) {
            lines.push(`    -> Transfer restricted to defining module (key only, no store)`)
          }
          if (obj.hasKey && obj.hasStore) {
            lines.push(`    -> Freely transferable by anyone (key + store)`)
          }
          if (!obj.hasKey && !obj.hasStore && !obj.hasCopy && !obj.hasDrop && obj.abilities.length === 0) {
            lines.push(`    -> HOT POTATO: Must be consumed in same transaction, cannot be stored/dropped ✓`)
          }
        }
      }

      // Sui module-level info
      if (c.suiModule) {
        const sm = c.suiModule
        lines.push("", "Module Info:")
        lines.push(`  Init: ${sm.hasInit ? "yes" : "NO — no init function found"}`)
        lines.push(`  OTW: ${sm.hasOTW ? `yes (${sm.otwType})` : "no"}`)

        if (sm.capabilities.length) {
          lines.push(`  Capabilities: ${sm.capabilities.join(", ")}`)
        }
        if (sm.sharedObjects.length) {
          lines.push(`  Shared Objects: ${sm.sharedObjects.join(", ")}`)
        }
        if (sm.entryFunctions.length) {
          lines.push(`  Entry Functions: ${sm.entryFunctions.join(", ")}`)
        }
        if (sm.dynamicFieldOps.length) {
          lines.push(`  Dynamic Field Ops: ${sm.dynamicFieldOps.join(", ")}`)
        }

        // Module-level security warnings
        if (sm.capabilities.length > 0 && !sm.hasInit) {
          lines.push(`  !! WARNING: Module defines capabilities but has no init function — how are they created?`)
        }
        if (sm.capabilities.includes("TreasuryCap") && !sm.hasOTW) {
          lines.push(`  !! WARNING: Uses TreasuryCap but no OTW pattern detected — coin may not be properly initialized`)
        }
      }

      if (c.events.length) lines.push("", `Events: ${c.events.join(", ")}`)
      if (c.errors.length) lines.push("", `Errors: ${c.errors.join(", ")}`)
      if (c.modifiers.length) lines.push("", `Modifiers: ${c.modifiers.join(", ")}`)
      lines.push("")
    }

    if (calls.length) {
      lines.push("External Calls:")
      for (const call of calls) {
        const tag = call.isDelegatecall ? " [DELEGATECALL]" : call.isStaticcall ? " [STATICCALL]" : ""
        lines.push(`  L${call.line}: ${call.target}.${call.method}() in ${call.callingFunction}${tag}`)
      }
    }

    return {
      title: `${contracts.length} contract(s) in ${path.basename(filepath)}`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})
