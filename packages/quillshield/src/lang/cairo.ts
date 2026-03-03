import type { ContractMetadata, ExternalCall, FunctionInfo, LanguageParser, StateVariable, StorageVar } from "./types"

export const CairoParser: LanguageParser = {
  detect(content: string): boolean {
    return (
      content.includes("#[starknet::contract]") ||
      content.includes("#[contract]") ||
      content.includes("use starknet::") ||
      /^mod\s+\w+\s*\{/m.test(content)
    )
  },

  extractMetadata(content: string): ContractMetadata[] {
    const contracts: ContractMetadata[] = []
    const lines = content.split("\n")
    const imports: string[] = []

    for (const line of lines) {
      if (/^\s*use\s/.test(line)) imports.push(line.trim().replace(/;$/, ""))
    }

    // Find #[starknet::contract] modules
    const contractPattern = /#\[starknet::contract\]\s*mod\s+(\w+)\s*\{/g
    let match
    while ((match = contractPattern.exec(content)) !== null) {
      const name = match[1]!
      const startIdx = match.index! + match[0].length
      const body = extractBody(content, startIdx)

      const functions = extractFunctions(body)
      const stateVariables = extractStorageVars(body)
      const events = extractEvents(body)

      contracts.push({
        language: "cairo",
        name,
        type: "contract",
        inherits: [],
        implements: extractInterfaces(body),
        functions,
        stateVariables,
        events,
        errors: [],
        imports,
        modifiers: [],
      })
    }

    // Find #[starknet::interface] traits
    const interfacePattern = /#\[starknet::interface\]\s*trait\s+(\w+)\s*<[^>]*>\s*\{/g
    while ((match = interfacePattern.exec(content)) !== null) {
      const name = match[1]!
      const startIdx = match.index! + match[0].length
      const body = extractBody(content, startIdx)
      const functions = extractTraitFunctions(body)

      contracts.push({
        language: "cairo",
        name,
        type: "interface",
        inherits: [],
        implements: [],
        functions,
        stateVariables: [],
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

      // Dispatcher calls (IContractDispatcher)
      const dispatcherMatch = line.match(/(\w+Dispatcher)\s*\{[^}]*\}\s*\.(\w+)\s*\(/)
      if (dispatcherMatch) {
        calls.push({
          target: dispatcherMatch[1]!,
          method: dispatcherMatch[2]!,
          callingFunction: findEnclosingFn(lines, i),
          line: i + 1,
          isDelegatecall: dispatcherMatch[1]!.includes("Library"),
          isStaticcall: false,
        })
      }

      // syscalls
      if (line.includes("call_contract_syscall") || line.includes("library_call_syscall")) {
        calls.push({
          target: "syscall",
          method: line.includes("library") ? "library_call" : "call_contract",
          callingFunction: findEnclosingFn(lines, i),
          line: i + 1,
          isDelegatecall: line.includes("library"),
          isStaticcall: false,
        })
      }

      // L1 handler / send_message_to_l1
      if (line.includes("send_message_to_l1")) {
        calls.push({
          target: "L1",
          method: "send_message_to_l1",
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
    const vars: StorageVar[] = []
    const storagePattern = /#\[storage\]\s*struct\s+Storage\s*\{([^}]*)\}/s
    const match = content.match(storagePattern)
    if (!match) return vars

    const fieldPattern = /(\w+):\s+([^,\n]+)/g
    let fieldMatch
    let slot = 0
    while ((fieldMatch = fieldPattern.exec(match[1]!)) !== null) {
      vars.push({
        name: fieldMatch[1]!,
        type: fieldMatch[2]!.trim().replace(/,$/, ""),
        slot: slot++,
      })
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

  // Find #[external(v0)] or #[abi(embed_v0)] decorated functions
  const funcPattern = /(?:#\[(external|abi\(embed_v0\)|l1_handler)\][^f]*)?fn\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?\s*\{/g

  let match
  while ((match = funcPattern.exec(body)) !== null) {
    const decorator = match[1] ?? ""
    const name = match[2]!
    const params = match[3]!.trim()
    const returns = match[4]?.trim() ?? ""

    let visibility: FunctionInfo["visibility"] = "internal"
    if (decorator.includes("external") || decorator.includes("abi")) visibility = "external"

    const modifiers: string[] = []
    if (decorator.includes("l1_handler")) modifiers.push("l1_handler")

    const isView = !params.includes("ref self") && params.includes("self")

    functions.push({
      name,
      visibility,
      mutability: isView ? "view" : "nonpayable",
      modifiers,
      parameters: params,
      returns,
    })
  }

  return functions
}

function extractTraitFunctions(body: string): FunctionInfo[] {
  const functions: FunctionInfo[] = []
  const funcPattern = /fn\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^;{]+))?/g

  let match
  while ((match = funcPattern.exec(body)) !== null) {
    const name = match[1]!
    const params = match[2]!.trim()
    const returns = match[3]?.trim() ?? ""
    const isView = !params.includes("ref self")

    functions.push({
      name,
      visibility: "external",
      mutability: isView ? "view" : "nonpayable",
      modifiers: [],
      parameters: params,
      returns,
    })
  }

  return functions
}

function extractStorageVars(body: string): StateVariable[] {
  const vars: StateVariable[] = []
  const storageMatch = body.match(/#\[storage\]\s*struct\s+Storage\s*\{([^}]*)\}/s)
  if (!storageMatch) return vars

  const fieldPattern = /(\w+):\s+([^,\n]+)/g
  let match
  while ((match = fieldPattern.exec(storageMatch[1]!)) !== null) {
    vars.push({
      name: match[1]!,
      type: match[2]!.trim().replace(/,$/, ""),
      visibility: "internal",
      constant: false,
      immutable: false,
    })
  }

  return vars
}

function extractEvents(body: string): string[] {
  const events: string[] = []
  const pattern = /#\[event\]\s*(?:#\[.*\]\s*)*(?:enum|struct)\s+(\w+)/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    events.push(match[1]!)
  }
  return events
}

function extractInterfaces(body: string): string[] {
  const interfaces: string[] = []
  const pattern = /impl\s+(\w+)\s+of\s+(\w+)/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    interfaces.push(match[2]!)
  }
  return interfaces
}

function findEnclosingFn(lines: string[], lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i--) {
    const match = lines[i]!.match(/fn\s+(\w+)\s*[<(]/)
    if (match) return match[1]!
  }
  return "<module>"
}
