import { Instance } from "@/project/instance"
import { loadBuild } from "./build"
import type {
  AstNode,
  AuthIR,
  BuildInfo,
  CallIR,
  CallKind,
  ContractIR,
  FunctionIR,
  Location,
  ModifierIR,
  OperationIR,
  ProjectIR,
  ProxyIR,
  SourceInfo,
  StateVarIR,
  StorageSlotIR,
  ValueIR,
} from "./ir"
import { detectProject, fingerprint } from "./project"

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" ? value : undefined
}

function parseSrc(src?: string) {
  if (!src) return
  const [start, length] = src.split(":")
  const offset = Number(start)
  if (Number.isNaN(offset)) return
  return {
    offset,
    length: Number(length),
  }
}

function lineOffsets(content: string) {
  const result = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") result.push(i + 1)
  }
  return result
}

function lineNumber(lines: number[], offset?: number) {
  if (offset === undefined) return
  let low = 0
  let high = lines.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (lines[mid]! <= offset) {
      if (mid === lines.length - 1 || lines[mid + 1]! > offset) return mid + 1
      low = mid + 1
      continue
    }
    high = mid - 1
  }
}

function location(source: SourceInfo, node?: AstNode): Location {
  const parsed = parseSrc(node?.src)
  const lines = lineOffsets(source.content)
  return {
    file: source.path,
    full: source.full,
    line: lineNumber(lines, parsed?.offset),
    column: parsed?.offset === undefined ? undefined : parsed.offset - (lines[(lineNumber(lines, parsed.offset) ?? 1) - 1] ?? 0) + 1,
    offset: parsed?.offset,
  }
}

function walk(node: unknown, fn: (node: AstNode) => void | boolean) {
  if (!node || typeof node !== "object") return
  const current = node as AstNode
  if (typeof current.nodeType !== "string") return
  if (fn(current) === false) return
  Object.values(current).forEach((value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, fn))
      return
    }
    walk(value, fn)
  })
}

function contractNodes(source: SourceInfo) {
  const result = [] as AstNode[]
  walk(source.ast, (node) => {
    if (node.nodeType === "ContractDefinition") result.push(node)
  })
  return result
}

function functionNodes(node?: AstNode) {
  return array(object(node).nodes).filter((item) => object(item).nodeType === "FunctionDefinition") as AstNode[]
}

function modifierNodes(node?: AstNode) {
  return array(object(node).nodes).filter((item) => object(item).nodeType === "ModifierDefinition") as AstNode[]
}

function stateNodes(node?: AstNode) {
  return array(object(node).nodes).filter(
    (item) => object(item).nodeType === "VariableDeclaration" && object(item).stateVariable === true,
  ) as AstNode[]
}

function eventNames(node?: AstNode) {
  return array(object(node).nodes)
    .filter((item) => object(item).nodeType === "EventDefinition")
    .map((item) => text(object(item).name))
    .filter(Boolean) as string[]
}

function errorNames(node?: AstNode) {
  return array(object(node).nodes)
    .filter((item) => object(item).nodeType === "ErrorDefinition")
    .map((item) => text(object(item).name))
    .filter(Boolean) as string[]
}

function typeName(node?: AstNode): string {
  const typeString = text(object(object(node).typeDescriptions).typeString)
  if (typeString) return typeString
  const name = text(object(node).name)
  if (name) return name
  const path = text(object(node).namePath)
  if (path) return path
  const base = object(node).baseType
  const inner = object(node).valueType
  if (object(node).nodeType === "ArrayTypeName") return `${typeName(base as AstNode)}[]`
  if (object(node).nodeType === "Mapping") {
    return `mapping(${typeName(object(node).keyType as AstNode)} => ${typeName(inner as AstNode)})`
  }
  return ""
}

function paramTypes(node?: AstNode) {
  return array(object(node).parameters)
    .map((item) => typeName(item as AstNode))
    .filter(Boolean)
}

function returns(node?: AstNode) {
  return array(object(node).parameters)
    .map((item) => typeName(item as AstNode))
    .filter(Boolean)
}

function modifierName(node?: AstNode) {
  const name = text(object(node).modifierName && object(object(node).modifierName).name)
  if (name) return name
  const path = text(object(object(node).modifierName).namePath)
  if (path) return path.split(".").pop()!
  return text(object(node).name) ?? ""
}

