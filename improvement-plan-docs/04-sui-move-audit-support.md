# Sui Move Audit Support — Implementation Plan

## Current State

The Move parser (`packages/quillshield/src/lang/move.ts`) exists at ~200 lines. It handles generic Move syntax — module detection, function extraction, struct parsing, cross-module calls. But it has **zero Sui-specific awareness**. No object model, no ability analysis, no capability patterns, no OTW detection, no dynamic fields, no transfer semantics.

The audit prompts have comprehensive security checklists for Solidity (30+ items) and Anchor (25+ items) but **nothing for Sui Move**.

**Estimated current Sui audit quality: 20% of what Solidity/Anchor get.**

---

## What Makes Sui Move Auditing Different

Sui Move is fundamentally different from Solidity and Anchor. The key audit concerns are NOT the same:

| Concept | Solidity | Anchor | Sui Move |
|---------|----------|--------|----------|
| Access control | `msg.sender` + modifiers | Signer accounts + PDA constraints | Capability objects + `tx_context::sender` |
| Reentrancy | Critical concern | N/A (single-threaded) | N/A (no dynamic dispatch) |
| Storage | Slot-based, packing | Account data, PDAs | Object model (owned/shared/immutable) |
| Flash loans | Callback-based | CPI-based | Hot potato pattern (ability enforcement) |
| Upgrades | Proxy patterns | Program authority | UpgradeCap + policy restrictions |
| Token safety | ERC20 quirks | SPL token constraints | Coin abilities + TreasuryCap custody |
| Atomicity | Single tx | Single tx | PTB (up to 1024 commands in one tx) |
| Overflow | Unchecked by default | Rust panics in debug | Aborts on arithmetic, BUT bitwise shifts are unchecked |

---

## Implementation Plan

### Phase 1: Sui Move Security Checklist (Prompts)

**Priority: P0 — This alone dramatically improves audit quality**

The LLM already knows Move. What it lacks is structured guidance on *what to look for*. Adding a security checklist to the prompts is the highest-ROI change.

#### 1.1 Add Sui Move Security Checklist to `audit.txt`

Add a new section alongside the existing Solidity and Anchor checklists. 53 items across 13 categories:

**Ability Annotation Checks (5 items):**
- [ ] Hot potato structs must NOT have `drop` — adding `drop` silently breaks flash loan repayment
- [ ] Fungible tokens must never have `copy` or `drop` — enables infinite minting/silent destruction
- [ ] Objects with `store` can be transferred by anyone via `public_transfer` — is this intended?
- [ ] Capabilities/admin objects should use `key` only (no `store`) to restrict transfers to defining module
- [ ] Every struct has minimum necessary abilities — extra abilities expand attack surface

**Access Control & Visibility Checks (5 items):**
- [ ] `public(package) entry` functions are callable by anyone (entry overrides package visibility)
- [ ] Functions accepting `address` params validate against `tx_context::sender(ctx)`
- [ ] Capability objects are validated (ownership check, not just type check)
- [ ] No sensitive internal functions accidentally exposed as `public` or `entry`
- [ ] Functions using on-chain randomness are `entry` only (not `public`) to prevent wrapping

**Object Model & Ownership Checks (6 items):**
- [ ] Related shared objects validate their relationships on every use
- [ ] `transfer::share_object` calls are intentional — once shared, any address can access
- [ ] Wrapped objects cannot be unwrapped by unauthorized parties
- [ ] Dynamic field keys cannot collide or be overwritten by attackers
- [ ] `object::delete(id)` is gated behind capability checks
- [ ] Immutable object references don't become stale liabilities as protocol evolves

**Arithmetic & Precision Checks (5 items):**
- [ ] Division truncation — multiply before divide, check rounding direction
- [ ] Bitwise shift overflow — `<<` does NOT abort (root cause of $223M Cetus exploit)
- [ ] Third-party math libraries audited for edge cases (Cetus exploit was in `integer_mate` library)
- [ ] Token calculations across different decimal scales are correct
- [ ] Rounding in pools/vaults consistently favors the protocol

**Flash Loan & Hot Potato Checks (4 items):**
- [ ] Receipt/proof structs have NO abilities (not `drop`, not `store`)
- [ ] Flash loan capital can't be used for oracle manipulation within a single PTB
- [ ] PTB composability considered — up to 1024 atomic commands chained together
- [ ] Repay function validates amount ≥ borrowed + fees and receipt matches original loan

**One-Time Witness & Init Checks (3 items):**
- [ ] OTW type follows rules: ALL_CAPS module name, `drop` only, no fields, no generics
- [ ] All one-time setup happens in `init` and cannot be re-triggered
- [ ] TreasuryCap custody matches security model (transferred to governance, not a single key)

