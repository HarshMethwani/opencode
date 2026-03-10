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
}

export interface LanguageParser {
  detect(content: string): boolean
  extractMetadata(content: string): ContractMetadata[]
  extractCalls(content: string): ExternalCall[]
  extractStorage(content: string): StorageVar[]
}
