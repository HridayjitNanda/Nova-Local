/**
 * Shared test fixtures. Every test builds its own in-memory workspace, so the
 * suite never depends on seeded demo data (and never touches Azure).
 */
import { loadEnv } from "../backend/src/config/index.ts"
import { createMemoryDb, setDbForTesting, type Database } from "../backend/src/db/index.ts"
import { createServices, type Services } from "../backend/src/api/server.ts"
import { buildAccessScope, type AccessScope } from "../backend/src/authorization/policy.ts"
import { createTenant, grantPermission, upsertRole, upsertUser } from "../backend/src/tenants/service.ts"
import type { Classification, Principal, Tenant, User } from "../backend/src/models/types.ts"

loadEnv()

export type Actor = { user: User; principal: Principal; scope: AccessScope }

export type Workspace = {
	db: Database
	services: Services
	tenant: Tenant
	actor: (email: string) => Actor
}

export function freshDb(): Database {
	const db = createMemoryDb()
	setDbForTesting(db)
	return db
}

export function makeWorkspace(
	db: Database,
	options: {
		name: string
		industry?: string
		departments?: string[]
		users: Array<{ name: string; email: string; roleKey: string; department: string }>
		roles?: Array<{
			key: string
			name: string
			isAdmin?: boolean
			canUploadKnowledge?: boolean
			canCreateIncidents?: boolean
			grants: Array<{ department: string; maxClassification: Classification }>
		}>
	},
): { tenant: Tenant; actor: (email: string) => Actor } {
	const departments = options.departments ?? ["Human Resources", "Engineering", "Operations", "Finance"]
	const tenant = createTenant(db, {
		name: options.name,
		industry: options.industry ?? "Manufacturing",
		settings: { departments },
	})

	const roles = options.roles ?? [
		{ key: "EMPLOYEE", name: "Employee", grants: [{ department: "*", maxClassification: "internal" as Classification }] },
		{
			key: "ADMIN",
			name: "Administrator",
			isAdmin: true,
			canUploadKnowledge: true,
			grants: [{ department: "*", maxClassification: "restricted" as Classification }],
		},
	]
	for (const role of roles) {
		upsertRole(db, {
			tenantId: tenant.id,
			key: role.key,
			name: role.name,
			isAdmin: role.isAdmin ?? false,
			canUploadKnowledge: role.canUploadKnowledge ?? role.isAdmin ?? false,
			canCreateIncidents: role.canCreateIncidents ?? true,
		})
		for (const grant of role.grants) {
			grantPermission(db, {
				tenantId: tenant.id,
				roleKey: role.key,
				department: grant.department,
				maxClassification: grant.maxClassification,
			})
		}
	}

	const users = new Map<string, User>()
	for (const user of options.users) {
		users.set(
			user.email,
			upsertUser(db, {
				tenantId: tenant.id,
				name: user.name,
				email: user.email,
				roleKey: user.roleKey,
				department: user.department,
			}),
		)
	}

	const actor = (email: string): Actor => {
		const user = users.get(email)
		if (!user) throw new Error(`No test user ${email}`)
		const principal: Principal = {
			tenantId: user.tenantId,
			userId: user.id,
			name: user.name,
			email: user.email,
			roleKey: user.roleKey,
			department: user.department,
			title: user.title,
			authMode: "demo",
		}
		return { user, principal, scope: buildAccessScope(db, principal) }
	}

	return { tenant, actor }
}

export function services(db: Database): Services {
	return createServices(db)
}

export async function ingestText(
	svc: Services,
	input: {
		tenantId: string
		filename: string
		text: string
		uploadedBy: string
		department?: string
		classification?: Classification
		version?: string
		allowedRoles?: string[]
		activate?: boolean
	},
) {
	return svc.documents.ingest({
		tenantId: input.tenantId,
		filename: input.filename,
		buffer: Buffer.from(input.text, "utf8"),
		uploadedBy: input.uploadedBy,
		department: input.department,
		classification: input.classification,
		version: input.version,
		allowedRoles: input.allowedRoles,
		activate: input.activate,
		category: "policy",
	})
}
