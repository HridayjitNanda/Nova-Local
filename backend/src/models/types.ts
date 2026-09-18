/** Shared domain types. Every tenant-scoped entity carries tenantId. */

export type Classification = "public" | "internal" | "confidential" | "restricted"

export const CLASSIFICATION_LEVEL: Record<Classification, number> = {
	public: 1,
	internal: 2,
	confidential: 3,
	restricted: 4,
}

export const CLASSIFICATIONS: Classification[] = ["public", "internal", "confidential", "restricted"]

export type Tenant = {
	id: string
	slug: string
	name: string
	industry: string
	settings: TenantSettings
	createdAt: string
}

export type TenantSettings = {
	departments: string[]
	defaultClassification: Classification
	currency: string
	locale: string
	assistantName: string
	/** Free-form tenant tone/scope guidance injected into the system prompt. */
	knowledgeScopeNote?: string
}

export type Role = {
	id: string
	tenantId: string
	key: string
	name: string
	description: string
	isAdmin: boolean
	canCreateIncidents: boolean
	canUploadKnowledge: boolean
}

/** A grant row: role may read up to `maxClassification` inside `department` ('*' = any). */
export type Permission = {
	id: string
	tenantId: string
	roleKey: string
	department: string
	maxClassification: Classification
}

export type User = {
	id: string
	tenantId: string
	name: string
	email: string
	roleKey: string
	department: string
	title: string
	createdAt: string
}

export type DocumentStatus = "active" | "inactive"
export type VersionStatus = "active" | "inactive"
export type IngestStatus = "pending" | "extracting" | "indexing" | "indexed" | "failed"

export type KnowledgeDocument = {
	id: string
	tenantId: string
	title: string
	filename: string
	department: string
	category: string
	classification: Classification
	sourceType: string
	status: DocumentStatus
	allowedRoles: string[]
	allowedUsers: string[]
	createdAt: string
	updatedAt: string
}

export type DocumentVersion = {
	id: string
	tenantId: string
	documentId: string
	version: string
	status: VersionStatus
	effectiveDate: string
	uploadedAt: string
	uploadedBy: string
	storagePath: string
	checksum: string
	charCount: number
	chunkCount: number
	ingestStatus: IngestStatus
	ingestError: string | null
}

export type DocumentChunk = {
	id: string
	tenantId: string
	documentId: string
	versionId: string
	seq: number
	section: string
	text: string
	charCount: number
}

/** A chunk plus the document/version metadata needed for ranking and citations. */
export type RetrievedChunk = {
	chunkId: string
	tenantId: string
	documentId: string
	versionId: string
	documentTitle: string
	department: string
	category: string
	classification: Classification
	version: string
	section: string
	seq: number
	text: string
	vectorScore: number
	keywordScore: number
	score: number
	injectionFlags: string[]
}

export type Citation = {
	/** 1-based evidence marker the model is allowed to reference. */
	index: number
	documentId: string
	versionId: string
	documentTitle: string
	department: string
	version: string
	section: string
	chunkId: string
	classification: Classification
	score: number
}

export type Grounding = "grounded" | "partially_grounded" | "insufficient_evidence" | "access_denied"
export type Confidence = "high" | "medium" | "low" | "none"

export type Conversation = {
	id: string
	tenantId: string
	userId: string
	title: string
	createdAt: string
	updatedAt: string
}

export type Message = {
	id: string
	tenantId: string
	conversationId: string
	role: "user" | "assistant"
	content: string
	grounding: Grounding | null
	confidence: Confidence | null
	provider: string | null
	latencyMs: number | null
	citations: Citation[]
	action: ActionRecord | null
	createdAt: string
}

export type Incident = {
	id: string
	tenantId: string
	code: string
	machineId: string
	description: string
	severity: string
	location: string
	observedAt: string
	reporter: string
	status: string
	simulated: boolean
	createdAt: string
}

/** Flat incident record returned by action providers. */
export type IncidentSummary = Incident

/** What is attached to an assistant message after an action runs. */
export type ActionRecord = {
	kind: "incident"
	simulated: boolean
	provider: string
	incident: Incident
}

export type ActivityLog = {
	id: string
	tenantId: string
	userId: string | null
	userName: string | null
	action: string
	resourceType: string
	resourceId: string | null
	status: "success" | "denied" | "error"
	detail: string | null
	requestId: string | null
	latencyMs: number | null
	createdAt: string
}

/** The authenticated principal. Produced by an AuthProvider, never by the UI. */
export type Principal = {
	tenantId: string
	userId: string
	name: string
	email: string
	roleKey: string
	department: string
	title: string
	authMode: "demo" | "entra"
}