function baseName(node?: AstNode) {
  const path = text(object(object(node).baseName).namePath)
  if (path) return path.split(".").pop()!
  return text(object(object(node).baseName).name) ?? ""
}

function authWords(node?: unknown) {
  const result = [] as string[]
  walk(node, (item) => {
    const name = text(item.name)
    if (name) result.push(name)
    const member = text(object(item).memberName)
    if (member) result.push(member)
  })
  return result
}

function isAuth(node?: unknown) {
  const joined = authWords(node).join(" ").toLowerCase()
  return ["msgsender", "sender", "tx", "owner", "admin", "role", "auth", "permit"].some((part) =>
    joined.includes(part),
  )
}

function contractType(node?: AstNode) {
  const kind = text(object(node).contractKind) ?? "contract"
  if (object(node).abstract === true && kind === "contract") return "abstract"
  if (kind === "interface" || kind === "library") return kind
  return "contract"
}

function contractFromType(node?: unknown) {
  const typeString = text(object(object(node).typeDescriptions).typeString) ?? ""
  const match = typeString.match(/contract\s+([A-Za-z0-9_]+)/)
  if (match) return match[1]
  const interfaceMatch = typeString.match(/type\(contract\s+([A-Za-z0-9_]+)\)/)
  return interfaceMatch?.[1]
}

function targetName(node?: unknown): string | undefined {
  const item = object(node)
  if (item.nodeType === "Identifier") return text(item.name)
  if (item.nodeType === "MemberAccess") return targetName(item.expression)
  if (item.nodeType === "FunctionCall") return targetName(item.expression)
  if (item.nodeType === "FunctionCallOptions") return targetName(item.expression)
  return undefined
}

function stateRefs(node: unknown, ids: Set<number>) {
  const result = [] as number[]
  walk(node, (item) => {
    const ref = num(object(item).referencedDeclaration)
    if (ref !== undefined && ids.has(ref)) result.push(ref)
  })
  return [...new Set(result)]
}

function makeValue(
  values: Array<{ offset: number; item: ValueIR }>,
  source: SourceInfo,
  node: AstNode,
  item: Omit<ValueIR, "line">,
) {
  values.push({
    offset: parseSrc(node.src)?.offset ?? Number.MAX_SAFE_INTEGER,
    item: {
      ...item,
      line: location(source, node).line,
    },
  })
}

function makeCall(
  calls: Array<{ offset: number; item: CallIR }>,
  source: SourceInfo,
  node: AstNode,
  item: Omit<CallIR, "line">,
) {
  calls.push({
    offset: parseSrc(node.src)?.offset ?? Number.MAX_SAFE_INTEGER,
    item: {
      ...item,
      line: location(source, node).line,
    },
  })
}

function makeAuth(
  auth: Array<{ offset: number; item: AuthIR }>,
  source: SourceInfo,
  node: AstNode,
  item: Omit<AuthIR, "line">,
) {
  auth.push({
    offset: parseSrc(node.src)?.offset ?? Number.MAX_SAFE_INTEGER,
    item: {
      ...item,
      line: location(source, node).line,
    },
  })
}

function makeOp(
  ops: Array<{ offset: number; item: OperationIR }>,
  source: SourceInfo,
  node: AstNode,
  item: Omit<OperationIR, "line">,
) {
  ops.push({
    offset: parseSrc(node.src)?.offset ?? Number.MAX_SAFE_INTEGER,
    item: {
      ...item,
      line: location(source, node).line,
    },
  })
}

function methodSelector(methods: Record<string, string>, signature: string, name: string) {
  if (methods[signature]) return methods[signature]
  const match = Object.entries(methods).find(([key]) => key.startsWith(`${name}(`))
  return match?.[1]
}

function valueAction(method: string) {
  if (method === "transfer" || method === "safeTransfer") {
    return {
      asset: "erc20",
      action: "transfer",
    } satisfies Pick<ValueIR, "asset" | "action">
  }
  if (method === "transferFrom" || method === "safeTransferFrom") {
    return {
      asset: "erc20",
      action: "transfer_from",
    } satisfies Pick<ValueIR, "asset" | "action">
  }
  if (method === "approve" || method === "safeApprove" || method === "forceApprove") {
    return {
      asset: "erc20",
      action: "approve",
    } satisfies Pick<ValueIR, "asset" | "action">
  }
  if (method === "mint" || method === "safeMint") {
    return {
      asset: "erc20",
      action: "mint",
    } satisfies Pick<ValueIR, "asset" | "action">
  }
  if (method === "burn" || method === "safeBurn") {
    return {
      asset: "erc20",
      action: "burn",
    } satisfies Pick<ValueIR, "asset" | "action">
  }
}