**Token & Coin Checks (4 items):**
- [ ] CoinMetadata is frozen after creation (prevents phishing via name/symbol changes)
- [ ] Protocol handles partial Coin amounts from splitting
- [ ] `coin::value(&coin)` checked before operations, not assumed
- [ ] Token types validated via Move type system, not metadata (prevents spoof token injection)

**Oracle & Price Manipulation Checks (4 items):**
- [ ] No reliance on AMM spot prices (use TWAP or external oracles)
- [ ] Multiple oracle sources with deviation checks
- [ ] Clock-dependent logic has appropriate tolerance windows
- [ ] Oracle price freshness checked (max age enforcement)

**DoS Checks (4 items):**
- [ ] No unbounded iteration over user-controlled collections
- [ ] Dynamic field creation on shared objects is rate-limited or bounded
- [ ] Shared object mutations minimized in hot paths (consensus bottleneck)
- [ ] Collection processing has configurable batch sizes

**Package Upgrade Checks (4 items):**
- [ ] UpgradeCap custody is multisig or governance-controlled
- [ ] Upgrade policy restricted (`only_additive_upgrades` or `only_dep_upgrades`)
- [ ] Immutable packages have destroyed/made-immutable UpgradeCap
- [ ] Dependency upgrade risks assessed (upstream packages can change behavior)

**Transfer & Transfer Policy Checks (3 items):**
- [ ] Understand `transfer::transfer` (key only, module-restricted) vs `public_transfer` (key+store, anyone)
- [ ] Objects are intentionally transferable (remove `store` if transfers should be module-controlled)
- [ ] Custom transfer policies (Kiosk/TransferPolicy) have rules properly enforced

**MEV & Transaction Ordering Checks (3 items):**
- [ ] Protocol operations are ordering-independent where possible
- [ ] Slippage protection on AMM swaps, liquidations, auctions
- [ ] Event-reliant off-chain logic validates the emitting module

**Cross-Module & Type Safety Checks (3 items):**
- [ ] Cross-function state consistency within a single PTB (no classical reentrancy, but state bugs possible)
- [ ] All imported module dependencies audited
- [ ] Generic functions (`T: key + store`) safe for all possible type instantiations

#### 1.2 Update Other Prompts

**`scope.txt`** — Add Sui Move scoping format:
```
For each Sui Move module, document:
- Module name and package
- Entry functions (transaction entry points)
- Public functions (callable by other modules)
- Object types with abilities (key, store, copy, drop)
- Capability types (AdminCap, TreasuryCap, UpgradeCap)
- Shared objects vs owned objects
- Dynamic field usage
- Cross-module dependencies
- Init function and OTW pattern
```

**`trace.txt`** — Add Sui-specific tracing guidance:
```
For Sui Move traces:
- Track object ownership transitions (owned → shared → frozen)
- Follow capability object flow (who creates, who receives, who can use)
- Check ability annotations at each step (can this struct be dropped? copied? stored?)
- For flash loans: verify hot potato has no drop ability, trace receipt lifecycle
- For PTBs: consider what an attacker can chain in a single atomic transaction
- For shared objects: check concurrent access patterns and state consistency
```

**`exploit.txt`** — Add Move test framework template:
```move
#[test_only]
module exploit::test_exploit {
    use sui::test_scenario::{Self, Scenario};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;

    #[test]
    fun test_exploit() {
        let mut scenario = test_scenario::begin(@attacker);

        // Setup: deploy contracts, create objects
        test_scenario::next_tx(&mut scenario, @admin);
        { /* admin setup */ };

        // Attack: execute exploit
        test_scenario::next_tx(&mut scenario, @attacker);
        {
            // Step 1: ...
            // Step 2: ...
        };

        // Verify: assert impact
        test_scenario::next_tx(&mut scenario, @attacker);
        { /* assertions */ };

        test_scenario::end(scenario);
    }
}
```

Run with: `sui move test --filter test_exploit`

**`recon.txt`** — Add Sui awareness:
```
For Sui Move projects:
- Identify all modules and their package organization
- Map object types: which are shared, owned, immutable
- Identify capability objects (AdminCap, TreasuryCap, etc.)
- Find entry functions (transaction entry points) vs public functions
- Check init function for OTW pattern and initial object creation
- Map dynamic field usage across modules
- Check UpgradeCap existence and custody
```

