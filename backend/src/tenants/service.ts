/**
 * Tenant registry. The company name, departments and assistant labels all come
 * from here - never from hard-coded business logic.
 */
import { randomUUID } from "node:crypto"
import type { Database } from "../db/index.ts"
import type { Permission, Role, Tenant, TenantSettings, User } from "../models/types.ts"
import type { Classification } from "../models/types.ts"

export const DEFAULT_SETTINGS: TenantSettings = {
	departments: ["General"],
	defaultClassification: "internal",
	currency: "INR",
	locale: "en-IN",
	assistantName: "NOVA",
}

function rowToTenant(r: any): Tenant {
	return {
		id: r.id,
		slug: r.slug,
		name: r.name,
		industry: r.industry,
		settings: { ...DEFAULT_SETTINGS, ...JSON.parse(r.settings_json) },
		createdAt: r.created_at,
	}
}

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 48)
}

export function createTenant(
	db: Database,
	input: { name: string; industry: string; slug?: string; settings?: Partial<TenantSettings> },
): Tenant {
	const slug = input.slug ? slugify(input.slug) : slugify(input.name)
	const existing = getTenantBySlug(db, slug)
	if (existing) return existing
	const tenant: Tenant = {
		id: `ten_${randomUUID()}`,
		slug,
		name: input.name,
		industry: input.industry,
		settings: { ...DEFAULT_SETTINGS, ...input.settings },
		createdAt: new Date().toISOString(),
	}
	db.run(
		`INSERT INTO tenants (id, slug, name, industry, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		tenant.id,
		tenant.slug,
		tenant.name,
		tenant.industry,
		JSON.stringify(tenant.settings),
		tenant.createdAt,
	)
	return tenant
}

export function updateTenantSettings(db: Database, tenantId: string, patch: Partial<TenantSettings>): Tenant {
	const tenant = getTenant(db, tenantId)
	if (!tenant) throw new Error("tenant_not_found")
	const settings = { ...tenant.settings, ...patch }
	db.run(`UPDATE tenants SET settings_json = ? WHERE id = ?`, JSON.stringify(settings), tenantId)
	return { ...tenant, settings }
}

export function getTenant(db: Database, tenantId: string): Tenant | null {
	const row = db.get(`SELECT * FROM tenants WHERE id = ?`, tenantId)
	return row ? rowToTenant(row) : null
}

export function getTenantBySlug(db: Database, slug: string): Tenant | null {
	const row = db.get(`SELECT * FROM tenants WHERE slug = ?`, slug)
	return row ? rowToTenant(row) : null
}

export function listTenants(db: Database): Tenant[] {
	return db.all(`SELECT * FROM tenants ORDER BY created_at`).map(rowToTenant)
}

/* ------------------------------- roles ---------------------------------- */

export function upsertRole(
	db: Database,
	input: {
		tenantId: string
		key: string
		name: string
		description?: string
		isAdmin?: boolean
		canCreateIncidents?: boolean
		canUploadKnowledge?: boolean
	},
): Role {
	const existing = db.get(`SELECT * FROM roles WHERE tenant_id = ? AND key = ?`, input.tenantId, input.key)
	const role: Role = {
		id: existing?.id ?? `rol_${randomUUID()}`,
		tenantId: input.tenantId,
		key: input.key,
		name: input.name,
		description: input.description ?? "",
		isAdmin: input.isAdmin ?? false,
		canCreateIncidents: input.canCreateIncidents ?? true,
		canUploadKnowledge: input.canUploadKnowledge ?? (input.isAdmin ?? false),
	}
	db.run(
		`INSERT INTO roles (id, tenant_id, key, name, description, is_admin, can_create_incidents, can_upload_knowledge)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (tenant_id, key) DO UPDATE SET
		   name = excluded.name,
		   description = excluded.description,
		   is_admin = excluded.is_admin,
		   can_create_incidents = excluded.can_create_incidents,
		   can_upload_knowledge = excluded.can_upload_knowledge`,
		role.id,
		role.tenantId,
		role.key,
		role.name,
		role.description,
		role.isAdmin ? 1 : 0,
		role.canCreateIncidents ? 1 : 0,
		role.canUploadKnowledge ? 1 : 0,
	)
	return role
}

function rowToRole(r: any): Role {
	return {
		id: r.id,
		tenantId: r.tenant_id,
		key: r.key,
		name: r.name,
		description: r.description,
		isAdmin: !!r.is_admin,
		canCreateIncidents: !!r.can_create_incidents,
		canUploadKnowledge: !!r.can_upload_knowledge,
	}
}

export function listRoles(db: Database, tenantId: string): Role[] {
	return db.all(`SELECT * FROM roles WHERE tenant_id = ? ORDER BY key`, tenantId).map(rowToRole)
}

export function getRole(db: Database, tenantId: string, key: string): Role | null {
	const row = db.get(`SELECT * FROM roles WHERE tenant_id = ? AND key = ?`, tenantId, key)
	return row ? rowToRole(row) : null
}

/* ---------------------------- permissions -------------------------------- */

export function grantPermission(
	db: Database,
	input: { tenantId: string; roleKey: string; department: string; maxClassification: Classification },
): Permission {
	const existing = db.get(
		`SELECT * FROM permissions WHERE tenant_id = ? AND role_key = ? AND department = ?`,
		input.tenantId,
		input.roleKey,
		input.department,
	)
	const permission: Permission = {
		id: existing?.id ?? `prm_${randomUUID()}`,
		tenantId: input.tenantId,
		roleKey: input.roleKey,
		department: input.department,
		maxClassification: input.maxClassification,
	}
	db.run(
		`INSERT INTO permissions (id, tenant_id, role_key, department, max_classification) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (tenant_id, role_key, department) DO UPDATE SET max_classification = excluded.max_classification`,
		permission.id,
		permission.tenantId,
		permission.roleKey,
		permission.department,
		permission.maxClassification,
	)
	return permission
}

export function listPermissions(db: Database, tenantId: string, roleKey?: string): Permission[] {
	const rows = roleKey
		? db.all(`SELECT * FROM permissions WHERE tenant_id = ? AND role_key = ?`, tenantId, roleKey)
		: db.all(`SELECT * FROM permissions WHERE tenant_id = ?`, tenantId)
	return rows.map((r) => ({
		id: r.id,
		tenantId: r.tenant_id,
		roleKey: r.role_key,
		department: r.department,
		maxClassification: r.max_classification as Classification,
	}))
}

/* -------------------------------- users ---------------------------------- */

function rowToUser(r: any): User {
	return {
		id: r.id,
		tenantId: r.tenant_id,
		name: r.name,
		email: r.email,
		roleKey: r.role_key,
		department: r.department,
		title: r.title,
		createdAt: r.created_at,
	}
}

export function upsertUser(
	db: Database,
	input: { tenantId: string; name: string; email: string; roleKey: string; department: string; title?: string },
): User {
	const existing = db.get(`SELECT * FROM users WHERE tenant_id = ? AND email = ?`, input.tenantId, input.email)
	const user: User = {
		id: existing?.id ?? `usr_${randomUUID()}`,
		tenantId: input.tenantId,
		name: input.name,
		email: input.email,
		roleKey: input.roleKey,
		department: input.department,
		title: input.title ?? "",
		createdAt: existing?.created_at ?? new Date().toISOString(),
	}
	db.run(
		`INSERT INTO users (id, tenant_id, name, email, role_key, department, title, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (tenant_id, email) DO UPDATE SET
		   name = excluded.name, role_key = excluded.role_key,
		   department = excluded.department, title = excluded.title`,
		user.id,
		user.tenantId,
		user.name,
		user.email,
		user.roleKey,
		user.department,
		user.title,
		user.createdAt,
	)
	return user
}

export function listUsers(db: Database, tenantId: string): User[] {
	return db.all(`SELECT * FROM users WHERE tenant_id = ? ORDER BY name`, tenantId).map(rowToUser)
}

export function getUser(db: Database, tenantId: string, userId: string): User | null {
	const row = db.get(`SELECT * FROM users WHERE tenant_id = ? AND id = ?`, tenantId, userId)
	return row ? rowToUser(row) : null
}

export function getUserByEmail(db: Database, tenantId: string, email: string): User | null {
	const row = db.get(`SELECT * FROM users WHERE tenant_id = ? AND email = ?`, tenantId, email)
	return row ? rowToUser(row) : null
}