function show(node?: unknown): string {
  const item = object(node)
  const type = text(item.nodeType) ?? ""
  if (type === "Identifier") return text(item.name) ?? ""
  if (type === "Literal") return text(item.value) ?? text(item.hexValue) ?? ""
  if (type === "ElementaryTypeNameExpression") return typeName(item.typeName as AstNode)
  if (type === "MemberAccess") {
    const base = show(item.expression)
    const member = text(item.memberName) ?? ""
    if (!base) return member
    if (!member) return base
    return `${base}.${member}`
  }
  if (type === "IndexAccess") {
    const base = show(item.baseExpression)
    const index = show(item.indexExpression)
    if (!base) return ""
    if (!index) return `${base}[]`
    return `${base}[${index}]`
  }
  if (type === "TupleExpression") {
    return array(item.components)
      .map((value) => show(value))
      .filter(Boolean)
      .join(", ")
  }
  if (type === "BinaryOperation") {
    const left = show(item.leftExpression)
    const right = show(item.rightExpression)
    const op = text(item.operator) ?? ""
    return [left, op, right].filter(Boolean).join(" ").trim()
  }
  if (type === "UnaryOperation") {
    const op = text(item.operator) ?? ""
    const expr = show(item.subExpression)
    return `${op}${expr}`.trim()
  }
  if (type === "FunctionCall") {
    const expr = show(item.expression)
    const args = array(item.arguments)
      .map((value) => show(value))
      .filter(Boolean)
      .join(", ")
    if (!expr) return ""
    return `${expr}(${args})`
  }
  if (type === "FunctionCallOptions") {
    return show(item.expression)
  }
  if (type === "IdentifierPath") return text(item.namePath) ?? text(item.name) ?? ""
  return ""
}