**Files to modify:**
- `packages/quillshield/src/session/prompt/audit.txt`
- `packages/quillshield/src/session/prompt/scope.txt`
- `packages/quillshield/src/session/prompt/trace.txt`
- `packages/quillshield/src/session/prompt/exploit.txt`
- `packages/quillshield/src/session/prompt/recon.txt`
- `packages/quillshield/src/session/prompt/report.txt` (add Sui platform to finding template)

---

### Phase 2: Rewrite Move Parser for Sui

**Priority: P1 — Makes the tools actually useful for Sui**

The parser needs to go from ~200 lines of generic Move to ~500+ lines of Sui-aware parsing.

#### 2.1 New Types for Sui Concepts

Add to `packages/quillshield/src/lang/types.ts`:

```typescript
export interface SuiObjectInfo {
  name: string
  abilities: string[]          // ["key", "store", "copy", "drop"]
  hasKey: boolean
  hasStore: boolean
  hasCopy: boolean
  hasDrop: boolean
  isShared: boolean            // detected from transfer::share_object usage
  isDynamic: boolean           // has dynamic fields
  fields: { name: string; type: string }[]
}

export interface SuiModuleInfo {
  hasInit: boolean
  hasOTW: boolean              // One-Time Witness pattern
  otwType: string | null       // The OTW type name
  capabilities: string[]       // AdminCap, TreasuryCap, etc.
  sharedObjects: string[]      // Types passed to share_object
  entryFunctions: string[]     // Functions marked `entry`
  upgradePolicy: string | null // detected if UpgradeCap usage found
}
```

Add optional `suiInfo?: SuiModuleInfo` and `objects?: SuiObjectInfo[]` to `ContractMetadata`.

#### 2.2 Parser Enhancements

Rewrite `packages/quillshield/src/lang/move.ts` (rename to `sui-move.ts` or keep as `move.ts` with Sui detection):

**New extraction functions:**

| Function | What it extracts | Why it matters |
|----------|-----------------|----------------|
| `extractAbilities(body)` | Struct abilities (`has key, store, copy, drop`) | Ability misuse is a top Sui vulnerability class |
| `extractObjects(body)` | Object types with their fields and abilities | Core Sui security model |
| `extractCapabilities(body)` | Types ending in `Cap` (AdminCap, TreasuryCap, UpgradeCap) | Access control surface |
| `extractTransfers(body)` | `transfer::transfer`, `transfer::share_object`, `transfer::freeze_object` calls | Ownership transitions |
| `extractDynamicFields(body)` | `dynamic_field::add/borrow/remove`, `dynamic_object_field::*` | Dynamic field attack surface |
| `extractOTW(body, moduleName)` | One-Time Witness detection (ALL_CAPS type matching module name) | Init security |
| `extractInit(body)` | `init` function presence and what it creates | Module initialization |
| `detectVisibility(funcStr)` | `public`, `public(package)`, `entry`, `public entry` distinctions | Visibility confusion bugs |

**Enhanced call extraction:**

Current call extraction misses Sui-specific patterns. Add detection for:
- `transfer::transfer` / `transfer::public_transfer` / `transfer::share_object` / `transfer::freeze_object`
- `dynamic_field::add` / `dynamic_field::borrow_mut` / `dynamic_field::remove`
- `dynamic_object_field::add` / `dynamic_object_field::borrow_mut`
- `coin::split` / `coin::join` / `coin::value` / `coin::burn`
- `tx_context::sender` (access control check)
- `object::new` / `object::delete` / `object::id`
- `clock::timestamp_ms` (oracle/timing)
- `event::emit` (event emission)
- `package::make_immutable` / `package::only_additive_upgrades`

**File:** `packages/quillshield/src/lang/move.ts`

#### 2.3 Sui-Specific Detection

Update `packages/quillshield/src/lang/index.ts`:

```typescript
// In detectLanguage:
if (ext === "move") {
  // Distinguish Sui Move from Aptos Move
  if (content.includes("use sui::") || content.includes("sui::object") || content.includes("sui::transfer"))
    return "sui-move"
  if (content.includes("use aptos_framework") || content.includes("aptos_std"))
    return "aptos-move"
  return "move"
}
```

This allows the parser to apply Sui-specific extraction when the code is Sui Move vs generic Move.

---

### Phase 3: Enhance contract-info Tool for Sui

**Priority: P1 — Works alongside parser to present Sui security data**

Update `packages/quillshield/src/tool/contract-info.ts` to add a Sui-specific output section (like the Anchor "Account Validation" section).

#### 3.1 Sui Object Analysis Section

When language is `sui-move`, add:

