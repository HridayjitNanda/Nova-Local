export type Classification = "public" | "internal" | "confidential" | "restricted"

export type Tenant = {
	id: string
	slug: string
	name: string
	industry: string
	settings: { departments: string[]; assistantName: string; currency: string; defaultClassification: Classification }
}

export type Persona = {
	id: string
	name: string
	email: string
	department: string
	title: string
	roleKey: string
	roleName: string
	isAdmin: boolean
}

export type Role = {
	id: string
	key: string
	name: string
	description: string
	isAdmin: boolean
	canCreateIncidents: boolean
	canUploadKnowledge: boolean
}

export type Permission = { id: string; roleKey: string; department: string; maxClassification: Classification }

export type Citation = {
	index: number
	documentId: string
	versionId: string
	documentTitle: string
	department: string
	version: string
	section: string
	classification: Classification
	score: number
}

export type ActionRecord = {
	kind: "incident"
	simulated: boolean
	provider: string
	incident: {
		id: string
		code: string
		machineId: string
		description: string
		severity: string
		location: string
		observedAt: string
		reporter: string
		status: string
		createdAt: string
		simulated: boolean
	}
}

export type Message = {
	id: string
	conversationId: string
	role: "user" | "assistant"
	content: string
	grounding: "grounded" | "partial" | "insufficient_evidence" | "access_denied" | null
	confidence: "high" | "medium" | "low" | "none" | null
	provider: string | null
	latencyMs: number | null
	feedback: "up" | "down" | null
	citations: Citation[]
	action: ActionRecord | null
	createdAt: string
}

export type Conversation = { id: string; title: string; createdAt: string; updatedAt: string }

/**
 * `/api/health` is a local configuration check. It performs no Azure model
 * call, so there is no "verified" flag - only whether the configuration is
 * complete and the expected implementations are loaded.
 */
export type HealthResponse = {
	ok: boolean
	status: "healthy" | "configuration_incomplete"
	modeBadge: string
	appMode: string
	isFullyLocal: boolean
	liveProbe: false
	azure: { status: string; configured: boolean; partial: boolean }
	azureConfigured: boolean
	modes: Record<string, string>
	providers: Record<string, { name: string; mode: string; configured?: boolean; model?: string; dim?: number; simulated?: boolean; isProduction?: boolean }>
}

export type Me = {
	user: { id: string; name: string; email: string; department: string; title: string; roleKey: string }
	role: Role | undefined
	tenant: Tenant
	permissions: Permission[]
	scope: { isAdmin: boolean; canUploadKnowledge: boolean; canCreateIncidents: boolean; grants: unknown }
	auth: { mode: string; isProduction: boolean }
}

export type DocumentVersion = {
	id: string
	version: string
	status: "active" | "inactive" | "superseded"
	effectiveDate: string
	uploadedAt: string
	uploadedBy: string
	chunkCount: number
	ingestStatus: string
	ingestError?: string | null
}

export type KnowledgeDocument = {
	id: string
	title: string
	filename: string
	department: string
	category: string
	classification: Classification
	sourceType: string
	status: "active" | "inactive"
	allowedRoles: string[]
	allowedUsers: string[]
	updatedAt: string
	versions: DocumentVersion[]
}

export type ChatResponse = {
	conversationId: string
	message: Message
	retrieval: { candidateCount: number; usedCount: number; deniedCount: number; strategy?: string; provider?: string } | null
	security: { accessDenied?: boolean; userAttackFlags?: string[]; documentInjectionFlags?: string[] } | null
	model?: { provider: string; model: string; isFallback: boolean; fallbackReason?: string }
	workflow: { kind: string; missing: string[]; complete: boolean } | null
}

export type ActivityEntry = {
	id: string
	createdAt: string
	userName: string
	action: string
	resourceType: string
	resourceId: string | null
	status: string
	detail: string | null
	latencyMs: number | null
}

export type AdminMetrics = {
	documents: { documents: number; activeDocuments: number; versions: number; chunks: number; byDepartment: Array<{ department: string; count: number }> }
	conversations: { conversations: number; queries: number; answers: number; avgLatencyMs: number; citationRate: number; accessDenied: number }
	users: number
	roles: number
	incidents: { total: number; open: number; recent: ActionRecord["incident"][] }
	knowledgeSources: Array<{ name: string; mode: string; status: string; detail?: string }>
	system: Record<string, unknown>
}
