export type Framework = "foundry"

export type ProjectInfo = {
  framework: Framework
  root: string
  config: string
  out: string
  cache: string
  build_info: string[]
  source_dirs: string[]
  test_dirs: string[]
  script_dirs: string[]
  lib_dirs: string[]
}

export type AstNode = {
  nodeType: string
  id?: number
  name?: string
  src?: string
  [key: string]: unknown
}

export type SourceInfo = {
  path: string
  full: string
  id?: number
  ast?: AstNode
  content: string
}

export type BuildContract = {
  id: string
  name: string
  source: string
  full: string
  artifact: string
  ast?: AstNode
  abi: unknown[]
  method_ids: Record<string, string>
  storage: {
    storage: Array<{
      label: string
      slot: string
      offset: number
      type: string
      contract?: string
    }>
    types: Record<
      string,
      {
        encoding?: string
        label?: string
        numberOfBytes?: string
      }
    >
  }
}

export type BuildInfo = {
  project: ProjectInfo
  sources: Record<string, SourceInfo>
  contracts: BuildContract[]
}

export type Location = {
  file: string
  full: string
  line?: number
  column?: number
  offset?: number
}

export type StateVarIR = {
  id: number
  name: string
  type: string
  visibility: string
  constant: boolean
  immutable: boolean
  location: Location
}

export type CallKind =
  | "internal"
  | "external"
  | "low-level"
  | "delegatecall"
  | "staticcall"
  | "eth-transfer"

export type CallIR = {
  target?: string
  target_contract?: string
  method: string
  kind: CallKind
  line?: number
  value: boolean
}

export type AuthIR = {
  kind: "modifier" | "check" | "helper"
  label: string
  line?: number
}

export type ValueIR = {
  asset: "eth" | "erc20" | "erc721" | "unknown"
  action: "receive" | "send" | "transfer" | "transfer_from" | "approve" | "mint" | "burn"
  target?: string
  line?: number
}

export type OperationIR = {
  kind: "read" | "write" | "call" | "check" | "value"
  name: string
  line?: number
  target?: string
  target_contract?: string
  call_kind?: CallKind
  asset?: ValueIR["asset"]
  action?: ValueIR["action"]
}

export type ModifierIR = {
  id: string
  name: string
  location: Location
  operations: OperationIR[]
  checks: AuthIR[]
  before: OperationIR[]
  after: OperationIR[]
}

export type FunctionIR = {
  id: string
  name: string
  kind: "function" | "constructor" | "fallback" | "receive"
  signature: string
  selector?: string
  visibility: "public" | "external" | "internal" | "private"
  mutability: "view" | "pure" | "payable" | "nonpayable"
  payable: boolean
  modifiers: string[]
  parameters: string[]
  returns: string[]
  reads: string[]
  writes: string[]
  calls: CallIR[]
  auth: AuthIR[]
  values: ValueIR[]
  operations: OperationIR[]
  location: Location
}

export type StorageSlotIR = {
  label: string
  slot: string
  offset: number
  type: string
  bytes?: number
  encoding?: string
  contract?: string
}

export type ProxyIR = {
  kind: "uups" | "transparent" | "beacon" | "delegate-proxy" | "upgradeable"
  line?: number
  note: string
}

export type ContractIR = {
  id: string
  node_id: number
  name: string
  kind: "contract" | "interface" | "library" | "abstract"
  source: string
  full: string
  bases: string[]
  linearized_bases: string[]
  functions: FunctionIR[]
  modifiers: ModifierIR[]
  state: StateVarIR[]
  storage: StorageSlotIR[]
  events: string[]
  errors: string[]
  proxies: ProxyIR[]
  initializers: string[]
  fallback_delegatecall: boolean
  location: Location
}

export type ProjectIR = {
  project: ProjectInfo
  contracts: ContractIR[]
  sources: Record<string, SourceInfo>
}
