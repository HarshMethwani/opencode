# 04 — Language Parser Improvements

## Current Parser Quality Assessment

### Solidity Parser — Grade: B+
**What works well:**
- Contract/interface/library detection
- Function extraction with visibility, mutability, modifiers
- State variable extraction
- Event and error extraction
- External call detection (contract.method(), interface casts, low-level calls)
- Storage slot calculation
- Import extraction

**What needs improvement:**
- Struct definitions are not extracted (need for storage layout of nested types)
- Enum definitions are not extracted
- Assembly blocks are not detected (inline assembly is a common vulnerability source)
- Proxy patterns (delegatecall in fallback/receive) not specially flagged
- Modifier body analysis (onlyOwner checks, reentrancy guards not parsed)
- Multi-file inheritance resolution (can't follow `is` chains across files)
- Constructor extraction is missing
- Fallback/receive function detection is missing
- Library `using ... for` directives not extracted
- Custom error types with parameters not fully parsed

**Improvements to make:**
```typescript
// Add to extractMetadata:
- constructors: ConstructorInfo[]
- fallback: boolean
- receive: boolean
- assembly: { lineNumber: number; content: string }[]
- structs: StructInfo[]
- enums: EnumInfo[]
- usingDirectives: { library: string; type: string }[]

// Add to extractCalls:
- Detect selfdestruct / create / create2 usage
- Flag delegatecall in fallback/receive specially
- Track msg.value usage (payable function fund flow)
```

### Vyper Parser — Grade: C+
**What works:**
- @external/@internal decorator detection
- State variable extraction (public/internal)
- Function extraction with visibility
- Interface call detection
- raw_call detection

**What's missing:**
- Module-level constant detection
- `@nonreentrant` analysis (which lock key?)
- Interface definition parsing (`interface Foo:` blocks)
- Struct parsing
- `@deploy` decorator (constructor equivalent)
- send() / raw_call with value tracking
- Internal function reference analysis

### Anchor Parser — Grade: C
**What works:**
- #[program] module detection
- Basic function extraction
- #[account] struct field extraction
- CPI call detection (basic)
- Event/error detection

**What's missing:**
- **Account validation analysis** — This is the #1 Anchor vulnerability class
  - Missing signer checks
  - Missing owner checks
  - Missing account constraint validation (#[account(constraint = ...)])
  - PDA derivation seed analysis
- `#[derive(Accounts)]` struct analysis with constraint attributes
- `remaining_accounts` usage (common attack vector)
- Token account validation
- Cross-program invocation authority analysis
- init/init_if_needed distinction

**Critical improvement:**
```typescript
// Need to parse:
#[derive(Accounts)]
pub struct MyInstruction<'info> {
    #[account(mut, signer)]        // Has signer check
    pub authority: AccountInfo<'info>,
    #[account(mut)]                 // NO signer check — flag this
    pub vault: Account<'info, Vault>,
    #[account(
        seeds = [b"config", authority.key().as_ref()],
        bump
    )]
    pub config: Account<'info, Config>,  // PDA — extract seeds
}
```

### CosmWasm Parser — Grade: C-
**What works:**
- Entry point function detection
- ExecuteMsg/QueryMsg enum variant extraction
- State item detection (Item::new, Map::new)
- WasmMsg/SubMsg cross-contract call detection

**What's missing:**
- `#[cw_serde]` struct parsing
- Detailed message routing analysis (match arms in execute/query)
- Reply handler analysis (important for atomic multi-contract operations)
- Authorization checks (info.sender validation)
- Fund/coin handling (info.funds)
- Pagination in query responses
- Storage key collision analysis

### Move Parser — Grade: C-
**What works:**
- Module detection
- Public/entry function extraction
- Struct/resource extraction with abilities
- Global storage access tracking (borrow_global, move_from, etc.)
- Use statement extraction

**What's missing:**
- **Ability constraint analysis** — key, store, copy, drop implications
- Resource leak detection (acquired but not returned/destroyed)
- Friend module declarations
- Generic type parameter constraints
- Aptos-specific: coin::transfer, account::create patterns
- Sui-specific: object ownership model, shared objects, transfer policies
- Script vs module distinction

### Cairo Parser — Grade: C-
**What works:**
- #[starknet::contract] module detection
- #[starknet::interface] trait extraction
- Storage struct parsing
- Dispatcher call detection
- L1 message detection

**What's missing:**
- Component/embeddable implementation parsing (new Cairo pattern)
- #[storage_node] attribute analysis
- Felt252 arithmetic precision analysis
- L1Handler attribute parsing
- Event enum variant extraction
- StorageAccess trait implementation analysis
- Library dispatcher vs contract dispatcher distinction

---

## Architecture Improvement: Parser Plugin System

The current parsers are standalone modules. Consider:

```typescript
// packages/quillshield/src/lang/registry.ts
export namespace LanguageRegistry {
  const parsers = new Map<string, LanguageParser>()

  export function register(language: string, parser: LanguageParser) {
    parsers.set(language, parser)
  }

  // Auto-register built-in parsers
  register("solidity", SolidityParser)
  register("vyper", VyperParser)
  // ...

  // Allow plugin-based parsers
  export async function loadPluginParsers() {
    // Load from .quillshield/parsers/ directory
    // This lets users add custom language support
  }
}
```

## Next Steps (Priority Order)

1. **Solidity parser hardening** — Add struct/enum/assembly/constructor/fallback extraction
2. **Anchor account validation** — Parse #[derive(Accounts)] with constraint attributes
3. **Tree-sitter integration** — For languages where regex breaks down (Rust, Move)
4. **Multi-file resolution** — Follow imports to build cross-file inheritance/dependency graphs
5. **Test suite** — Each parser needs test cases with real-world contracts
