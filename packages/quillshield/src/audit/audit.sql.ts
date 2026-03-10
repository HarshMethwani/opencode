import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "@/storage/schema.sql"

export const FindingTable = sqliteTable(
  "finding",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    severity: text().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    impact: text().notNull().default(""),
    contracts: text({ mode: "json" }).notNull().$type<string[]>().default([]),
    status: text().notNull().default("draft"),
    poc_status: text().notNull().default("none"),
    recommendation: text().notNull().default(""),
    ...Timestamps,
  },
  (table) => [
    index("finding_session_idx").on(table.session_id),
    index("finding_severity_idx").on(table.severity),
  ],
)

export const ScopeTable = sqliteTable(
  "scope",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    path: text().notNull(),
    name: text().notNull(),
    language: text().notNull().default("solidity"),
    audit_status: text().notNull().default("pending"),
    findings_count: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    index("scope_session_idx").on(table.session_id),
    index("scope_path_idx").on(table.path),
  ],
)
