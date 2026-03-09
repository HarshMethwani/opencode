import type { ContractMetadata, ExternalCall, FunctionInfo, LanguageParser, StateVariable, StorageVar } from "./types"

// Solidity built-in globals and type methods that are NOT external contract calls
const BUILTIN_TARGETS = new Set([
  "msg", "block", "tx", "abi", "type", "super", "this",
  "string", "bytes", "address", "uint256", "int256",
  "Math", "SignedMath",
])

const BUILTIN_METHODS = new Set([
  "length", "push", "pop", "concat",
  "encode", "encodePacked", "encodeWithSignature", "encodeWithSelector", "encodeCall", "decode",
  "selector", "slot", "offset",
  "wrap", "unwrap",
  "balance", "code", "codehash", "send",
  "min", "max",
  "creationCode", "runtimeCode", "name", "interfaceId",
  "transfer",  // address.transfer is a send, not a contract call — handled separately
])

// Known library patterns that look like contract calls but aren't
const LIBRARY_PATTERNS = [
  /^Safe/, /^Math/, /^Address$/, /^Strings$/, /^Arrays$/,
  /^Counters$/, /^EnumerableSet$/, /^EnumerableMap$/,
  /^ECDSA$/, /^MerkleProof$/, /^SignatureChecker$/,
  /^Base64$/, /^Clones$/, /^Create2$/, /^StorageSlot$/,
]

// Solidity type sizes in bytes for storage layout
const TYPE_SIZES: Record<string, number> = {
  bool: 1, address: 20,
  uint8: 1, uint16: 2, uint32: 4, uint64: 8, uint128: 16, uint256: 32,
  int8: 1, int16: 2, int32: 4, int64: 8, int128: 16, int256: 32,
  bytes1: 1, bytes2: 2, bytes4: 4, bytes8: 8, bytes16: 16, bytes32: 32,
}

function getTypeSize(type: string): number {
  if (type in TYPE_SIZES) return TYPE_SIZES[type]!
  if (type === "uint" || type === "int") return 32
  if (type.startsWith("mapping")) return 32
  if (type.includes("[]")) return 32
  if (type === "string" || type === "bytes") return 32
  if (type.startsWith("address")) return 20
  if (type.startsWith("enum")) return 1
  const fixedMatch = type.match(/(\w+)\[(\d+)\]/)
  if (fixedMatch) {
    const elementSize = getTypeSize(fixedMatch[1]!)
    const count = parseInt(fixedMatch[2]!)
    return Math.ceil((elementSize * count) / 32) * 32
  }
  return 32
}

/**
 * Strip comments and string literals from Solidity source code.
 * Returns cleaned content where comments/strings are replaced with spaces
 * (preserving line numbers for accurate line tracking).
 */
function stripCommentsAndStrings(content: string): string {
  let result = ""
  let i = 0
  while (i < content.length) {
    // Single-line comment
    if (content[i] === "/" && content[i + 1] === "/") {
      while (i < content.length && content[i] !== "\n") {
        result += " "
        i++
      }
      continue
    }
    // Multi-line comment
    if (content[i] === "/" && content[i + 1] === "*") {
      i += 2
      result += "  "
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
        result += content[i] === "\n" ? "\n" : " "
        i++
      }
      if (i < content.length) {
        result += "  "
        i += 2
      }
      continue
    }
    // String literal (double quotes)
    if (content[i] === '"') {
      result += " "
      i++
      while (i < content.length && content[i] !== '"') {
        if (content[i] === "\\") { result += " "; i++ }
        result += content[i] === "\n" ? "\n" : " "
        i++
      }
      if (i < content.length) { result += " "; i++ }
      continue
    }
    // String literal (single quotes)
    if (content[i] === "'") {
      result += " "
      i++
      while (i < content.length && content[i] !== "'") {
        if (content[i] === "\\") { result += " "; i++ }
        result += content[i] === "\n" ? "\n" : " "
        i++
      }
      if (i < content.length) { result += " "; i++ }
      continue
    }
    result += content[i]
    i++
  }
  return result
}

function isLikelyLibrary(name: string): boolean {
  return LIBRARY_PATTERNS.some((p) => p.test(name))
}