function collect(node: AstNode | undefined, input: {
  source: SourceInfo
  contract: string
  projectContracts: Set<string>
  internal: Set<string>
  states: Map<number, string>
}) {
  const ops = [] as Array<{ offset: number; item: OperationIR }>
  const auth = [] as Array<{ offset: number; item: AuthIR }>
  const calls = [] as Array<{ offset: number; item: CallIR }>
  const values = [] as Array<{ offset: number; item: ValueIR }>
  let placeholder: number | undefined

  const visit = (item: AstNode) => {
    if (item.nodeType === "PlaceholderStatement") {
      placeholder = parseSrc(item.src)?.offset
      return
    }

    if (item.nodeType === "Identifier") {
      const ref = num(object(item).referencedDeclaration)
      if (ref === undefined || !input.states.has(ref)) return
      makeOp(ops, input.source, item, {
        kind: "read",
        name: input.states.get(ref)!,
      })
      return
    }

    if (item.nodeType === "MemberAccess") {
      const expr = object(item.expression)
      if (expr.nodeType === "Identifier" && text(expr.name) === "msg" && text(item.memberName) === "value") {
        makeValue(values, input.source, item, {
          asset: "eth",
          action: "receive",
        })
        makeOp(ops, input.source, item, {
          kind: "value",
          name: "msg.value",
          asset: "eth",
          action: "receive",
        })
      }
      return
    }

    if (item.nodeType === "Assignment") {
      stateRefs(object(item).leftHandSide, new Set(input.states.keys())).forEach((id) => {
        const name = input.states.get(id)
        if (!name) return
        makeOp(ops, input.source, item, {
          kind: "write",
          name,
        })
      })
      walk(object(item).rightHandSide, visit)
      return false
    }

    if (item.nodeType === "UnaryOperation") {
      const op = text(object(item).operator) ?? ""
      if (!["++", "--", "delete"].includes(op)) return
      stateRefs(object(item).subExpression, new Set(input.states.keys())).forEach((id) => {
        const name = input.states.get(id)
        if (!name) return
        makeOp(ops, input.source, item, {
          kind: "write",
          name,
        })
      })
      if (op !== "delete") walk(object(item).subExpression, visit)
      return false
    }

    if (item.nodeType !== "FunctionCall") return

    const expr = object(item.expression)
    const args = array(item.arguments)
    const names = authWords(item)

    if (expr.nodeType === "Identifier") {
      const name = text(expr.name) ?? ""
      if (name === "require" || name === "assert") {
        makeOp(ops, input.source, item, {
          kind: "check",
          name,
        })
        if (isAuth(args[0])) {
          const label = show(args[0])
          makeAuth(auth, input.source, item, {
            kind: "check",
            label: label || name,
          })
        }
        return
      }
      if (input.internal.has(name)) {
        makeCall(calls, input.source, item, {
          method: name,
          kind: "internal",
          target: input.contract,
          target_contract: input.contract,
          value: false,
        })
        makeOp(ops, input.source, item, {
          kind: "call",
          name,
          target: input.contract,
          target_contract: input.contract,
          call_kind: "internal",
        })
      }
      return
    }

    const callExpr = expr.nodeType === "FunctionCallOptions" ? object(expr.expression) : expr
    if (callExpr.nodeType !== "MemberAccess") return

    const method = text(callExpr.memberName) ?? ""
    const target = targetName(callExpr.expression)
    const target_contract = contractFromType(callExpr.expression)
    const lowLevel =
      method === "delegatecall"
        ? "delegatecall"
        : method === "staticcall"
          ? "staticcall"
          : method === "call"
            ? "low-level"
            : method === "transfer" || method === "send"
              ? "eth-transfer"
              : undefined
    const kind = (lowLevel ?? (target_contract || input.projectContracts.has(target ?? "") ? "external" : undefined)) as
      | CallKind
      | undefined
    const hasValue =
      expr.nodeType === "FunctionCallOptions" &&
      array(expr.names).some((name) => text(name) === "value")

    if (kind) {
      makeCall(calls, input.source, item, {
        method,
        kind,
        target,
        target_contract: target_contract ?? (target && input.projectContracts.has(target) ? target : undefined),
        value: hasValue || method === "transfer" || method === "send",
      })
      makeOp(ops, input.source, item, {
        kind: "call",
        name: method,
        target,
        target_contract: target_contract ?? (target && input.projectContracts.has(target) ? target : undefined),
        call_kind: kind,
      })
    }

    if (hasValue || method === "transfer" || method === "send") {
      makeValue(values, input.source, item, {
        asset: "eth",
        action: "send",
        target,
      })
      makeOp(ops, input.source, item, {
        kind: "value",
        name: method || "eth",
        asset: "eth",
        action: "send",
        target,
      })
    }

    const asset = valueAction(method)
    if (asset) {
      makeValue(values, input.source, item, {
        asset: asset.asset,
        action: asset.action,
        target,
      })
      makeOp(ops, input.source, item, {
        kind: "value",
        name: method,
        asset: asset.asset,
        action: asset.action,
        target,
      })
    }

    if (isAuth(item) && names.some((name) => /owner|admin|role|auth/i.test(name))) {
      makeAuth(auth, input.source, item, {
        kind: "check",
        label: show(item) || method || names.join("."),
      })
    }
  }

  walk(node, visit)

  const result = ops.sort((a, b) => a.offset - b.offset).map((item) => item.item)
  const seenReads = new Set<string>()
  const seenWrites = new Set<string>()
  result.forEach((item) => {
    if (item.kind === "read") seenReads.add(item.name)
    if (item.kind === "write") seenWrites.add(item.name)
  })
  return {
    operations: result,
    auth: auth.sort((a, b) => a.offset - b.offset).map((item) => item.item),
    calls: calls.sort((a, b) => a.offset - b.offset).map((item) => item.item),
    values: values.sort((a, b) => a.offset - b.offset).map((item) => item.item),
    reads: [...seenReads],
    writes: [...seenWrites],
    placeholder,
  }
}

function slotBytes(bytes?: string) {
  const value = Number(bytes ?? 0)
  return Number.isNaN(value) ? undefined : value
}

function stateVar(source: SourceInfo, node: AstNode): StateVarIR {
  return {
    id: num(node.id) ?? -1,
    name: text(node.name) ?? "",
    type: typeName(object(node).typeName as AstNode),
    visibility: text(object(node).visibility) ?? "internal",
    constant: object(node).constant === true,
    immutable: object(node).mutability === "immutable",
    location: location(source, node),
  }
}

