# 05 — Tool Improvements & New Tools to Build

## Current Tool Assessment

### Scope Tracker — Works, Needs DB Persistence
- **Current**: In-memory Map keyed by sessionID. Lost on restart.
- **Fix**: Move to SQLite via Drizzle ORM (see doc 03 for schema).
- **Enhancement**: Auto-populate scope by scanning project for contract files on `init`.
- **Enhancement**: Track LOC (lines of code) per contract for audit effort estimation.
- **Enhancement**: Add `export` action that dumps scope to a markdown table.

### Finding Tool — Works, Needs DB Persistence
- **Current**: In-memory array keyed by sessionID. Lost on restart.
- **Fix**: Move to SQLite via Drizzle ORM.
- **Enhancement**: Add `export` action that generates findings in standard audit report format.
- **Enhancement**: Add `search` action to find findings by severity, contract, or keyword.
- **Enhancement**: Add `duplicate-check` that compares a new finding against existing ones.
- **Enhancement**: Cross-session finding persistence — findings should survive session restarts.

### Contract Info — Works Well
- **Current**: Reads a file, detects language, runs parser, formats output.
- **Enhancement**: Cache parsed results so repeated calls to the same file don't re-parse.
- **Enhancement**: Add `--json` output mode for programmatic consumption by other tools.
- **Enhancement**: Support parsing multiple files at once (batch mode).
- **Enhancement**: Show SLOC (source lines of code, excluding comments/blanks) for complexity estimation.

### Call Graph — Needs Multi-Language Support
- **Current**: Only scans `.sol` files. Hardcoded Solidity logic.
- **Fix**: Use the language parser registry to support all languages.
- **Fix**: Scan for file extensions dynamically based on detected framework.
- **Enhancement**: Detect circular call paths (potential infinite recursion/gas issues).
- **Enhancement**: Mark functions that handle ETH/token transfers in the graph.
- **Enhancement**: Graphviz DOT output for visual rendering.

### Storage Layout — Good for Solidity
- **Current**: EVM slot calculation, proxy collision detection.
- **Enhancement**: Support packed struct slots (multiple small types in one slot).
- **Enhancement**: Detect EIP-1967 proxy storage slots.
- **Enhancement**: Detect diamond proxy (EIP-2535) facet storage patterns.
- **Enhancement**: Support Vyper storage layout.
- **Enhancement**: Output in the same format as `forge inspect ContractName storage-layout`.

### Audit Bash — Works, Needs Polish
- **Current**: Framework detection, command shortcuts, timeout handling.
- **Enhancement**: Parse Foundry test output to extract pass/fail per test function.
- **Enhancement**: Parse compilation errors to extract file:line:message for better error reporting.
- **Enhancement**: Add `gas-report` shortcut (forge test --gas-report).
- **Enhancement**: Add `snapshot` shortcut (forge snapshot) for gas comparison.
- **Enhancement**: Safety guard — refuse to run `rm -rf`, `git push`, or other destructive commands.
- **Enhancement**: Detect and suggest installing Foundry/Hardhat if not found.

---

## New Tools to Build

### Priority 1: Invariant Checker Tool

```
Tool ID: "invariant"
Purpose: Define and track protocol invariants. The LLM defines invariants
         ("total supply should never exceed max"), the tool stores them,
         and they can be checked against PoC test results.
Parameters: {
  action: "define" | "list" | "check" | "remove",
  name: string,
  condition: string, // natural language or Solidity expression
  contracts: string[], // which contracts this invariant applies to
}
```

This is the core of the "reason adversarially" approach — make invariants explicit.

### Priority 2: Dependency Scanner Tool

```
Tool ID: "deps"
Purpose: Analyze project dependencies for known vulnerabilities.
         Check OpenZeppelin version, check for known buggy library versions,
         identify forked/modified library code.
Parameters: {
  action: "scan" | "check-version" | "diff-from-upstream",
  path?: string,
}
Output: List of dependencies with version, known CVEs, modification status.
```

### Priority 3: Gas Analyzer Tool

```
Tool ID: "gas"
Purpose: Analyze gas consumption patterns that could lead to DoS.
         Detect unbounded loops, growing arrays, expensive storage patterns.
Parameters: {
  path: string,
  function?: string,
}
Output: Gas hotspots, unbounded iteration risks, storage cost analysis.
```

### Priority 4: Access Control Mapper Tool

```
Tool ID: "access"
Purpose: Build a comprehensive access control map of the protocol.
         Who can call what? What roles exist? What's the admin key setup?
Parameters: {
  action: "map" | "check-function" | "role-graph",
  path?: string,
  function?: string,
}
Output: Role hierarchy, function-to-role mapping, unprotected functions list.
```

### Priority 5: Token Flow Tracer Tool

```
Tool ID: "token-flow"
Purpose: Trace how tokens/ETH flow through the protocol.
         Identifies entry points (deposits), exit points (withdrawals),
         and intermediate transfers.
Parameters: {
  token?: string, // "ETH", "ERC20", specific address
  direction?: "in" | "out" | "both",
}
Output: Flow graph of value movement, mint/burn points, fee extraction points.
```

### Priority 6: Diff Auditor Tool

```
Tool ID: "diff-audit"
Purpose: For upgrade audits — compare two versions of a contract/protocol
         and identify security-relevant changes.
Parameters: {
  old_path: string,
  new_path: string,
}
Output: Security-relevant diff with annotations (new external calls,
        changed access control, modified math, new storage variables).
```

---

## Tool Architecture Improvements

### 1. Tool Output Caching
Tools like `contract-info` get called repeatedly on the same file. Add a cache layer:
```typescript
const cache = new Map<string, { content: string; mtime: number; result: any }>()
```

### 2. Tool Composition
Allow tools to call other tools internally. For example, `call-graph` should internally use `contract-info` to get function lists. Currently they're independent.

### 3. Structured JSON Output Mode
All audit tools should support a `format: "json" | "text"` parameter. JSON output enables:
- Programmatic consumption by the pipeline
- Structured data in the TUI (tables, trees)
- Export to external tools

### 4. Tool Permissions for Audit Context
Add audit-specific permission categories:
- `audit_read` — tools that only read and analyze (scope, contract-info, call-graph, storage-layout)
- `audit_write` — tools that modify state (finding, scope-tracker)
- `audit_execute` — tools that run code (audit-bash, exploit testing)
