import type { ContractMetadata, ExternalCall, FunctionInfo, LanguageParser, StateVariable, StorageVar } from "./types"

export const VyperParser: LanguageParser = {
  detect(content: string): boolean {
    return /^#\s*@version/m.test(content) || /^@external/m.test(content) || /^@internal/m.test(content)
  },

  extractMetadata(content: string): ContractMetadata[] {
    const lines = content.split("\n")
    const functions: FunctionInfo[] = []
    const stateVariables: StateVariable[] = []
    const events: string[] = []
    const imports: string[] = []

    // Extract imports
    for (const line of lines) {
      const importMatch = line.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/)
      if (importMatch) imports.push(importMatch[0].trim())
    }

    // Extract events
    for (const line of lines) {
      const eventMatch = line.match(/^event\s+(\w+):/)
      if (eventMatch) events.push(eventMatch[1]!)
    }

    // Extract interfaces used
    const interfaces: string[] = []
    for (const line of lines) {
      const implMatch = line.match(/^implements:\s+(.+)/)
      if (implMatch) interfaces.push(...implMatch[1]!.split(",").map((s) => s.trim()))
    }

    // Extract state variables (top-level assignments without def/event/interface)
    for (const line of lines) {
      const varMatch = line.match(/^(\w+):\s+(public\s*\()?\s*(\w[\w\[\],\s]*)/)
      if (varMatch && !["def", "event", "interface", "struct", "from", "import", "#", "@"].some((k) => line.startsWith(k))) {
        const name = varMatch[1]!
        const isPublic = !!varMatch[2]
        const type = varMatch[3]!.replace(/\)$/, "").trim()
        stateVariables.push({
          name,
          type,
          visibility: isPublic ? "public" : "internal",
          constant: line.includes("constant("),
          immutable: line.includes("immutable("),
        })
      }
    }

    // Extract functions
    let currentDecorators: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!

      if (line.startsWith("@")) {
        currentDecorators.push(line.trim().replace("@", ""))
        continue
      }

      const funcMatch = line.match(/^def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+))?:/)
      if (funcMatch) {
        const name = funcMatch[1]!
        const params = funcMatch[2]!.trim()
        const returns = funcMatch[3]?.trim() ?? ""

        let visibility: FunctionInfo["visibility"] = "internal"
        if (currentDecorators.includes("external")) visibility = "external"
        if (currentDecorators.includes("internal")) visibility = "internal"

        let mutability: FunctionInfo["mutability"] = "nonpayable"
        if (currentDecorators.includes("view")) mutability = "view"
        if (currentDecorators.includes("pure")) mutability = "pure"
        if (currentDecorators.includes("payable")) mutability = "payable"

        const modifiers = currentDecorators.filter(
          (d) => !["external", "internal", "view", "pure", "payable", "nonreentrant"].includes(d.split("(")[0]!),
        )

        if (currentDecorators.some((d) => d.startsWith("nonreentrant"))) modifiers.push("nonreentrant")

        functions.push({ name, visibility, mutability, modifiers, parameters: params, returns })
        currentDecorators = []
      } else if (line.trim() && !line.startsWith("#") && !line.startsWith(" ")) {
        currentDecorators = []
      }
    }

    // Get contract name from filename or first comment
    const nameMatch = content.match(/#\s*@title\s+(.+)/)
    const name = nameMatch?.[1]?.trim() ?? "VyperContract"

    return [
      {
        language: "vyper",
        name,
        type: "contract",
        inherits: [],
        implements: interfaces,
        functions,
        stateVariables,
        events,
        errors: [],
        imports,
        modifiers: [],
      },
    ]
  },

  extractCalls(content: string): ExternalCall[] {
    const calls: ExternalCall[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      // Interface calls: InterfaceName(address).method()
      const callMatch = line.match(/(\w+)\(([^)]*)\)\.(\w+)\(/)
      if (callMatch && /^[A-Z]/.test(callMatch[1]!)) {
        calls.push({
          target: `${callMatch[1]}(${callMatch[2]})`,
          method: callMatch[3]!,
          callingFunction: findEnclosingDef(lines, i),
          line: i + 1,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }

      // raw_call
      if (line.includes("raw_call(")) {
        calls.push({
          target: "raw_call",
          method: "call",
          callingFunction: findEnclosingDef(lines, i),
          line: i + 1,
          isDelegatecall: line.includes("is_delegate_call=True"),
          isStaticcall: line.includes("is_static_call=True"),
        })
      }
    }

    return calls
  },

  extractStorage(content: string): StorageVar[] {
    const vars: StorageVar[] = []
    const lines = content.split("\n")
    let slot = 0

    for (const line of lines) {
      const varMatch = line.match(/^(\w+):\s+(?:public\s*\()?\s*(\w[\w\[\],\s]*)/)
      if (varMatch && !["def", "event", "interface", "struct", "from", "import", "#", "@"].some((k) => line.startsWith(k))) {
        if (line.includes("constant(") || line.includes("immutable(")) continue
        vars.push({ name: varMatch[1]!, type: varMatch[2]!.replace(/\)$/, "").trim(), slot: slot++ })
      }
    }

    return vars
  },
}

function findEnclosingDef(lines: string[], lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i--) {
    const match = lines[i]!.match(/^def\s+(\w+)\s*\(/)
    if (match) return match[1]!
  }
  return "<module>"
}