function functionKind(node: AstNode): FunctionIR["kind"] {
  const kind = text(object(node).kind) ?? "function"
  if (kind === "constructor" || kind === "fallback" || kind === "receive") return kind
  return "function"
}

function proxyHints(input: {
  contract: string
  bases: string[]
  functions: string[]
  storage: StorageSlotIR[]
  fallback_delegatecall: boolean
}) {
  const result = [] as ProxyIR[]
  const bases = [input.contract, ...input.bases].join(" ")
  if (/UUPS|ERC1967/i.test(bases)) {
    result.push({
      kind: "uups",
      note: "UUPS/1967 inheritance detected",
    })
  }
  if (/TransparentUpgradeableProxy|ProxyAdmin/i.test(bases)) {
    result.push({
      kind: "transparent",
      note: "transparent proxy inheritance detected",
    })
  }
  if (/Beacon/i.test(bases)) {
    result.push({
      kind: "beacon",
      note: "beacon upgrade pattern detected",
    })
  }
  if (/Upgradeable|Initializable/i.test(bases) && !result.some((item) => item.kind === "upgradeable")) {
    result.push({
      kind: "upgradeable",
      note: "upgradeable inheritance detected",
    })
  }
  if (input.fallback_delegatecall) {
    result.push({
      kind: "delegate-proxy",
      note: "fallback delegatecall detected",
    })
  }
  if (input.storage.some((slot) => /__gap|gap/.test(slot.label))) {
    result.push({
      kind: "upgradeable",
      note: "storage gap present",
    })
  }
  if (input.functions.some((name) => /upgradeTo|upgradeToAndCall/i.test(name))) {
    result.push({
      kind: "upgradeable",
      note: "upgrade entrypoint detected",
    })
  }
  return result
}

function fallbackDelegatecall(functions: FunctionIR[]) {
  return functions.some(
    (fn) =>
      fn.kind === "fallback" && fn.calls.some((call) => call.kind === "delegatecall"),
  )
}

function unique<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const value = key(item)
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

function resolveContract(build: BuildInfo, contract: BuildInfo["contracts"][number]) {
  const source = build.sources[contract.source]
  if (!source) return
  return contractNodes(source).find((node) => text(node.name) === contract.name)
}

const cache = Instance.state(() => ({
  key: "",
  value: undefined as Promise<ProjectIR> | undefined,
}))