export const SolidityParser: LanguageParser = {
  detect(content: string): boolean {
    return /pragma\s+solidity/i.test(content) || /^\s*\/\/\s*SPDX-License-Identifier:/m.test(content)
  },

  extractMetadata(content: string): ContractMetadata[] {
    const contracts: ContractMetadata[] = []
    const lines = content.split("\n")

    const imports = lines
      .filter((l) => /^\s*import\s/.test(l))
      .map((l) => {
        const match = l.match(/["']([^"']+)["']/)
        return match?.[1] ?? l.trim()
      })

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
    const stripped = stripCommentsAndStrings(content)
    const lines = stripped.split("\n")
    const matchedLines = new Set<number>()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lineNum = i + 1

      // Pattern 1: Low-level calls — address.call/delegatecall/staticcall
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
        matchedLines.add(i)
        continue
      }

      // Pattern 2: Interface cast calls — IERC20(addr).transfer()
      const interfaceCallMatch = line.match(/(\w+)\(([^)]*)\)\.(\w+)\s*\(/)
      if (interfaceCallMatch && /^I?[A-Z]/.test(interfaceCallMatch[1]!)) {
        const target = interfaceCallMatch[1]!
        if (!BUILTIN_TARGETS.has(target)) {
          calls.push({
            target: `${target}(${interfaceCallMatch[2]})`,
            method: interfaceCallMatch[3]!,
            callingFunction: findEnclosingFunction(lines, i),
            line: lineNum,
            isDelegatecall: false,
            isStaticcall: false,
          })
          matchedLines.add(i)
        }
      }

      // Pattern 3: address.transfer() / address.send() — ETH transfers
      const ethTransfer = line.match(/(\w+)\.(transfer|send)\s*\(/)
      if (ethTransfer && !BUILTIN_TARGETS.has(ethTransfer[1]!)) {
        calls.push({
          target: ethTransfer[1]!,
          method: ethTransfer[2]!,
          callingFunction: findEnclosingFunction(lines, i),
          line: lineNum,
          isDelegatecall: false,
          isStaticcall: false,
        })
        matchedLines.add(i)
      }
    }

    // Pattern 4: Regular contract.method() calls — with filtering
    for (let i = 0; i < lines.length; i++) {
      if (matchedLines.has(i)) continue
      const line = lines[i]!
      const lineNum = i + 1

      const contractCallRegex = /(\w+)\.(\w+)\s*\(/g
      let m
      while ((m = contractCallRegex.exec(line)) !== null) {
        const target = m[1]!
        const method = m[2]!

        // Skip builtins
        if (BUILTIN_TARGETS.has(target)) continue
        // Skip known built-in methods
        if (BUILTIN_METHODS.has(method)) continue
        // Skip likely library calls
        if (isLikelyLibrary(target)) continue
        // Skip lowercase-starting targets (likely local variables accessing struct fields)
        // BUT allow if method starts with lowercase (contract calls like token.approve)
        // Skip if it looks like array/mapping access: something.something[
        if (line.match(new RegExp(`${target}\\.${method}\\s*\\[`))) continue
        // Skip emit patterns
        if (/^\s*emit\s/.test(line)) continue
        // Skip variable declarations that happen to have dots
        if (/^\s*(uint|int|bool|address|bytes|string|mapping)/.test(line)) continue

        calls.push({
          target,
          method,
          callingFunction: findEnclosingFunction(lines, i),
          line: lineNum,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }
    }

    return deduplicateCalls(calls)
  },

  extractStorage(content: string): StorageVar[] {
    const vars: StorageVar[] = []
    let currentSlot = 0
    let slotOffset = 0

    const lines = content.split("\n")
    let inContract = false
    let braceDepth = 0

    for (const line of lines) {
      if (/^\s*(contract|abstract\s+contract)\s/.test(line)) {
        inContract = true
        braceDepth = 0
        currentSlot = 0
        slotOffset = 0
      }

      if (!inContract) continue

      // Track brace depth to skip function bodies
      for (const ch of line) {
        if (ch === "{") braceDepth++
        if (ch === "}") braceDepth--
      }
      // Only extract at contract-level (depth 1), not inside functions
      if (braceDepth > 1) continue
      if (braceDepth <= 0) {
        inContract = false
        continue
      }

      // Skip non-variable lines
      if (/^\s*(function|event|error|modifier|constructor|receive|fallback|using|struct|enum)\s/.test(line)) continue

      const varMatch = line.match(
        /^\s+(mapping\s*\([^)]+\)|[\w\[\].]+)\s+(public|private|internal)?\s*(constant|immutable)?\s+(\w+)\s*[;=]/,
      )
      if (!varMatch) continue

      const type = varMatch[1]!
      const name = varMatch[4]!
      const isConstant = varMatch[3] === "constant"
      const isImmutable = varMatch[3] === "immutable"

      // Constants and immutables don't take storage slots
      if (isConstant || isImmutable) continue

      const size = getTypeSize(type)

      // Packing: if the type fits in the remaining space in the current slot, pack it
      if (size < 32 && slotOffset + size <= 32) {
        vars.push({ name, type, slot: currentSlot, offset: slotOffset, size })
        slotOffset += size
      } else {
        // Start a new slot
        if (slotOffset > 0) currentSlot++
        slotOffset = 0
        vars.push({ name, type, slot: currentSlot, offset: 0, size })
        if (size >= 32) {
          currentSlot += Math.ceil(size / 32)
          slotOffset = 0
        } else {
          slotOffset = size
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

  // Regular functions
  const funcPattern =
    /function\s+(\w+)\s*\(([^)]*)\)\s*((?:(?:public|external|internal|private|view|pure|payable|virtual|override|returns\s*\([^)]*\)|\w+)\s*)*)/g
  let match
  while ((match = funcPattern.exec(body)) !== null) {
    functions.push(parseFunctionMatch(match[1]!, match[2]!, match[3]!))
  }

  // Constructor
  const ctorMatch = body.match(/constructor\s*\(([^)]*)\)\s*((?:(?:public|internal|payable|virtual|override|\w+)\s*)*)/)
  if (ctorMatch) {
    const modifiersStr = ctorMatch[2]!
    const modifiers = modifiersStr.split(/\s+/).filter((m) =>
      m && !["public", "internal", "payable", "virtual", "override"].includes(m),
    )
    functions.push({
      name: "constructor",
      visibility: modifiersStr.includes("internal") ? "internal" : "public",
      mutability: modifiersStr.includes("payable") ? "payable" : "nonpayable",
      modifiers,
      parameters: ctorMatch[1]!.trim(),
      returns: "",
    })
  }

  // receive()
  const receiveMatch = body.match(/receive\s*\(\s*\)\s*(external\s+payable|payable\s+external)/)
  if (receiveMatch) {
    functions.push({
      name: "receive",
      visibility: "external",
      mutability: "payable",
      modifiers: [],
      parameters: "",
      returns: "",
    })
  }

  // fallback()
  const fallbackMatch = body.match(/fallback\s*\(([^)]*)\)\s*((?:(?:external|payable|virtual|override|\w+)\s*)*)/)
  if (fallbackMatch) {
    const mods = fallbackMatch[2]!
    functions.push({
      name: "fallback",
      visibility: "external",
      mutability: mods.includes("payable") ? "payable" : "nonpayable",
      modifiers: [],
      parameters: fallbackMatch[1]!.trim(),
      returns: "",
    })
  }

  return functions
}

function parseFunctionMatch(name: string, params: string, modifiersStr: string): FunctionInfo {
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

  const knownKeywords = [
    "public", "external", "internal", "private",
    "view", "pure", "payable", "virtual", "override",
  ]
  const modifiers = modifiersStr
    .split(/\s+/)
    .filter((m) => m && !knownKeywords.includes(m) && !m.startsWith("returns"))

  return { name, visibility, mutability, modifiers, parameters: params.trim(), returns }
}

function extractStateVariables(body: string): StateVariable[] {
  const vars: StateVariable[] = []
  const lines = body.split("\n")

  for (const line of lines) {
    if (/^\s*(function|event|error|modifier|constructor|receive|fallback|using|struct|enum)\s/.test(line)) continue

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
  const pattern = /event\s+(\w+)\s*\(/g
  let match
  while ((match = pattern.exec(body)) !== null) events.push(match[1]!)
  return events
}

function extractErrors(body: string): string[] {
  const errors: string[] = []
  const pattern = /error\s+(\w+)\s*\(/g
  let match
  while ((match = pattern.exec(body)) !== null) errors.push(match[1]!)
  return errors
}

function extractModifiers(body: string): string[] {
  const modifiers: string[] = []
  const pattern = /modifier\s+(\w+)\s*\(/g
  let match
  while ((match = pattern.exec(body)) !== null) modifiers.push(match[1]!)
  return modifiers
}

function findEnclosingFunction(lines: string[], lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i--) {
    const match = lines[i]!.match(/function\s+(\w+)\s*\(/)
    if (match) return match[1]!
    const ctorMatch = lines[i]!.match(/constructor\s*\(/)
    if (ctorMatch) return "constructor"
    const receiveMatch = lines[i]!.match(/receive\s*\(\s*\)/)
    if (receiveMatch) return "receive"
    const fallbackMatch = lines[i]!.match(/fallback\s*\(/)
    if (fallbackMatch) return "fallback"
  }
  return "<top-level>"
}

function deduplicateCalls(calls: ExternalCall[]): ExternalCall[] {
  const seen = new Set<string>()
  return calls.filter((c) => {
    const key = `${c.line}:${c.target}:${c.method}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
