# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

OpenCode is an open-source, provider-agnostic AI coding agent. It's a Bun workspace monorepo with a client/server architecture supporting TUI, web, and desktop interfaces.

- **Runtime**: Bun 1.3+ (not Node.js)
- **Default branch**: `dev` (local `main` may not exist; use `dev` or `origin/dev` for diffs)
- **Frontend**: SolidJS
- **Database**: SQLite via Drizzle ORM
- **LLM integration**: Vercel AI SDK (multi-provider)
- **API server**: Hono

## Common Commands

```bash
# Install & run
bun install
bun dev                    # Start TUI (defaults to packages/opencode dir)
bun dev <directory>        # Run against a specific directory
bun dev .                  # Run against repo root
bun dev serve              # Headless API server (port 4096)
bun dev serve --port 8080  # Custom port
bun dev web                # TUI + web UI

# Build
bun run build                            # Build all (via turbo)
./packages/opencode/script/build.ts      # Build standalone executable
./packages/opencode/script/build.ts --single  # Single-file build

# Test (NEVER run from repo root - it will fail by design)
cd packages/opencode && bun test                    # All opencode tests
cd packages/opencode && bun test --timeout 30000    # With timeout
cd packages/opencode && bun test test/tool/         # Test a subdirectory
cd packages/app && bun run test:unit                # App unit tests
cd packages/app && bun run test:e2e                 # Playwright E2E

# Type checking
bun turbo typecheck          # All packages
cd packages/opencode && tsgo --noEmit   # Single package
cd packages/app && tsgo -b              # App package

# Web UI development
bun dev serve              # First: start API server
bun run --cwd packages/app dev   # Then: start web dev server (localhost:5173)

# Desktop development
bun run --cwd packages/desktop tauri dev  # Requires Rust toolchain

# Database migrations
cd packages/opencode && bun drizzle-kit <command>

# SDK regeneration (after API/server changes)
./packages/sdk/js/script/build.ts
# After API changes in packages/opencode/src/server/server.ts:
./script/generate.ts
```

## Monorepo Structure

| Package | Purpose |
|---------|---------|
| `packages/opencode` | Core CLI, server, session, tools, providers, MCP, LSP |
| `packages/app` | Shared web UI components (SolidJS + Vite) |
| `packages/desktop` | Native desktop app (Tauri wrapping `packages/app`) |
| `packages/console/app` | Web dashboard (SolidStart + Cloudflare) |
| `packages/web` | Marketing/docs website (Astro) |
| `packages/sdk/js` | JS SDK (auto-generated from OpenAPI) |
| `packages/plugin` | Plugin system (`@opencode-ai/plugin`) |
| `packages/ui` | Shared UI component library |
| `packages/util` | Shared utilities (`@opencode-ai/util`) |

## Core Architecture (packages/opencode/src/)

- **`cli/`** — CLI commands via yargs, TUI code in `cli/cmd/tui/` (SolidJS + OpenTUI)
- **`server/`** — Hono HTTP API server
- **`session/`** — Session management, LLM interaction, message processing, prompt construction
- **`tool/`** — Tool implementations (bash, edit, read, write, grep, glob, webfetch, etc.)
- **`provider/`** — LLM provider integrations (Anthropic, OpenAI, Google, Bedrock, Azure, etc.)
- **`mcp/`** — Model Context Protocol support
- **`lsp/`** — Language Server Protocol integration
- **`storage/`** — SQLite database, Drizzle schema, JSON migration from legacy format
- **`permission/`** — Permission system for tool execution
- **`config/`** — Configuration management
- **`skill/`** — Skill/agent system
- **`plugin/`** — Plugin loading and management

## Style Guide

- Avoid `try`/`catch`; prefer `.catch(...)`
- Avoid `any` type
- Prefer single-word variable names; inline values used only once
- `const` over `let`; use ternaries or early returns instead of reassignment
- No `else` statements; use early returns
- No unnecessary destructuring; use dot notation
- Functional array methods (flatMap, filter, map) over for loops
- Use Bun APIs (e.g., `Bun.file()`)
- Drizzle schema: snake_case field names (so column names match automatically)
- Rely on type inference; avoid explicit annotations unless needed for exports

## Testing

- Tests use Bun's native test runner
- Avoid mocks; test actual implementations
- Test fixture: `tmpdir()` from `test/fixture/fixture.ts` creates temp directories with `await using` for automatic cleanup
- Options: `{ git: true }` for git repo, `{ config: {...} }` for opencode.json

## Formatting

- Prettier config: `semi: false`, `printWidth: 120`
- EditorConfig: 2-space indentation, UTF-8, LF line endings

## PR Conventions

- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`
- Optional scope: `feat(app):`, `fix(desktop):`, `chore(opencode):`
- All PRs must reference an existing issue (`Fixes #123`)