export async function analyzeProject(directory = Instance.directory): Promise<ProjectIR> {
  const project = await detectProject(directory)
  const key = await fingerprint(project)
  const state = cache()
  if (state.key === key && state.value) return state.value

  state.key = key
  state.value = (async () => {
    const build = await loadBuild(project)
    const resolved = build.contracts
      .map((contract) => {
        const node = resolveContract(build, contract)
        if (!node) return
        const source = build.sources[contract.source]
        if (!source) return
        return {
          build: contract,
          node,
          source,
          states: stateNodes(node),
          functions: functionNodes(node),
          modifiers: modifierNodes(node),
          events: eventNames(node),
          errors: errorNames(node),
        }
      })
      .filter(Boolean) as Array<{
      build: BuildInfo["contracts"][number]
      node: AstNode
      source: SourceInfo
      states: AstNode[]
      functions: AstNode[]
      modifiers: AstNode[]
      events: string[]
      errors: string[]
    }>

    const nodeNames = new Map<number, string>()
    resolved.forEach((item) => {
      const id = num(item.node.id)
      if (id !== undefined) nodeNames.set(id, item.build.name)
    })

    const functionNames = new Map<string, Set<string>>()
    resolved.forEach((item) => {
      functionNames.set(
        item.build.name,
        new Set(
          item.functions
            .map((fn) => text(fn.name) || (text(object(fn).kind) === "constructor" ? "constructor" : ""))
            .filter(Boolean) as string[],
        ),
      )
    })

    const contractStates = new Map<string, StateVarIR[]>()
    const stateIds = new Map<number, string>()
    resolved.forEach((item) => {
      const states = item.states.map((node) => stateVar(item.source, node))
      contractStates.set(item.build.name, states)
      states.forEach((state) => {
        stateIds.set(state.id, state.name)
      })
    })

    const contracts = resolved.map((item) => {
      const bases = array(object(item.node).baseContracts).map((base) => baseName(base as AstNode)).filter(Boolean) as string[]
      const linearized_bases = array(object(item.node).linearizedBaseContracts)
        .map((id) => nodeNames.get(Number(id)))
        .filter(Boolean) as string[]
      const chain = linearized_bases.length ? linearized_bases : [item.build.name, ...bases]
      const inheritedStates = new Map<number, string>()
      chain.forEach((name) => {
        contractStates.get(name)?.forEach((state) => inheritedStates.set(state.id, state.name))
      })
      const internal = new Set<string>()
      chain.forEach((name) => {
        functionNames.get(name)?.forEach((fn) => internal.add(fn))
      })
      const projectContracts = new Set(resolved.map((entry) => entry.build.name))

      const modifiers = item.modifiers.map((node) => {
        const name = text(node.name) ?? ""
        const data = collect(node, {
          source: item.source,
          contract: item.build.name,
          projectContracts,
          internal,
          states: inheritedStates,
        })
        const split = data.placeholder === undefined ? undefined : lineNumber(lineOffsets(item.source.content), data.placeholder)
        const before = split === undefined ? data.operations : data.operations.filter((op) => (op.line ?? Number.MAX_SAFE_INTEGER) <= split)
        const after = split === undefined ? [] : data.operations.filter((op) => (op.line ?? 0) > split)
        return {
          id: `${item.build.name}.${name}`,
          name,
          location: location(item.source, node),
          operations: data.operations,
          checks: [
            ...data.auth,
            ...(/only|owner|admin|role|auth/i.test(name)
              ? [
                  {
                    kind: "modifier" as const,
                    label: name,
                    line: location(item.source, node).line,
                  },
                ]
              : []),
          ],
          before,
          after,
        } satisfies ModifierIR
      })

      const functions = item.functions.map((node) => {
        const kind = functionKind(node)
        const name = kind === "function" ? text(node.name) ?? "" : kind
        const parameters = paramTypes(object(node).parameters as AstNode)
        const signature = kind === "function" ? `${name}(${parameters.join(",")})` : name
        const data = collect(object(node).body as AstNode | undefined, {
          source: item.source,
          contract: item.build.name,
          projectContracts,
          internal,
          states: inheritedStates,
        })
        const modifierNames = array(object(node).modifiers)
          .map((entry) => modifierName(entry as AstNode))
          .filter(Boolean) as string[]
        const modifierChecks = modifierNames
          .map((name) => modifiers.find((item) => item.name === name))
          .filter(Boolean) as ModifierIR[]
        const expanded = modifierChecks.flatMap((item) => item.before).concat(data.operations, modifierChecks.flatMap((item) => item.after))
        const reads = new Set(data.reads)
        const writes = new Set(data.writes)
        expanded.forEach((item) => {
          if (item.kind === "read") reads.add(item.name)
          if (item.kind === "write") writes.add(item.name)
        })
        const auth = [
          ...modifierChecks.flatMap((item) => item.checks),
          ...data.auth,
        ]
        if (modifierNames.some((name) => /only|owner|admin|role|auth/i.test(name))) {
          modifierNames
            .filter((name) => /only|owner|admin|role|auth/i.test(name))
            .forEach((name) =>
              auth.push({
                kind: "modifier",
                label: name,
                line: location(item.source, node).line,
              }),
            )
        }

        return {
          id: `${item.build.name}.${signature}`,
          name,
          kind,
          signature,
          selector: methodSelector(item.build.method_ids, signature, name),
          visibility: (text(object(node).visibility) ?? "internal") as FunctionIR["visibility"],
          mutability: (text(object(node).stateMutability) ?? "nonpayable") as FunctionIR["mutability"],
          payable: text(object(node).stateMutability) === "payable",
          modifiers: modifierNames,
          parameters,
          returns: returns(object(node).returnParameters as AstNode),
          reads: [...reads],
          writes: [...writes],
          calls: data.calls,
          auth,
          values: data.values,
          operations: expanded,
          location: location(item.source, node),
        } satisfies FunctionIR
      })

      const storage = item.build.storage.storage.map((slot) => {
        const meta = item.build.storage.types[slot.type]
        return {
          label: slot.label,
          slot: slot.slot,
          offset: slot.offset,
          type: meta?.label ?? slot.type,
          bytes: slotBytes(meta?.numberOfBytes),
          encoding: meta?.encoding,
          contract: slot.contract,
        } satisfies StorageSlotIR
      })

      const fallback_delegatecall = fallbackDelegatecall(functions)
      const proxies = proxyHints({
        contract: item.build.name,
        bases,
        functions: functions.map((fn) => fn.name),
        storage,
        fallback_delegatecall,
      })

      return {
        id: item.build.id,
        node_id: num(item.node.id) ?? -1,
        name: item.build.name,
        kind: contractType(item.node),
        source: item.build.source,
        full: item.build.full,
        bases,
        linearized_bases: chain,
        functions,
        modifiers,
        state: contractStates.get(item.build.name) ?? [],
        storage,
        events: item.events,
        errors: item.errors,
        proxies,
        initializers: functions
          .map((fn) => fn.name)
          .filter((name) => /initialize|reinitialize/i.test(name)),
        fallback_delegatecall,
        location: location(item.source, item.node),
      } satisfies ContractIR
    })

    const lookup = new Map(contracts.map((contract) => [contract.name, contract]))
    const fns = new Map(
      contracts.flatMap((contract) =>
        contract.functions.map((fn) => [`${contract.name}:${fn.name}`, fn] as const),
      ),
    )
    const cache = new Map<string, FunctionIR>()

    const resolve = (contract: ContractIR, method: string) =>
      [contract.name, ...contract.linearized_bases]
        .filter((name, idx, list) => list.indexOf(name) === idx)
        .map((name) => fns.get(`${name}:${method}`))
        .find(Boolean)

    const expand = (contract: ContractIR, fn: FunctionIR, seen = new Set<string>()): FunctionIR => {
      const key = `${contract.name}:${fn.id}`
      if (cache.has(key)) return cache.get(key)!
      if (seen.has(key)) return fn

      const next = new Set(seen).add(key)
      const ops = [] as OperationIR[]
      const nested = fn.calls
        .filter((call) => call.kind === "internal")
        .map((call) => ({
          call,
          fn: resolve(contract, call.method),
        }))

      fn.operations.forEach((op) => {
        ops.push(op)
        if (op.kind !== "call" || op.call_kind !== "internal") return
        const inner = resolve(contract, op.name)
        if (!inner) return
        ops.push(...expand(contract, inner, next).operations)
      })

      const summaries = nested
        .map((item) => item.fn && expand(contract, item.fn, next))
        .filter(Boolean) as FunctionIR[]
      const result = {
        ...fn,
        operations: ops,
        reads: [...new Set(ops.filter((item) => item.kind === "read").map((item) => item.name))],
        writes: [...new Set(ops.filter((item) => item.kind === "write").map((item) => item.name))],
        calls: unique(
          [fn.calls, ...summaries.map((item) => item.calls)].flat(),
          (item) => [item.kind, item.method, item.target_contract ?? item.target ?? "", item.line ?? "", item.value ? 1 : 0].join(":"),
        ),
        auth: unique(
          [fn.auth, ...summaries.map((item) => item.auth)].flat(),
          (item) => [item.kind, item.label].join(":"),
        ),
        values: unique(
          [fn.values, ...summaries.map((item) => item.values)].flat(),
          (item) => [item.asset, item.action, item.target ?? "", item.line ?? ""].join(":"),
        ),
      } satisfies FunctionIR
      cache.set(key, result)
      return result
    }

    const expanded = contracts.map((contract) => {
      const functions = contract.functions.map((fn) => expand(contract, fn))
      return {
        ...contract,
        functions,
        fallback_delegatecall: fallbackDelegatecall(functions),
      } satisfies ContractIR
    })

    return {
      project,
      sources: build.sources,
      contracts: expanded,
    } satisfies ProjectIR
  })()

  return state.value
}

export function findContractsByPath(ir: ProjectIR, file: string) {
  const full = file.replaceAll("\\", "/")
  return ir.contracts.filter((contract) => contract.full.replaceAll("\\", "/") === full || contract.source === full)
}

export function findContract(ir: ProjectIR, input: { name?: string; file?: string }) {
  if (input.file) {
    const matches = findContractsByPath(ir, input.file)
    if (!input.name) return matches[0]
    return matches.find((contract) => contract.name === input.name)
  }
  if (!input.name) return
  return ir.contracts.find((contract) => contract.name === input.name)
}
