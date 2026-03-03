import type { ContractMetadata, ExternalCall, FunctionInfo, LanguageParser, StateVariable, StorageVar } from "./types"

export const CosmWasmParser: LanguageParser = {
  detect(content: string): boolean {
    return (
      content.includes("#[entry_point]") ||
      content.includes("ExecuteMsg") ||
      content.includes("use cosmwasm_std")
    )
  },

  extractMetadata(content: string): ContractMetadata[] {
    const contracts: ContractMetadata[] = []
    const lines = content.split("\n")
    const imports: string[] = []
    const functions: FunctionInfo[] = []

    for (const line of lines) {
      if (/^\s*use\s/.test(line)) imports.push(line.trim().replace(/;$/, ""))
    }

    // Extract entry point functions
    const entryPoints = ["instantiate", "execute", "query", "migrate", "sudo", "reply"]
    const funcPattern = /(?:#\[entry_point\]\s*)?pub\s+fn\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?\s*\{/g

    let match
    while ((match = funcPattern.exec(content)) !== null) {
      const name = match[1]!
      const params = match[2]!.trim()
      const returns = match[3]?.trim() ?? ""
      const isEntryPoint = entryPoints.includes(name) || content.slice(Math.max(0, match.index! - 50), match.index).includes("#[entry_point]")

      functions.push({
        name,
        visibility: isEntryPoint ? "external" : "public",
        mutability: name === "query" ? "view" : "nonpayable",
        modifiers: isEntryPoint ? ["entry_point"] : [],
        parameters: params,
        returns,
      })
    }

    // Extract message enums
    const msgPattern = /pub\s+enum\s+((?:Execute|Query|Instantiate|Migrate)Msg)\s*\{([^}]*)\}/gs
    while ((match = msgPattern.exec(content)) !== null) {
      const enumName = match[1]!
      const body = match[2]!
      const variants = body.match(/(\w+)\s*[{(]/g)?.map((v) => v.replace(/[{(]/, "").trim()) ?? []

      contracts.push({
        language: "cosmwasm",
        name: enumName,
        type: "interface",
        inherits: [],
        implements: [],
        functions: variants.map((v) => ({
          name: v,
          visibility: "external" as const,
          mutability: enumName.includes("Query") ? ("view" as const) : ("nonpayable" as const),
          modifiers: [],
          parameters: "",
          returns: "",
        })),
        stateVariables: [],
        events: [],
        errors: [],
        imports: [],
        modifiers: [],
      })
    }

    // Extract state items
    const stateVars: StateVariable[] = []
    const itemPattern = /(?:Item|Map|SnapshotMap|IndexedMap)::new\(\s*["'](\w+)["']\s*\)/g
    while ((match = itemPattern.exec(content)) !== null) {
      const lineContent = content.slice(Math.max(0, content.lastIndexOf("\n", match.index)), content.indexOf("\n", match.index! + match[0].length))
      const nameMatch = lineContent.match(/(?:pub\s+)?(?:const|static)\s+(\w+)/)
      stateVars.push({
        name: nameMatch?.[1] ?? match[1]!,
        type: lineContent.includes("Map") ? "Map" : "Item",
        visibility: lineContent.includes("pub") ? "public" : "internal",
        constant: true,
        immutable: false,
      })
    }

    if (functions.length || stateVars.length) {
      contracts.unshift({
        language: "cosmwasm",
        name: "Contract",
        type: "contract",
        inherits: [],
        implements: [],
        functions,
        stateVariables: stateVars,
        events: [],
        errors: extractErrors(content),
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

      // CosmosMsg, SubMsg, WasmMsg
      if (line.includes("WasmMsg::Execute") || line.includes("WasmMsg::Instantiate")) {
        calls.push({
          target: "WasmMsg",
          method: line.includes("Execute") ? "Execute" : "Instantiate",
          callingFunction: findEnclosingFn(lines, i),
          line: i + 1,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }

      if (line.includes("SubMsg::new") || line.includes("SubMsg::reply_on")) {
        calls.push({
          target: "SubMsg",
          method: "cross_contract_call",
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
    const pattern = /(?:Item|Map|SnapshotMap|IndexedMap)::new\(\s*["'](\w+)["']\s*\)/g
    let match
    let slot = 0
    while ((match = pattern.exec(content)) !== null) {
      vars.push({ name: match[1]!, type: "storage_key", slot: slot++ })
    }
    return vars
  },
}

function extractErrors(content: string): string[] {
  const errors: string[] = []
  const pattern = /pub\s+enum\s+ContractError\s*\{([^}]*)\}/s
  const match = content.match(pattern)
  if (match) {
    const variants = match[1]!.match(/(\w+)\s*[{(,]/g)?.map((v) => v.replace(/[{(,]/, "").trim()) ?? []
    errors.push(...variants)
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
