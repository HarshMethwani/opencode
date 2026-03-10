import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { detectLanguage, getParser } from "../lang"
import { Filesystem } from "../util/filesystem"

export const ContractInfoTool = Tool.define("contract-info", {
  description:
    "Parse a smart contract file and extract structured metadata: language, contract name, inheritance, function signatures, state variables, events, errors, external calls, and imports. Supports Solidity (more languages coming).",
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
        output: `Parser not yet implemented for: ${language}. Currently supported: solidity`,
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
