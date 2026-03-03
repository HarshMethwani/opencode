import type { ContractMetadata, ExternalCall, FunctionInfo, LanguageParser, StateVariable, StorageVar } from "./types"

export const MoveParser: LanguageParser = {
  detect(content: string): boolean {
    return /^module\s/m.test(content) || content.includes("use aptos_framework") || content.includes("use sui::")
  },

  extractMetadata(content: string): ContractMetadata[] {
    const contracts: ContractMetadata[] = []
    const modulePattern = /module\s+([\w:]+)\s*\{/g

    let match
    while ((match = modulePattern.exec(content)) !== null) {
      const moduleName = match[1]!
      const startIdx = match.index! + match[0].length
      const body = extractBody(content, startIdx)

      const functions = extractFunctions(body)
      const stateVariables = extractStructs(body)
      const imports = extractUseStatements(body)

      contracts.push({
        language: "move",
        name: moduleName,
        type: "module",
        inherits: [],
        implements: [],
        functions,
        stateVariables,
        events: extractEvents(body),
        errors: extractAbortCodes(body),
        imports,
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

      // Module::function calls
      const callMatch = line.match(/([\w:]+)::(\w+)\s*[<(]/)
      if (callMatch) {
        const target = callMatch[1]!
        const method = callMatch[2]!
        // Skip self-module calls and common std calls
        if (["vector", "option", "string", "debug", "error"].includes(target.split("::").pop()!)) continue

        calls.push({
          target,
          method,
          callingFunction: findEnclosingFn(lines, i),
          line: i + 1,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }

      // borrow_global / borrow_global_mut / move_from / move_to
      const globalMatch = line.match(/(borrow_global_mut|borrow_global|move_from|move_to)\s*</)
      if (globalMatch) {
        calls.push({
          target: "global_storage",
          method: globalMatch[1]!,
          callingFunction: findEnclosingFn(lines, i),
          line: i + 1,
          isDelegatecall: false,
          isStaticcall: globalMatch[1] === "borrow_global",
        })
      }
    }

    return calls
  },

  extractStorage(content: string): StorageVar[] {
    // Move uses resources/structs stored in global storage
    const vars: StorageVar[] = []
    const pattern = /struct\s+(\w+)\s+has\s+([^{]+)\{/g
    let match
    let slot = 0
    while ((match = pattern.exec(content)) !== null) {
      const abilities = match[2]!.trim()
      if (abilities.includes("key")) {
        vars.push({ name: match[1]!, type: "resource", slot: slot++ })
      }
    }
    return vars
  },
}

function extractBody(content: string, startIdx: number): string {
  let depth = 1
  let i = startIdx
  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++
    if (content[i] === "}") depth--
    i++
  }
  return content.slice(startIdx, i - 1)
}

function extractFunctions(body: string): FunctionInfo[] {
  const functions: FunctionInfo[] = []
  const funcPattern = /(public\s+(?:entry\s+)?|entry\s+)?fun\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*(?:acquires\s+([^{]+))?\s*\{/g

  let match
  while ((match = funcPattern.exec(body)) !== null) {
    const visibilityStr = match[1]?.trim() ?? ""
    const name = match[2]!
    const params = match[3]!.trim()
    const returns = match[4]?.trim() ?? ""
    const acquires = match[5]?.trim() ?? ""

    let visibility: FunctionInfo["visibility"] = "private"
    if (visibilityStr.includes("public")) visibility = "public"
    if (visibilityStr.includes("entry")) visibility = "external"

    const modifiers: string[] = []
    if (acquires) modifiers.push(`acquires ${acquires}`)

    functions.push({
      name,
      visibility,
      mutability: params.includes("&mut") ? "nonpayable" : "view",
      modifiers,
      parameters: params,
      returns,
    })
  }

  return functions
}

function extractStructs(body: string): StateVariable[] {
  const vars: StateVariable[] = []
  const structPattern = /struct\s+(\w+)\s+(?:has\s+[^{]+)?\{([^}]*)\}/gs
  let match
  while ((match = structPattern.exec(body)) !== null) {
    const fields = match[2]!
    const fieldPattern = /(\w+):\s+([^,\n]+)/g
    let fieldMatch
    while ((fieldMatch = fieldPattern.exec(fields)) !== null) {
      vars.push({
        name: `${match[1]}.${fieldMatch[1]}`,
        type: fieldMatch[2]!.trim().replace(/,$/, ""),
        visibility: "public",
        constant: false,
        immutable: false,
      })
    }
  }
  return vars
}

function extractUseStatements(body: string): string[] {
  const imports: string[] = []
  const pattern = /use\s+([^;]+);/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    imports.push(match[1]!.trim())
  }
  return imports
}

function extractEvents(body: string): string[] {
  const events: string[] = []
  // Move events are typically emitted via event::emit
  const pattern = /event::emit\s*[<(]\s*(\w+)/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    events.push(match[1]!)
  }
  return events
}

function extractAbortCodes(body: string): string[] {
  const errors: string[] = []
  const pattern = /const\s+(E\w+):\s*u64/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    errors.push(match[1]!)
  }
  return errors
}

function findEnclosingFn(lines: string[], lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i--) {
    const match = lines[i]!.match(/fun\s+(\w+)\s*[<(]/)
    if (match) return match[1]!
  }
  return "<module>"
}
