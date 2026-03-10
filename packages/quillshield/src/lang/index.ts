import type { LanguageParser } from "./types"
import { SolidityParser } from "./solidity"
import { VyperParser } from "./vyper"
import { AnchorParser } from "./rust-anchor"
import { CosmWasmParser } from "./rust-cosmwasm"
import { MoveParser } from "./move"
import { CairoParser } from "./cairo"

const parsers: Record<string, LanguageParser> = {
  solidity: SolidityParser,
  vyper: VyperParser,
  anchor: AnchorParser,
  cosmwasm: CosmWasmParser,
  move: MoveParser,
  "sui-move": MoveParser,
  cairo: CairoParser,
}

export function detectLanguage(filepath: string, content: string): string | undefined {
  const ext = filepath.split(".").pop()?.toLowerCase()

  // Extension-based detection
  if (ext === "sol") return "solidity"
  if (ext === "vy") return "vyper"
  if (ext === "move") {
    if (content.includes("use sui::") || content.includes("sui::object") || content.includes("sui::transfer"))
      return "sui-move"
    return "move"
  }
  if (ext === "cairo") return "cairo"

  // Content-based detection for .rs files
  if (ext === "rs") {
    if (AnchorParser.detect(content)) return "anchor"
    if (CosmWasmParser.detect(content)) return "cosmwasm"
    return "rust"
  }

  // Content-based fallback
  for (const [name, parser] of Object.entries(parsers)) {
    if (parser.detect(content)) return name
  }

  return undefined
}

export function getParser(language: string): LanguageParser | undefined {
  return parsers[language]
}

export { SolidityParser } from "./solidity"
export { VyperParser } from "./vyper"
export { AnchorParser } from "./rust-anchor"
export { CosmWasmParser } from "./rust-cosmwasm"
export { MoveParser } from "./move"
export { CairoParser } from "./cairo"
export type { ContractMetadata, ExternalCall, StorageVar, FunctionInfo, StateVariable, AccountField, SuiObjectInfo, SuiModuleInfo, LanguageParser } from "./types"
