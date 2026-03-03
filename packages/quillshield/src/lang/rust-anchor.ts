import type { ContractMetadata, ExternalCall, FunctionInfo, LanguageParser, StateVariable, StorageVar } from "./types"

export const AnchorParser: LanguageParser = {
  detect(content: string): boolean {
    return content.includes("#[program]") || content.includes("declare_id!") || content.includes("use anchor_lang")
  },

  extractMetadata(content: string): ContractMetadata[] {
    const contracts: ContractMetadata[] = []
    const lines = content.split("\n")
    const imports: string[] = []

    // Extract use statements
    for (const line of lines) {
      if (/^\s*use\s/.test(line)) imports.push(line.trim().replace(/;$/, ""))
    }

    // Find #[program] module
    const programMatch = content.match(/#\[program\]\s*(?:pub\s+)?mod\s+(\w+)/)
    if (programMatch) {
      const programName = programMatch[1]!
      const functions = extractProgramFunctions(content)

      contracts.push({
        language: "anchor",
        name: programName,
        type: "program",
        inherits: [],
        implements: [],
        functions,
        stateVariables: [],
        events: extractEvents(content),
        errors: extractErrors(content),
        imports,
        modifiers: [],
      })
    }

    // Find account structs
    const accountPattern = /#\[account\]\s*(?:#\[.*\]\s*)*pub\s+struct\s+(\w+)/g
    let match
    while ((match = accountPattern.exec(content)) !== null) {
      const name = match[1]!
      const fields = extractStructFields(content, match.index! + match[0].length)
      contracts.push({
        language: "anchor",
        name,
        type: "module",
        inherits: [],
        implements: [],
        functions: [],
        stateVariables: fields,
        events: [],
        errors: [],
        imports: [],
        modifiers: [],
      })
    }

    return contracts
  },

  extractCalls(content: string): ExternalCall[] {
    const calls: ExternalCall[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!

      // CPI calls
      const cpiMatch = line.match(/(\w+)::(\w+)\s*\(/)
      if (cpiMatch && (line.includes("cpi") || line.includes("CpiContext") || line.includes("invoke"))) {
        calls.push({
          target: cpiMatch[1]!,
          method: cpiMatch[2]!,
          callingFunction: findEnclosingFn(lines, i),
          line: i + 1,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }

      // invoke / invoke_signed
      if (line.includes("invoke(") || line.includes("invoke_signed(")) {
        calls.push({
          target: "system",
          method: line.includes("invoke_signed") ? "invoke_signed" : "invoke",
          callingFunction: findEnclosingFn(lines, i),
          line: i + 1,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }
    }

    return calls
  },

  extractStorage(content: string): StorageVar[] {
    // Anchor uses accounts, not traditional storage
    return []
  },
}

function extractProgramFunctions(content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = []
  const funcPattern = /pub\s+fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?\s*\{/g

  let match
  while ((match = funcPattern.exec(content)) !== null) {
    const name = match[1]!
    const params = match[2]!.trim()
    const returns = match[3]?.trim() ?? ""

    // Check if it's inside the #[program] module
    const before = content.slice(0, match.index)
    if (!before.includes("#[program]")) continue

    functions.push({
      name,
      visibility: "public",
      mutability: params.includes("&mut") ? "nonpayable" : "view",
      modifiers: [],
      parameters: params,
      returns,
    })
  }

  return functions
}

function extractStructFields(content: string, startIdx: number): StateVariable[] {
  const fields: StateVariable[] = []
  // Find the struct body
  let depth = 0
  let i = startIdx
  while (i < content.length && content[i] !== "{") i++
  if (i >= content.length) return fields
  i++ // skip opening brace
  depth = 1

  let body = ""
  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++
    if (content[i] === "}") depth--
    if (depth > 0) body += content[i]
    i++
  }

  const fieldPattern = /pub\s+(\w+):\s+([^,\n]+)/g
  let match
  while ((match = fieldPattern.exec(body)) !== null) {
    fields.push({
      name: match[1]!,
      type: match[2]!.trim().replace(/,$/, ""),
      visibility: "public",
      constant: false,
      immutable: false,
    })
  }

  return fields
}

function extractEvents(content: string): string[] {
  const events: string[] = []
  const pattern = /#\[event\]\s*pub\s+struct\s+(\w+)/g
  let match
  while ((match = pattern.exec(content)) !== null) {
    events.push(match[1]!)
  }
  return events
}

function extractErrors(content: string): string[] {
  const errors: string[] = []
  const pattern = /#\[error_code\]\s*pub\s+enum\s+(\w+)/g
  let match
  while ((match = pattern.exec(content)) !== null) {
    errors.push(match[1]!)
  }
  return errors
}

function findEnclosingFn(lines: string[], lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i--) {
    const match = lines[i]!.match(/(?:pub\s+)?fn\s+(\w+)\s*[<(]/)
    if (match) return match[1]!
  }
  return "<module>"
}
