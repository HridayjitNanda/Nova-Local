import type {
	ActivityEntry,
	AdminMetrics,
	ChatResponse,
	Conversation,
	HealthResponse,
	KnowledgeDocument,
	Me,
	Message,
	Permission,
	Persona,
	Role,
} from "../types/index.ts"

const TOKEN_KEY = "nova.token"

export function getToken(): string | null {
	return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string | null): void {
	if (token) localStorage.setItem(TOKEN_KEY, token)
	else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message)
	}
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers)
	const token = getToken()
	if (token) headers.set("authorization", `Bearer ${token}`)
	if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json")

	let response: Response
	try {
		response = await fetch(path, { ...init, headers })
	} catch {
		throw new ApiError("Cannot reach the NOVA server. Is it running?", 0, "network")
	}
	const text = await response.text()
	const data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
	if (!response.ok) {
		throw new ApiError(String(data.error ?? "Request failed."), response.status, data.code as string)
	}
	return data as T
}

export const api = {
	health: () => request<HealthResponse>("/api/health"),
	tenants: () => request<{ tenants: Array<{ id: string; name: string; slug: string; industry: string; departments: string[] }> }>("/api/tenants"),
	personas: (tenantId?: string) =>
		request<{ tenant: { id: string; name: string } | null; personas: Persona[]; notice: string }>(
			`/api/personas${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ""}`,
		),
	signIn: (body: { tenantId?: string; userId?: string; email?: string }) =>
		request<{ token: string; principal: { userId: string; tenantId: string; name: string } }>("/api/session", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	me: () => request<Me>("/api/me"),

	conversations: () => request<{ conversations: Conversation[] }>("/api/conversations"),
	conversation: (id: string) => request<{ conversation: Conversation; messages: Message[] }>(`/api/conversations/${id}`),
	deleteConversation: (id: string) => request<{ ok: true }>(`/api/conversations/${id}`, { method: "DELETE" }),
	chat: (body: { message: string; conversationId?: string }) =>
		request<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify(body) }),
	feedback: (messageId: string, feedback: "up" | "down" | null) =>
		request<{ ok: true }>(`/api/messages/${messageId}/feedback`, { method: "POST", body: JSON.stringify({ feedback }) }),

	knowledge: () =>
		request<{ documents: KnowledgeDocument[]; stats: AdminMetrics["documents"] }>("/api/knowledge"),
	upload: (form: FormData) => request<{ message: string; results: Array<Record<string, any>> }>("/api/knowledge/upload", { method: "POST", body: form }),
	updateDocument: (id: string, patch: Record<string, unknown>) =>
		request<{ document: KnowledgeDocument }>(`/api/knowledge/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
	activateVersion: (id: string, versionId: string) =>
		request<{ version: unknown }>(`/api/knowledge/${id}/versions/${versionId}/activate`, { method: "POST" }),
	deactivateVersion: (id: string, versionId: string) =>
		request<{ ok: true }>(`/api/knowledge/${id}/versions/${versionId}/deactivate`, { method: "POST" }),
	deleteDocument: (id: string) => request<{ ok: true }>(`/api/knowledge/${id}`, { method: "DELETE" }),

	metrics: () => request<AdminMetrics>("/api/admin/metrics"),
	activity: () => request<{ activity: ActivityEntry[] }>("/api/admin/activity"),
	users: () => request<{ users: Persona[]; roles: Role[] }>("/api/admin/users"),
	createUser: (body: Record<string, string>) => request<{ user: Persona }>("/api/admin/users", { method: "POST", body: JSON.stringify(body) }),
	roles: () =>
		request<{ roles: Role[]; permissions: Permission[]; departments: string[]; classifications: string[] }>("/api/admin/roles"),
	createRole: (body: Record<string, unknown>) => request<{ role: Role }>("/api/admin/roles", { method: "POST", body: JSON.stringify(body) }),
	settings: () => request<Record<string, any>>("/api/admin/settings"),
	updateSettings: (body: Record<string, unknown>) => request<Record<string, any>>("/api/admin/settings", { method: "PATCH", body: JSON.stringify(body) }),

	incidents: () => request<{ incidents: Array<Record<string, any>>; simulated: boolean }>("/api/incidents"),
	onboard: (body: Record<string, unknown>) =>
		request<{ tenant: { id: string; name: string }; admin: Persona; session: { token: string } }>("/api/onboarding/tenants", {
			method: "POST",
			body: JSON.stringify(body),
		}),
}
