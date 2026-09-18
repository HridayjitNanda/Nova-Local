/**
 * Local data-access layer: SQLite via node:sqlite (no external dependency).
 * Every tenant-scoped table has a tenant_id column and a tenant-first index.
 */
// @ts-ignore - node:sqlite typings require @types/node >= 22.5; the runtime API is stable in Node 22+.
import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import path from "node:path"
import { getConfig } from "../config/index.ts"

export type Row = Record<string, any>

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0,
  can_create_incidents INTEGER NOT NULL DEFAULT 1,
  can_upload_knowledge INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  role_key TEXT NOT NULL,
  department TEXT NOT NULL,
  max_classification TEXT NOT NULL,
  UNIQUE (tenant_id, role_key, department)
);
CREATE INDEX IF NOT EXISTS idx_permissions_tenant_role ON permissions (tenant_id, role_key);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role_key TEXT NOT NULL,
  department TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  department TEXT NOT NULL,
  category TEXT NOT NULL,
  classification TEXT NOT NULL,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  allowed_roles_json TEXT NOT NULL DEFAULT '[]',
  allowed_users_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents (tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_tenant_filename ON documents (tenant_id, filename);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  effective_date TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  ingest_status TEXT NOT NULL DEFAULT 'pending',
  ingest_error TEXT,
  UNIQUE (tenant_id, document_id, version),
  FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_versions_tenant_doc ON document_versions (tenant_id, document_id, status);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  keywords TEXT NOT NULL DEFAULT '',
  embedding BLOB,
  embedding_model TEXT NOT NULL DEFAULT '',
  injection_flags TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (version_id) REFERENCES document_versions (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON document_chunks (tenant_id);
CREATE INDEX IF NOT EXISTS idx_chunks_version ON document_chunks (tenant_id, version_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_user ON conversations (tenant_id, user_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  grounding TEXT,
  confidence TEXT,
  provider TEXT,
  latency_ms INTEGER,
  action_json TEXT,
  feedback TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_conv ON messages (tenant_id, conversation_id, created_at);

CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  document_title TEXT NOT NULL,
  department TEXT NOT NULL,
  version TEXT NOT NULL,
  section TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_citations_tenant_msg ON citations (tenant_id, message_id);

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  request_id TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_logs (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL,
  location TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reporter TEXT NOT NULL,
  reporter_user_id TEXT,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  simulated INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_incidents_tenant ON incidents (tenant_id, created_at);
`

export class Database {
	readonly raw: DatabaseSync

	constructor(file: string) {
		if (file !== ":memory:") {
			fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
		}
		this.raw = new DatabaseSync(file)
		this.raw.exec(SCHEMA)
	}

	all<T = Row>(sql: string, ...params: any[]): T[] {
		return this.raw.prepare(sql).all(...params) as T[]
	}

	get<T = Row>(sql: string, ...params: any[]): T | undefined {
		return this.raw.prepare(sql).get(...params) as T | undefined
	}

	run(sql: string, ...params: any[]): void {
		this.raw.prepare(sql).run(...params)
	}

	exec(sql: string): void {
		this.raw.exec(sql)
	}

	transaction<T>(fn: () => T): T {
		this.raw.exec("BEGIN")
		try {
			const result = fn()
			this.raw.exec("COMMIT")
			return result
		} catch (error) {
			this.raw.exec("ROLLBACK")
			throw error
		}
	}

	close(): void {
		this.raw.close()
	}
}

let singleton: Database | null = null

export function getDb(): Database {
	if (!singleton) singleton = new Database(getConfig().paths.dbFile)
	return singleton
}

/** Used by tests: a throwaway in-memory database with the full schema. */
export function createMemoryDb(): Database {
	return new Database(":memory:")
}

export function setDbForTesting(db: Database | null): void {
	singleton = db
}
