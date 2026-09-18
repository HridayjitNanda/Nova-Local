/**
 * NOVA configuration.
 *
 * Rules enforced here:
 *  - LOCAL is the default for every provider.
 *  - Azure is NEVER auto-detected from the presence of credentials.
 *    A human must set AI_MODE / KNOWLEDGE_MODE / AUTH_MODE / ACTION_MODE.
 *  - No Azure value is read unless the matching mode was manually set.
 */
import fs from "node:fs"
import path from "node:path"

export type AiMode = "local" | "azure"
export type KnowledgeMode = "local" | "azure"
export type AuthMode = "demo" | "entra"
export type ActionMode = "local" | "azure"
export type VectorStoreMode = "local" | "azure_search"

let loaded = false

/** Minimal dotenv loader (no dependency). Existing process env always wins. */
export function loadEnv(cwd = process.cwd()): void {
	if (loaded) return
	loaded = true
	const file = path.join(cwd, ".env")
	if (!fs.existsSync(file)) return
	for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith("#")) continue
		const eq = line.indexOf("=")
		if (eq === -1) continue
		const key = line.slice(0, eq).trim()
		let value = line.slice(eq + 1).trim()
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			// Quoted values are taken literally, including any '#'.
			value = value.slice(1, -1)
		} else {
			// Strip a trailing inline comment from unquoted values, so
			//   FOUNDRY_PROJECT=nova-foundry   # the Foundry project
			// parses as exactly "nova-foundry". Only ' #' (whitespace then hash)
			// counts, so keys and URLs containing '#' survive intact.
			const comment = value.search(/\s#/)
			if (comment !== -1) value = value.slice(0, comment).trim()
		}
		// Values are never transformed in case: FOUNDRY_PROJECT must stay
		// lowercase "nova-foundry", never "NOVA-Foundry".
		if (process.env[key] === undefined) process.env[key] = value
	}
}

function str(key: string, fallback = ""): string {
	const v = process.env[key]
	return v === undefined || v === "" ? fallback : v
}

function num(key: string, fallback: number): number {
	const v = Number(process.env[key])
	return Number.isFinite(v) && process.env[key] !== "" ? v : fallback
}

/** Configuration is refused rather than silently corrected. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ConfigError"
	}
}

/**
 * Read an enum-valued variable.
 *
 * An unset/empty value takes the fallback. A value that is set but not in the
 * allowed list is a hard error: silently falling back to "local" would make an
 * operator believe Azure is on when it is not (e.g. the historical
 * `VECTOR_STORE=azure` typo, where the only supported Azure value is
 * `azure_search`).
 */
function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	const raw = str(key)
	if (raw === "") return fallback
	const v = raw.toLowerCase() as T
	if (!allowed.includes(v)) {
		throw new ConfigError(`${key}="${raw}" is not supported. Allowed values: ${allowed.join(" | ")}`)
	}
	return v
}

export type NovaConfig = ReturnType<typeof buildConfig>

