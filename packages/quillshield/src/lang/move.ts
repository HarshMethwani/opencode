import type {
  ContractMetadata,
  ExternalCall,
  FunctionInfo,
  LanguageParser,
  StateVariable,
  StorageVar,
  SuiModuleInfo,
  SuiObjectInfo,
} from "./types"

// Sui framework modules that are NOT external cross-module calls worth tracking
const SUI_STDLIB = new Set([
  "vector", "option", "string", "debug", "error", "ascii",
  "type_name", "bcs", "hash", "hex", "address",
])

// Sui framework calls that ARE security-relevant and should be tracked
const SUI_SECURITY_CALLS = new Set([
  "transfer", "public_transfer", "share_object", "public_share_object",
  "freeze_object", "public_freeze_object",
  "delete", "new",
  "split", "join", "zero", "burn", "mint", "value", "into_balance", "from_balance",
  "add", "borrow", "borrow_mut", "remove", "exists_", "exists_with_type",
  "timestamp_ms",
  "emit",
  "sender",
  "make_immutable", "only_additive_upgrades", "only_dep_upgrades",
  "new_random", "generate_u64", "generate_u128", "generate_bytes",
])

export const MoveParser: LanguageParser = {
  detect(content: string): boolean {
    return /^module\s/m.test(content) || content.includes("use sui::") || content.includes("use aptos_framework")
  },

  extractMetadata(content: string): ContractMetadata[] {
    const contracts: ContractMetadata[] = []
    const isSui = content.includes("use sui::") || content.includes("sui::object") || content.includes("sui::transfer")
    const modulePattern = /module\s+([\w:]+)\s*\{/g

    let match
    while ((match = modulePattern.exec(content)) !== null) {
      const moduleName = match[1]!
      const startIdx = match.index! + match[0].length
      const body = extractBody(content, startIdx)

      const functions = extractFunctions(body)
      const stateVariables = extractStructFields(body)
      const imports = extractUseStatements(body)
      const events = extractEvents(body)
      const errors = extractAbortCodes(body)

      const metadata: ContractMetadata = {
        language: isSui ? "sui-move" : "move",
        name: moduleName,
        type: "module",
        inherits: [],
        implements: [],
        functions,
        stateVariables,
        events,
        errors,
        imports,
        modifiers: [],
      }

      if (isSui) {
        const objects = extractSuiObjects(body)
        const moduleInfo = extractSuiModuleInfo(body, moduleName, functions)
        metadata.suiObjects = objects
        metadata.suiModule = moduleInfo
      }

      contracts.push(metadata)
    }

    return contracts
  },

  extractCalls(content: string): ExternalCall[] {
    const calls: ExternalCall[] = []
    const lines = content.split("\n")
    const seen = new Set<string>()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lineNum = i + 1

      // Skip comments
      if (/^\s*\/\//.test(line)) continue

      // Pattern 1: Module::function calls (e.g., transfer::transfer, coin::split)
      const moduleCallRegex = /([\w:]+)::(\w+)\s*[<(]/g
      let m
      while ((m = moduleCallRegex.exec(line)) !== null) {
        const target = m[1]!
        const method = m[2]!
        const shortTarget = target.split("::").pop()!

        // Skip stdlib noise but keep security-relevant calls
        if (SUI_STDLIB.has(shortTarget) && !SUI_SECURITY_CALLS.has(method)) continue
        // Skip self-references
        if (shortTarget === "Self") continue

        const key = `${lineNum}:${target}:${method}`
        if (seen.has(key)) continue
        seen.add(key)

        calls.push({
          target,
          method,
          callingFunction: findEnclosingFn(lines, i),
          line: lineNum,
          isDelegatecall: false,
          isStaticcall: method === "borrow" || method === "borrow_mut" ? false : false,
        })
      }

      // Pattern 2: Global storage operations (Aptos Move)
      const globalMatch = line.match(/(borrow_global_mut|borrow_global|move_from|move_to|exists)\s*</)
      if (globalMatch) {
        const key = `${lineNum}:global_storage:${globalMatch[1]}`
        if (!seen.has(key)) {
          seen.add(key)
          calls.push({
            target: "global_storage",
            method: globalMatch[1]!,
            callingFunction: findEnclosingFn(lines, i),
            line: lineNum,
            isDelegatecall: false,
            isStaticcall: globalMatch[1] === "borrow_global" || globalMatch[1] === "exists",
          })
        }
      }
    }

    return calls
  },

  extractStorage(content: string): StorageVar[] {
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

  // Match function declarations with all visibility combinations
  // Patterns: fun, public fun, public(package) fun, public entry fun, entry fun, entry public fun
  const funcPattern =
    /((?:public\s*(?:\(\s*package\s*\)\s*)?)?(?:entry\s+)?(?:public\s*(?:\(\s*package\s*\)\s*)?)?)?fun\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{]+?))?\s*(?:acquires\s+([^{]+?))?\s*\{/g

  let match
  while ((match = funcPattern.exec(body)) !== null) {
    const visibilityStr = (match[1] ?? "").trim()
    const name = match[2]!
    const params = match[3]!.trim()
    const returns = match[4]?.trim() ?? ""
    const acquires = match[5]?.trim() ?? ""

    let visibility: FunctionInfo["visibility"] = "private"
    const isEntry = visibilityStr.includes("entry")
    const isPublic = visibilityStr.includes("public")
    const isPackage = visibilityStr.includes("package")

    if (isEntry) visibility = "external"
    else if (isPublic && !isPackage) visibility = "public"
    else if (isPublic && isPackage) visibility = "internal" // public(package) is like internal

    const modifiers: string[] = []
    if (acquires) modifiers.push(`acquires ${acquires}`)
    if (isEntry && isPublic) modifiers.push("public entry")
    else if (isEntry) modifiers.push("entry")
    if (isPackage) modifiers.push("public(package)")

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

function extractStructFields(body: string): StateVariable[] {
  const vars: StateVariable[] = []
  // Match structs with optional abilities
  const structPattern = /struct\s+(\w+)\s+(?:has\s+([^{]+))?\{([^}]*)\}/gs
  let match
  while ((match = structPattern.exec(body)) !== null) {
    const structName = match[1]!
    const fields = match[3]!
    const fieldPattern = /(\w+):\s+([^,\n]+)/g
    let fieldMatch
    while ((fieldMatch = fieldPattern.exec(fields)) !== null) {
      vars.push({
        name: `${structName}.${fieldMatch[1]}`,
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

// ============================================================
// Sui-specific extraction functions
// ============================================================

function extractSuiObjects(body: string): SuiObjectInfo[] {
  const objects: SuiObjectInfo[] = []
  // Match: struct Name has ability1, ability2 { fields }
  const structPattern = /struct\s+(\w+)\s+has\s+([^{]+)\{([^}]*)\}/gs
  // Also match: struct Name { fields } (phantom/no abilities)
  const noAbilityPattern = /struct\s+(\w+)\s*\{([^}]*)\}/gs

  let match
  while ((match = structPattern.exec(body)) !== null) {
    const name = match[1]!
    const abilitiesStr = match[2]!.trim().replace(/,$/, "").trim()
    const fieldsStr = match[3]!
    const abilities = abilitiesStr.split(/\s*,\s*/).map((a) => a.trim()).filter(Boolean)

    objects.push({
      name,
      abilities,
      hasKey: abilities.includes("key"),
      hasStore: abilities.includes("store"),
      hasCopy: abilities.includes("copy"),
      hasDrop: abilities.includes("drop"),
      fields: parseStructFields(fieldsStr),
    })
  }

  // Structs without abilities (hot potato pattern)
  while ((match = noAbilityPattern.exec(body)) !== null) {
    const name = match[1]!
    // Skip if already parsed (had abilities)
    if (objects.some((o) => o.name === name)) continue
    const fieldsStr = match[2]!

    objects.push({
      name,
      abilities: [],
      hasKey: false,
      hasStore: false,
      hasCopy: false,
      hasDrop: false,
      fields: parseStructFields(fieldsStr),
    })
  }

  return objects
}

function parseStructFields(fieldsStr: string): { name: string; type: string }[] {
  const fields: { name: string; type: string }[] = []
  const fieldPattern = /(\w+):\s+([^,\n]+)/g
  let m
  while ((m = fieldPattern.exec(fieldsStr)) !== null) {
    fields.push({ name: m[1]!, type: m[2]!.trim().replace(/,$/, "") })
  }
  return fields
}

function extractSuiModuleInfo(body: string, moduleName: string, functions: FunctionInfo[]): SuiModuleInfo {
  // Detect init function
  const hasInit = /\bfun\s+init\s*\(/.test(body)

  // Detect One-Time Witness
  // OTW type = module name in ALL_CAPS, has only `drop`, no fields
  const shortName = moduleName.split("::").pop()!
  const otwName = shortName.toUpperCase()
  const otwPattern = new RegExp(`struct\\s+${otwName}\\s+has\\s+drop\\s*\\{\\s*\\}`)
  const hasOTW = otwPattern.test(body)

  // Extract capability types (ending in Cap, or common patterns)
  const capabilities: string[] = []
  const capPattern = /struct\s+(\w*Cap\w*)\s+has/g
  let m
  while ((m = capPattern.exec(body)) !== null) {
    capabilities.push(m[1]!)
  }
  // Also catch TreasuryCap and UpgradeCap from imports
  if (body.includes("TreasuryCap")) capabilities.push("TreasuryCap")
  if (body.includes("UpgradeCap")) capabilities.push("UpgradeCap")
  // Deduplicate
  const uniqueCaps = [...new Set(capabilities)]

  // Detect shared objects (transfer::share_object / public_share_object calls)
  const sharedObjects: string[] = []
  const sharePattern = /(?:transfer::)?(?:public_)?share_object\s*[(<]\s*(\w+)?/g
  while ((m = sharePattern.exec(body)) !== null) {
    if (m[1]) sharedObjects.push(m[1])
  }

  // Entry functions
  const entryFunctions = functions
    .filter((f) => f.modifiers.some((mod) => mod.includes("entry")))
    .map((f) => f.name)

  // Dynamic field operations
  const dynamicFieldOps: string[] = []
  const dfPattern = /dynamic_(?:object_)?field::(\w+)/g
  while ((m = dfPattern.exec(body)) !== null) {
    dynamicFieldOps.push(m[1]!)
  }

  return {
    hasInit,
    hasOTW,
    otwType: hasOTW ? otwName : null,
    capabilities: uniqueCaps,
    sharedObjects: [...new Set(sharedObjects)],
    entryFunctions,
    dynamicFieldOps: [...new Set(dynamicFieldOps)],
  }
}
