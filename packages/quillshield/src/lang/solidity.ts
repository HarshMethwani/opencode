import type { ContractMetadata, ExternalCall, FunctionInfo, LanguageParser, StateVariable, StorageVar } from "./types"

export const SolidityParser: LanguageParser = {
  detect(content: string): boolean {
    return /pragma\s+solidity/i.test(content) || /^\s*\/\/\s*SPDX-License-Identifier:/m.test(content)
  },

  extractMetadata(content: string): ContractMetadata[] {
    const contracts: ContractMetadata[] = []
    const lines = content.split("\n")

    // Extract imports
    const imports = lines
      .filter((l) => /^\s*import\s/.test(l))
      .map((l) => {
        const match = l.match(/["']([^"']+)["']/)
        return match?.[1] ?? l.trim()
      })

    // Find contract/interface/library declarations
    const contractPattern =
      /^\s*(abstract\s+)?(contract|interface|library)\s+(\w+)(?:\s+is\s+([^{]+))?\s*\{/gm
    let match
    while ((match = contractPattern.exec(content)) !== null) {
      const isAbstract = !!match[1]
      const type = isAbstract ? "abstract" : (match[2] as "contract" | "interface" | "library")
      const name = match[3]!
      const inheritsStr = match[4]?.trim() ?? ""
      const inherits = inheritsStr
        ? inheritsStr.split(",").map((s) => s.trim().split("(")[0]!.trim())
        : []

      // Find the body of this contract
      const startIdx = match.index! + match[0].length
      const body = extractBody(content, startIdx)

      const functions = extractFunctions(body)
      const stateVariables = extractStateVariables(body)
      const events = extractEvents(body)
      const errors = extractErrors(body)
      const modifiers = extractModifiers(body)

      contracts.push({
        language: "solidity",
        name,
        type,
        inherits,
        implements: inherits.filter((i) => /^I[A-Z]/.test(i)),
        functions,
        stateVariables,
        events,
        errors,
        imports,
        modifiers,
      })
    }

    return contracts
  },

  extractCalls(content: string): ExternalCall[] {
    const calls: ExternalCall[] = []
    const lines = content.split("\n")

    // Find external calls patterns
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lineNum = i + 1

      // Pattern: address.call/delegatecall/staticcall
      const lowLevelMatch = line.match(/(\w+)\.(call|delegatecall|staticcall)\s*[({]/)
      if (lowLevelMatch) {
        calls.push({
          target: lowLevelMatch[1]!,
          method: lowLevelMatch[2]!,
          callingFunction: findEnclosingFunction(lines, i),
          line: lineNum,
          isDelegatecall: lowLevelMatch[2] === "delegatecall",
          isStaticcall: lowLevelMatch[2] === "staticcall",
        })
      }

      // Pattern: contract.method()
      const contractCallMatch = line.match(/(\w+)\.(\w+)\s*\(/)
      if (contractCallMatch && !["msg", "block", "tx", "abi", "type", "super", "this"].includes(contractCallMatch[1]!)) {
        const target = contractCallMatch[1]!
        const method = contractCallMatch[2]!
        // Skip common non-contract calls
        if (["length", "push", "pop", "encode", "decode", "selector", "slot"].includes(method)) continue
        calls.push({
          target,
          method,
          callingFunction: findEnclosingFunction(lines, i),
          line: lineNum,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }

      // Pattern: IERC20(address).transfer()
      const interfaceCallMatch = line.match(/(\w+)\(([^)]*)\)\.(\w+)\s*\(/)
      if (interfaceCallMatch && /^I?[A-Z]/.test(interfaceCallMatch[1]!)) {
        calls.push({
          target: `${interfaceCallMatch[1]}(${interfaceCallMatch[2]})`,
          method: interfaceCallMatch[3]!,
          callingFunction: findEnclosingFunction(lines, i),
          line: lineNum,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }
    }

    return calls
  },

  extractStorage(content: string): StorageVar[] {
    const vars: StorageVar[] = []
    let slot = 0

    const lines = content.split("\n")
    let inContract = false

    for (const line of lines) {
      if (/^\s*(contract|abstract\s+contract)\s/.test(line)) {
        inContract = true
        slot = 0
        continue
      }

      if (!inContract) continue

      // Match state variable declarations
      const varMatch = line.match(
        /^\s+(mapping\s*\([^)]+\)|[\w\[\]]+)\s+(public|private|internal|external)?\s*(constant|immutable)?\s*(\w+)/,
      )
      if (varMatch) {
        const type = varMatch[1]!
        const name = varMatch[4]!
        const isConstant = varMatch[3] === "constant"
        const isImmutable = varMatch[3] === "immutable"

        if (!isConstant && !isImmutable) {
          vars.push({ name, type, slot })
          // Simplified slot counting — mappings and dynamic arrays take 1 slot for the base
          slot++
        }
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
  const funcPattern =
    /function\s+(\w+)\s*\(([^)]*)\)\s*((?:(?:public|external|internal|private|view|pure|payable|virtual|override|returns\s*\([^)]*\)|\w+)\s*)*)/g

  let match
  while ((match = funcPattern.exec(body)) !== null) {
    const name = match[1]!
    const parameters = match[2]!.trim()
    const modifiersStr = match[3]!

    let visibility: FunctionInfo["visibility"] = "public"
    if (modifiersStr.includes("external")) visibility = "external"
    else if (modifiersStr.includes("internal")) visibility = "internal"
    else if (modifiersStr.includes("private")) visibility = "private"

    let mutability: FunctionInfo["mutability"] = "nonpayable"
    if (modifiersStr.includes("view")) mutability = "view"
    else if (modifiersStr.includes("pure")) mutability = "pure"
    else if (modifiersStr.includes("payable")) mutability = "payable"

    const returnsMatch = modifiersStr.match(/returns\s*\(([^)]*)\)/)
    const returns = returnsMatch?.[1]?.trim() ?? ""

    // Extract custom modifiers
    const knownKeywords = [
      "public",
      "external",
      "internal",
      "private",
      "view",
      "pure",
      "payable",
      "virtual",
      "override",
    ]
    const modifiers = modifiersStr
      .split(/\s+/)
      .filter((m) => m && !knownKeywords.includes(m) && !m.startsWith("returns"))

    functions.push({ name, visibility, mutability, modifiers, parameters, returns })
  }

  return functions
}

function extractStateVariables(body: string): StateVariable[] {
  const vars: StateVariable[] = []
  const lines = body.split("\n")

  for (const line of lines) {
    // Skip function bodies, events, etc.
    if (/^\s*(function|event|error|modifier|constructor|receive|fallback)\s/.test(line)) continue

    const varMatch = line.match(
      /^\s+(mapping\s*\([^)]+\)|[\w\[\].]+)\s+(public|private|internal)?\s*(constant|immutable)?\s+(\w+)\s*[;=]/,
    )
    if (varMatch) {
      vars.push({
        name: varMatch[4]!,
        type: varMatch[1]!,
        visibility: (varMatch[2] as StateVariable["visibility"]) ?? "internal",
        constant: varMatch[3] === "constant",
        immutable: varMatch[3] === "immutable",
      })
    }
  }

  return vars
}

function extractEvents(body: string): string[] {
  const events: string[] = []
  const pattern = /event\s+(\w+)\s*\([^)]*\)/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    events.push(match[1]!)
  }
  return events
}

function extractErrors(body: string): string[] {
  const errors: string[] = []
  const pattern = /error\s+(\w+)\s*\([^)]*\)/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    errors.push(match[1]!)
  }
  return errors
}

function extractModifiers(body: string): string[] {
  const modifiers: string[] = []
  const pattern = /modifier\s+(\w+)\s*\(/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    modifiers.push(match[1]!)
  }
  return modifiers
}

function findEnclosingFunction(lines: string[], lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i--) {
    const match = lines[i]!.match(/function\s+(\w+)\s*\(/)
    if (match) return match[1]!
  }
  return "<top-level>"
}