```
=== OBJECT ANALYSIS ===
  MyToken: struct has key, store
    -> Fields: id: UID, value: u64
    -> !! WARNING: has `store` — transferable by anyone via public_transfer
    -> Shared: NO

  AdminCap: struct has key
    -> Fields: id: UID
    -> CAPABILITY OBJECT — controls privileged operations
    -> Shared: NO (good — capabilities should be owned)

  FlashLoanReceipt: struct (no abilities)
    -> Fields: amount: u64, fee: u64
    -> HOT POTATO — must be consumed, cannot be dropped or stored ✓
```

#### 3.2 Security Warnings

Auto-generate warnings for:
- Tokens/coins with `copy` or `drop` abilities
- Capability objects with `store` (can be transferred to anyone)
- Hot potato structs with `drop` (defeats the pattern)
- `entry` functions that are also `public` (wider attack surface than needed)
- Missing `init` function in a module that creates capability objects
- Shared objects without relationship validation

**File:** `packages/quillshield/src/tool/contract-info.ts`

---

### Phase 4: Enhance call-graph Tool for Sui

**Priority: P2 — Nice to have, LLM can reason about this without tooling**

#### 4.1 Object Flow Tracking

For Sui Move, the call graph should additionally show:
- **Object creation points** — where `object::new` is called
- **Ownership transitions** — `transfer::transfer`, `share_object`, `freeze_object`
- **Capability usage** — which functions consume/require which capabilities
- **Dynamic field operations** — add/remove/borrow on which objects

#### 4.2 Attack Surface Labels

Current call graph shows "CPI Surface" for Anchor and "Reentrancy Surface" for Solidity. For Sui, show:
- **Entry Surface** — all `entry` functions (transaction entry points)
- **Shared Object Surface** — functions that mutate shared objects
- **Capability Surface** — functions that require capability objects

**File:** `packages/quillshield/src/tool/call-graph.ts`

---

### Phase 5: Add `sui-test` Support to audit-bash

**Priority: P2 — Needed when writing PoCs**

Update `packages/quillshield/src/tool/audit-bash.ts` to:
- Auto-detect Sui Move projects (presence of `Move.toml` with `[dependencies.Sui]`)
- Support shortcuts: `compile` → `sui move build`, `test` → `sui move test`, `test <filter>` → `sui move test --filter <name>`

**File:** `packages/quillshield/src/tool/audit-bash.ts`

---

## Implementation Order

| Step | Phase | Files Modified | Estimated Size | Impact |
|------|-------|----------------|----------------|--------|
| 1 | 1.1 | `audit.txt` | +120 lines | HIGH — Sui checklist alone makes audits 3x better |
| 2 | 1.2 | `scope.txt`, `trace.txt`, `exploit.txt`, `recon.txt`, `report.txt` | +80 lines total | HIGH — guides LLM through Sui-specific workflows |
| 3 | 2.1 | `types.ts` | +30 lines | MEDIUM — types for parser |
| 4 | 2.2 | `move.ts` | Rewrite (~500 lines) | HIGH — Sui-aware parsing |
| 5 | 2.3 | `index.ts` | +10 lines | LOW — detection routing |
| 6 | 3 | `contract-info.ts` | +60 lines | HIGH — Sui security warnings in tool output |
| 7 | 4 | `call-graph.ts` | +40 lines | MEDIUM — object flow tracking |
| 8 | 5 | `audit-bash.ts` | +20 lines | LOW — test runner support |

**Total estimated new/changed code: ~860 lines across 10 files.**

## Verification Plan

After implementation, test against:

1. **A simple Sui Move module** — verify parser extracts objects, abilities, entry functions, capabilities
2. **A DeFi protocol with flash loans** — verify hot potato detection, receipt ability warnings
3. **A module with shared objects** — verify shared object identification and warnings
4. **A module with dynamic fields** — verify dynamic field operation tracking
5. **Run the audit agent** against a known-vulnerable Sui contract and verify the checklist items are checked

Specifically:
- `contract-info` on a Sui module should show Object Analysis section with ability warnings
- `call-graph` on a Sui entry function should show Entry Surface and Shared Object Surface
- `audit-bash compile` should run `sui move build` in a Sui project
- The audit agent should follow the Sui Move Security Checklist when auditing `.move` files

## Key References

- **Cetus Protocol exploit ($223M, May 2025)** — bitwise shift overflow in `integer_mate` library, spoof token injection
- **SlowMist Sui Move Auditing Primer** — github.com/slowmist/Sui-MOVE-Smart-Contract-Auditing-Primer
- **Zellic "Move Fast & Break Things" series** — Sui security primer
- **Hacken Move audit checklist** — comprehensive audit methodology
- **Trail of Bits flash loan security in Sui** — hot potato pattern analysis
- **CertiK HamsterWheel attack vector** — novel Sui-specific attack
