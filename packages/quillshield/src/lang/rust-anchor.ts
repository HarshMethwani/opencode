import type {
  AccountField,
  ContractMetadata,
  ExternalCall,
  FunctionInfo,
  LanguageParser,
  StateVariable,
  StorageVar,
} from "./types"

export const AnchorParser: LanguageParser = {
  detect(content: string): boolean {
    return content.includes("#[program]") || content.includes("declare_id!") || content.includes("use anchor_lang")
  },

  extractMetadata(content: string): ContractMetadata[] {
    const contracts: ContractMetadata[] = []
    const lines = content.split("\n")
    const imports: string[] = []

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
        errors: extractErrorCodes(content),
        imports,
        modifiers: [],
      })
    }

    // Find #[derive(Accounts)] structs — these define instruction account requirements
    const accountStructs = extractAccountStructs(content)
    for (const acctStruct of accountStructs) {
      contracts.push({
        language: "anchor",
        name: acctStruct.name,
        type: "module",
        inherits: [],
        implements: [],
        functions: [],
        stateVariables: acctStruct.fields,
        events: [],
        errors: [],
        imports: [],
        modifiers: [],
        accounts: acctStruct.accounts,
      })
    }

    // Find #[account] data structs (program state)
    const accountDataPattern = /#\[account\]\s*(?:#\[.*\]\s*)*pub\s+struct\s+(\w+)/g
    let match
    while ((match = accountDataPattern.exec(content)) !== null) {
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
      const lineNum = i + 1

      // CpiContext::new / CpiContext::new_with_signer
      const cpiCtxMatch = line.match(/CpiContext::new(_with_signer)?\s*\(/)
      if (cpiCtxMatch) {
        calls.push({
          target: "CpiContext",
          method: cpiCtxMatch[1] ? "new_with_signer" : "new",
          callingFunction: findEnclosingFn(lines, i),
          line: lineNum,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }

      // anchor_spl::token::transfer / anchor_spl::token::mint_to / etc.
      const splMatch = line.match(/anchor_spl::(\w+)::(\w+)\s*\(/)
      if (splMatch) {
        calls.push({
          target: `anchor_spl::${splMatch[1]}`,
          method: splMatch[2]!,
          callingFunction: findEnclosingFn(lines, i),
          line: lineNum,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }

      // system_program::create_account, system_instruction::transfer, etc.
      const sysMatch = line.match(/(system_program|system_instruction|spl_token)::(\w+)\s*\(/)
      if (sysMatch) {
        calls.push({
          target: sysMatch[1]!,
          method: sysMatch[2]!,
          callingFunction: findEnclosingFn(lines, i),
          line: lineNum,
          isDelegatecall: false,
          isStaticcall: false,
        })
      }

      // invoke() / invoke_signed()
      const invokeMatch = line.match(/(invoke_signed|invoke)\s*\(/)
      if (invokeMatch) {
        calls.push({
          target: "solana_program",
          method: invokeMatch[1]!,
          callingFunction: findEnclosingFn(lines, i),
          line: lineNum,
          isDelegatecall: false,
          isStaticcall: invokeMatch[1] === "invoke",
        })
      }

      // Generic CPI pattern: some_module::some_cpi_fn(ctx)
      const genericCpiMatch = line.match(/(\w+)::(\w+)\s*\(\s*(?:CpiContext|ctx)/)
      if (genericCpiMatch) {
        const target = genericCpiMatch[1]!
        const method = genericCpiMatch[2]!
        // Skip standard Rust patterns
        if (!["Result", "Ok", "Err", "Some", "None", "Vec", "String", "Box", "msg", "require"].includes(target)) {
          const key = `${lineNum}:${target}:${method}`
          if (!calls.some((c) => `${c.line}:${c.target}:${c.method}` === key)) {
            calls.push({
              target,
              method,
              callingFunction: findEnclosingFn(lines, i),
              line: lineNum,
              isDelegatecall: false,
              isStaticcall: false,
            })
          }
        }
      }

      // token::transfer, token::mint_to, etc. (anchor shorthand)
      const tokenShortMatch = line.match(/\b(token|associated_token)::(\w+)\s*\(/)
      if (tokenShortMatch) {
        const key = `${lineNum}:${tokenShortMatch[1]}:${tokenShortMatch[2]}`
        if (!calls.some((c) => `${c.line}:${c.target}:${c.method}` === key)) {
          calls.push({
            target: tokenShortMatch[1]!,
            method: tokenShortMatch[2]!,
            callingFunction: findEnclosingFn(lines, i),
            line: lineNum,
            isDelegatecall: false,
            isStaticcall: false,
          })
        }
      }
    }

    return calls
  },

  extractStorage(content: string): StorageVar[] {
    // Anchor programs store state in accounts, not traditional storage.
    // Extract #[account] struct fields as "storage"
    const vars: StorageVar[] = []
    const pattern = /#\[account\]\s*(?:#\[.*\]\s*)*pub\s+struct\s+\w+/g
    let match
    let slot = 0
    while ((match = pattern.exec(content)) !== null) {
      const fields = extractStructFields(content, match.index! + match[0].length)
      for (const field of fields) {
        vars.push({ name: field.name, type: field.type, slot: slot++ })
      }
    }
    return vars
  },
}

/**
 * Extract #[derive(Accounts)] structs with full constraint parsing.
 * This is the core of Anchor security analysis.
 */
function extractAccountStructs(
  content: string,
): Array<{ name: string; fields: StateVariable[]; accounts: AccountField[] }> {
  const results: Array<{ name: string; fields: StateVariable[]; accounts: AccountField[] }> = []

  // Find #[derive(Accounts)] structs
  const derivePattern = /#\[derive\(Accounts\)\]\s*(?:#\[.*\]\s*)*pub\s+struct\s+(\w+)/g
  let match
  while ((match = derivePattern.exec(content)) !== null) {
    const name = match[1]!
    const startIdx = content.indexOf("{", match.index! + match[0].length)
    if (startIdx === -1) continue

    const body = extractBraceBody(content, startIdx + 1)
    const accounts = parseAccountFields(body)
    const fields = accounts.map((a) => ({
      name: a.name,
      type: a.type,
      visibility: "public" as const,
      constant: false,
      immutable: false,
    }))

    results.push({ name, fields, accounts })
  }

  return results
}

/**
 * Parse account fields from a #[derive(Accounts)] struct body.
 * Extracts constraints from #[account(...)] attributes on each field.
 */
function parseAccountFields(body: string): AccountField[] {
  const accounts: AccountField[] = []

  // Split into field blocks: each field may have multiple #[account(...)] lines before it
  const fieldPattern = /((?:\s*#\[account\([^\]]*\)\]\s*)*)\s*(?:#\[.*\]\s*)*pub\s+(\w+)\s*:\s*([^,\n]+)/g
  let match
  while ((match = fieldPattern.exec(body)) !== null) {
    const constraintBlock = match[1]!
    const fieldName = match[2]!
    const fieldType = match[3]!.trim().replace(/,$/, "").trim()

    // Parse the account type
    const accountType = classifyAccountType(fieldType)
    const innerType = extractInnerType(fieldType)

    // Parse all #[account(...)] constraints
    const constraints = parseConstraints(constraintBlock)

    const isMut = constraints.has("mut") || constraints.has("init") || constraints.has("init_if_needed")
    const isSigner = accountType === "signer" || constraints.has("signer")
    const isInit = constraints.has("init") || constraints.has("init_if_needed")

    // Extract close target
    const closeValue = constraints.get("close")
    const isClose = closeValue ? closeValue : false

    // Extract has_one constraints
    const hasOne: string[] = []
    for (const [key, value] of constraints) {
      if (key === "has_one") hasOne.push(value || "")
    }

    // Extract PDA seeds
    const seeds = extractSeeds(constraintBlock)
    const hasBump = constraints.has("bump")

    // Collect raw constraint expressions
    const rawConstraints: string[] = []
    for (const [key, value] of constraints) {
      if (key === "constraint") rawConstraints.push(value || "")
    }

    accounts.push({
      name: fieldName,
      type: fieldType,
      accountType,
      innerType: innerType || undefined,
      isMut,
      isSigner,
      isInit,
      isClose,
      hasOne,
      seeds,
      hasBump,
      constraints: rawConstraints,
    })
  }

  return accounts
}

function classifyAccountType(type: string): AccountField["accountType"] {
  if (/^Signer\b/.test(type)) return "signer"
  if (/^Account\b/.test(type) || /^InterfaceAccount\b/.test(type)) return "account"
  if (/^UncheckedAccount\b/.test(type) || /^AccountInfo\b/.test(type)) return "unchecked"
  if (/^Program\b/.test(type)) return "program"
  if (/^SystemAccount\b/.test(type) || /^System\b/.test(type)) return "system"
  // Box<Account<...>> is also a validated account
  if (/^Box<\s*Account\b/.test(type) || /^Box<\s*InterfaceAccount\b/.test(type)) return "account"
  return "other"
}

function extractInnerType(type: string): string | null {
  // Account<'info, Vault> -> Vault
  const accountMatch = type.match(/(?:Account|InterfaceAccount)<\s*'[^,]+,\s*(\w+)\s*>/)
  if (accountMatch) return accountMatch[1]!
  // Box<Account<'info, Vault>> -> Vault
  const boxMatch = type.match(/Box<\s*(?:Account|InterfaceAccount)<\s*'[^,]+,\s*(\w+)\s*>>/)
  if (boxMatch) return boxMatch[1]!
  // Program<'info, System> -> System
  const progMatch = type.match(/Program<\s*'[^,]+,\s*(\w+)\s*>/)
  if (progMatch) return progMatch[1]!
  return null
}

/**
 * Parse constraints from #[account(...)] attribute blocks.
 * Returns a Map where keys can repeat (e.g., multiple has_one).
 * Uses a multi-map approach via array of tuples.
 */
function parseConstraints(block: string): Map<string, string> {
  const constraints = new Map<string, string>()

  // Find all #[account(...)] blocks
  const attrPattern = /#\[account\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g
  let attrMatch
  while ((attrMatch = attrPattern.exec(block)) !== null) {
    const inner = attrMatch[1]!

    // Split by comma, but respect nested parens
    const parts = splitRespectingParens(inner)

    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue

      // Simple flag: mut, init, signer, bump
      if (/^(mut|init|init_if_needed|signer|bump|zero|rent_exempt)$/.test(trimmed)) {
        constraints.set(trimmed, "true")
        continue
      }

      // Key = value: has_one = authority, close = target, etc.
      const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/)
      if (kvMatch) {
        constraints.set(kvMatch[1]!, kvMatch[2]!.trim())
        continue
      }

      // Constraint expression: constraint = expr @ ErrorCode
      if (trimmed.startsWith("constraint")) {
        const exprMatch = trimmed.match(/^constraint\s*=\s*(.+)$/)
        if (exprMatch) constraints.set("constraint", exprMatch[1]!.trim())
        continue
      }

      // Token/mint constraints: token::authority, token::mint, etc.
      if (trimmed.includes("::")) {
        constraints.set(trimmed.split("=")[0]!.trim(), trimmed.split("=")[1]?.trim() ?? "")
      }
    }
  }

  return constraints
}

function splitRespectingParens(input: string): string[] {
  const parts: string[] = []
  let current = ""
  let depth = 0

  for (const ch of input) {
    if (ch === "(" || ch === "<" || ch === "[") depth++
    if (ch === ")" || ch === ">" || ch === "]") depth--
    if (ch === "," && depth === 0) {
      parts.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)
  return parts
}

/**
 * Extract PDA seeds from #[account(seeds = [...])] constraints.
 */
function extractSeeds(block: string): string[] {
  const seedsMatch = block.match(/seeds\s*=\s*\[([^\]]*)\]/)
  if (!seedsMatch) return []

  return splitRespectingParens(seedsMatch[1]!)
    .map((s) => s.trim())
    .filter(Boolean)
}

function extractBraceBody(content: string, startIdx: number): string {
  let depth = 1
  let i = startIdx
  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++
    if (content[i] === "}") depth--
    i++
  }
  return content.slice(startIdx, i - 1)
}

function extractProgramFunctions(content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = []

  // Find the #[program] module body
  const programStart = content.indexOf("#[program]")
  if (programStart === -1) return functions

  const modStart = content.indexOf("{", programStart)
  if (modStart === -1) return functions

  const body = extractBraceBody(content, modStart + 1)

  const funcPattern = /pub\s+fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?\s*\{/g
  let match
  while ((match = funcPattern.exec(body)) !== null) {
    const name = match[1]!
    const params = match[2]!.trim()
    const returns = match[3]?.trim() ?? ""

    // Extract the context type to link instruction to its Accounts struct
    const ctxMatch = params.match(/Context<\s*(?:'[^,]*,\s*)?(\w+)\s*>/)
    const contextType = ctxMatch?.[1] ?? ""

    functions.push({
      name,
      visibility: "public",
      mutability: params.includes("&mut") ? "nonpayable" : "view",
      modifiers: contextType ? [contextType] : [],
      parameters: params,
      returns,
    })
  }

  return functions
}

function extractStructFields(content: string, startIdx: number): StateVariable[] {
  const fields: StateVariable[] = []
  let i = startIdx
  while (i < content.length && content[i] !== "{") i++
  if (i >= content.length) return fields
  i++

  const body = extractBraceBody(content, i)
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
  while ((match = pattern.exec(content)) !== null) events.push(match[1]!)
  return events
}

function extractErrorCodes(content: string): string[] {
  const errors: string[] = []
  // Extract individual error variants from #[error_code] enums
  const enumPattern = /#\[error_code\]\s*pub\s+enum\s+\w+\s*\{([^}]+)\}/g
  let match
  while ((match = enumPattern.exec(content)) !== null) {
    const body = match[1]!
    const variantPattern = /(\w+)/g
    let v
    while ((v = variantPattern.exec(body)) !== null) {
      const name = v[1]!
      // Skip #[msg("...")] attribute content
      if (name === "msg") continue
      if (/^[A-Z]/.test(name)) errors.push(name)
    }
  }
  // Also capture the enum name itself
  const enumNamePattern = /#\[error_code\]\s*pub\s+enum\s+(\w+)/g
  while ((match = enumNamePattern.exec(content)) !== null) {
    if (!errors.includes(match[1]!)) errors.unshift(match[1]!)
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
