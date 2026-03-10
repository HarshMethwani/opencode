export interface ContractMetadata {
  language: string
  name: string
  type: "contract" | "interface" | "library" | "abstract" | "module" | "program"
  inherits: string[]
  implements: string[]
  functions: FunctionInfo[]
  stateVariables: StateVariable[]
  events: string[]
  errors: string[]
  imports: string[]
  modifiers: string[]
  accounts?: AccountField[]
  suiObjects?: SuiObjectInfo[]
  suiModule?: SuiModuleInfo
}

export interface FunctionInfo {
  name: string
  visibility: "public" | "external" | "internal" | "private"
  mutability: "view" | "pure" | "payable" | "nonpayable"
  modifiers: string[]
  parameters: string
  returns: string
}

export interface StateVariable {
  name: string
  type: string
  visibility: "public" | "private" | "internal"
  constant: boolean
  immutable: boolean
}

export interface AccountField {
  name: string
  type: string
  accountType: "signer" | "account" | "unchecked" | "program" | "system" | "other"
  innerType?: string
  isMut: boolean
  isSigner: boolean
  isInit: boolean
  isClose: string | false
  hasOne: string[]
  seeds: string[]
  hasBump: boolean
  constraints: string[]
}

export interface ExternalCall {
  target: string
  method: string
  callingFunction: string
  line: number
  isDelegatecall: boolean
  isStaticcall: boolean
}

export interface StorageVar {
  name: string
  type: string
  slot: number | string
  offset?: number
  size?: number
}

export interface SuiObjectInfo {
  name: string
  abilities: string[]
  hasKey: boolean
  hasStore: boolean
  hasCopy: boolean
  hasDrop: boolean
  fields: { name: string; type: string }[]
}

export interface SuiModuleInfo {
  hasInit: boolean
  hasOTW: boolean
  otwType: string | null
  capabilities: string[]
  sharedObjects: string[]
  entryFunctions: string[]
  dynamicFieldOps: string[]
}

export interface LanguageParser {
  detect(content: string): boolean
  extractMetadata(content: string): ContractMetadata[]
  extractCalls(content: string): ExternalCall[]
  extractStorage(content: string): StorageVar[]
}