function buildConfig() {
	loadEnv()

	const aiMode = oneOf<AiMode>("AI_MODE", ["local", "azure"], "local")
	const knowledgeMode = oneOf<KnowledgeMode>("KNOWLEDGE_MODE", ["local", "azure"], "local")
	const authMode = oneOf<AuthMode>("AUTH_MODE", ["demo", "entra"], "demo")
	const actionMode = oneOf<ActionMode>("ACTION_MODE", ["local", "azure"], "local")
	const vectorStore = oneOf<VectorStoreMode>("VECTOR_STORE", ["local", "azure_search"], "local")

	const dbUrl = str("DATABASE_URL", "file:./data/nova.db")
	const dbFile = dbUrl.startsWith("file:") ? dbUrl.slice("file:".length) : dbUrl

	/**
	 * APP_MODE is NOT an input. The application mode is derived from the five
	 * provider modes below, so a stray `APP_MODE=azure` must never look
	 * authoritative. If it is present it is validated against the derived value
	 * and rejected when it disagrees.
	 */
	const declaredAppMode = str("APP_MODE").toLowerCase()

	const anyAzure =
		aiMode === "azure" ||
		knowledgeMode === "azure" ||
		authMode === "entra" ||
		actionMode === "azure" ||
		vectorStore === "azure_search"

	const derivedAppMode = anyAzure ? ("azure" as const) : ("local" as const)
	if (declaredAppMode && declaredAppMode !== derivedAppMode) {
		throw new ConfigError(
			`APP_MODE="${declaredAppMode}" contradicts the provider modes, which resolve to "${derivedAppMode}". ` +
				"APP_MODE is derived, not configurable: remove it and set AI_MODE / KNOWLEDGE_MODE / AUTH_MODE / " +
				"ACTION_MODE / VECTOR_STORE instead.",
		)
	}

	return {
		/** Derived from the provider modes. Never read from APP_MODE. */
		appMode: derivedAppMode,
		modes: { aiMode, knowledgeMode, authMode, actionMode, vectorStore },
		/** True only when every provider is local/demo. Drives the LOCAL DEMO MODE badge. */
		isFullyLocal: !anyAzure,
		server: {
			port: num("PORT", 4317),
			host: str("HOST", "127.0.0.1"),
			logLevel: str("LOG_LEVEL", "info"),
		},
		paths: {
			dbFile,
			storageDir: str("STORAGE_DIR", "./data/storage"),
			seedKnowledgeDir: str("SEED_KNOWLEDGE_DIR", "./knowledge"),
			webDist: str("WEB_DIST", "./frontend/dist"),
		},
		demoAuth: { sessionSecret: str("DEMO_SESSION_SECRET", "local-dev-only-change-me") },
		localLlm: {
			baseUrl: str("LOCAL_LLM_BASE_URL"),
			model: str("LOCAL_LLM_MODEL", "qwen2.5:7b-instruct"),
			apiKey: str("LOCAL_LLM_API_KEY"),
			timeoutMs: num("LOCAL_LLM_TIMEOUT_MS", 60_000),
		},
		embeddings: {
			baseUrl: str("LOCAL_EMBEDDING_BASE_URL"),
			model: str("LOCAL_EMBEDDING_MODEL", "nova-hashed-lexical-v1"),
			dim: num("EMBEDDING_DIM", 384),
		},
		retrieval: {
			topK: num("RETRIEVAL_TOP_K", 8),
			candidates: num("RETRIEVAL_CANDIDATES", 40),
			vectorWeight: num("HYBRID_VECTOR_WEIGHT", 0.6),
			keywordWeight: num("HYBRID_KEYWORD_WEIGHT", 0.4),
			chunkChars: num("CHUNK_TARGET_CHARS", 1100),
			chunkOverlap: num("CHUNK_OVERLAP_CHARS", 150),
		},
		/** Azure settings are only materialised when a mode explicitly asks for Azure. */
		azure: anyAzure
			? {
					foundry: {
						/**
						 * Foundry PROJECT endpoint:
						 *   https://<resource>.services.ai.azure.com/api/projects/<project>
						 * The OpenAI-compatible routes hang off /openai/v1; the providers
						 * append that themselves. No api-version is used on the v1 route.
						 */
						endpoint: str("FOUNDRY_ENDPOINT").replace(/\/+$/, ""),
						project: str("FOUNDRY_PROJECT"),
						agentId: str("FOUNDRY_AGENT_ID"),
						deployment: str("FOUNDRY_MODEL_DEPLOYMENT"),
						embeddingDeployment: str("AZURE_EMBEDDING_DEPLOYMENT"),
					},
					search: {
						endpoint: str("AZURE_SEARCH_ENDPOINT"),
						index: str("AZURE_SEARCH_INDEX"),
						apiVersion: str("AZURE_SEARCH_API_VERSION", "2024-07-01"),
					},
					storage: {
						account: str("AZURE_STORAGE_ACCOUNT"),
						container: str("AZURE_STORAGE_CONTAINER"),
					},
					entra: {
						tenantId: str("AZURE_TENANT_ID"),
						clientId: str("AZURE_CLIENT_ID"),
						clientSecret: str("AZURE_CLIENT_SECRET"),
						audience: str("ENTRA_AUDIENCE"),
					},
					action: {
						workflowUrl: str("AZURE_ACTION_WORKFLOW_URL"),
						apiKey: str("AZURE_ACTION_API_KEY"),
					},
					apiKey: str("AZURE_API_KEY"),
					/**
					 * Optional pre-acquired Entra access token (scope
					 * https://ai.azure.com/.default). Preferred over a static key in
					 * production; when present it wins over AZURE_API_KEY.
					 */
					accessToken: str("AZURE_ACCESS_TOKEN"),
				}
			: null,
	}
}

let cached: NovaConfig | null = null

export function getConfig(): NovaConfig {
	if (!cached) cached = buildConfig()
	return cached
}

/** Test helper: force a fresh read of process.env. */
export function resetConfigCache(): void {
	cached = null
}
