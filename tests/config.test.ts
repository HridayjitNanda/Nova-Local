/**
 * Configuration and Azure-readiness suite.
 *
 * Covers the two failure modes that previously let NOVA lie about its state:
 *
 *   1. a mode variable set to an unsupported value silently falling back to
 *      local (the `VECTOR_STORE=azure` typo), and
 *   2. a badge claiming more than the evidence supports.
 *
 * Nothing here touches the network: `computeAzureReadiness` is pure (it reads
 * modes, provider identity and local settings only), and the config tests only
 * manipulate process.env. Since v10 there is no live probe anywhere in the
 * health path, so the strongest badge is AZURE CONFIGURED - never CONNECTED.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { ConfigError, getConfig, resetConfigCache } from "../backend/src/config/index.ts"
import {
	componentSummary,
	computeAzureReadiness,
	type AzureConfigSnapshot,
	type ReadinessModes,
	type ReadinessProviders,
} from "../backend/src/api/health.ts"

const MODE_KEYS = [
	"APP_MODE",
	"AI_MODE",
	"KNOWLEDGE_MODE",
	"AUTH_MODE",
	"ACTION_MODE",
	"VECTOR_STORE",
] as const

/** Run `fn` with an exact mode environment, then restore the previous one. */
function withEnv<T>(env: Partial<Record<(typeof MODE_KEYS)[number], string>>, fn: () => T): T {
	const previous = new Map<string, string | undefined>()
	for (const key of MODE_KEYS) {
		previous.set(key, process.env[key])
		delete process.env[key]
	}
	for (const [key, value] of Object.entries(env)) process.env[key] = value
	resetConfigCache()
	try {
		return fn()
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		resetConfigCache()
	}
}

/* ------------------------------ configuration ----------------------------- */

test("an unsupported VECTOR_STORE value is rejected instead of falling back to local", () => {
	withEnv({ VECTOR_STORE: "azure" }, () => {
		assert.throws(() => getConfig(), (error: unknown) => {
			assert.ok(error instanceof ConfigError)
			assert.match((error as Error).message, /VECTOR_STORE/)
			assert.match((error as Error).message, /azure_search/)
			return true
		})
	})
})

test("azure_search is the supported Azure vector store value", () => {
	withEnv({ VECTOR_STORE: "azure_search" }, () => {
		const config = getConfig()
		assert.equal(config.modes.vectorStore, "azure_search")
		assert.equal(config.isFullyLocal, false)
		assert.equal(config.appMode, "azure")
	})
})

test("an unsupported AI_MODE value is rejected", () => {
	withEnv({ AI_MODE: "cloud" }, () => {
		assert.throws(() => getConfig(), ConfigError)
	})
})

test("APP_MODE that contradicts the provider modes is rejected", () => {
	withEnv({ APP_MODE: "azure" }, () => {
		assert.throws(() => getConfig(), (error: unknown) => {
			assert.ok(error instanceof ConfigError)
			assert.match((error as Error).message, /APP_MODE/)
			assert.match((error as Error).message, /derived/)
			return true
		})
	})
})

test("appMode is derived from the provider modes, not from APP_MODE", () => {
	withEnv({}, () => {
		assert.equal(getConfig().appMode, "local")
	})
	withEnv({ AI_MODE: "azure" }, () => {
		const config = getConfig()
		assert.equal(config.appMode, "azure")
		assert.equal(config.isFullyLocal, false)
	})
})

/* ------------------------------- readiness -------------------------------- */

const LOCAL_MODES: ReadinessModes = {
	aiMode: "local",
	knowledgeMode: "local",
	authMode: "demo",
	actionMode: "local",
	vectorStore: "local",
}

const AZURE_MODES: ReadinessModes = {
	aiMode: "azure",
	knowledgeMode: "azure",
	authMode: "entra",
	actionMode: "azure",
	vectorStore: "azure_search",
}

/** A complete, syntactically valid Azure settings snapshot. No real secrets. */
function azureSnapshot(overrides: Partial<NonNullable<AzureConfigSnapshot>> = {}): AzureConfigSnapshot {
	return {
		foundry: {
			endpoint: "https://example.services.ai.azure.com/api/projects/nova-foundry",
			deployment: "nova-chat",
			embeddingDeployment: "nova-embedding",
			hasCredential: true,
		},
		search: { endpoint: "https://example.search.windows.net", index: "nova-index" },
		storage: { account: "novastorage", container: "nova" },
		entra: { tenantId: "tenant", clientId: "client", audience: "api://nova" },
		action: { workflowUrl: "https://example.logic.azure.com/workflows/nova" },
		embeddingDim: 1536,
		...overrides,
	}
}

function providers(overrides: Partial<ReadinessProviders> = {}): ReadinessProviders {
	return {
		llm: { mode: "azure" },
		embeddings: { mode: "azure" },
		knowledge: { mode: "azure" },
		vectorStore: { mode: "azure_search" },
		auth: { mode: "entra" },
		actions: { mode: "azure" },
		...overrides,
	}
}

function localProviders(): ReadinessProviders {
	return {
		llm: { mode: "local" },
		embeddings: { mode: "local" },
		knowledge: { mode: "local" },
		vectorStore: { mode: "local" },
		auth: { mode: "demo" },
		actions: { mode: "local" },
	}
}

test("a fully local deployment reports LOCAL DEMO MODE", () => {
	const readiness = computeAzureReadiness(LOCAL_MODES, localProviders(), null)
	assert.equal(readiness.badge, "LOCAL DEMO MODE")
	assert.equal(readiness.status, "local")
	assert.equal(readiness.azureConfigured, false)
	assert.equal(readiness.partial, false)
	assert.deepEqual(readiness.azureComponents, [])
	assert.equal(readiness.components.llm.state, "local")
})

test("azure configuration with a local implementation loaded is misconfigured", () => {
	const readiness = computeAzureReadiness(
		AZURE_MODES,
		providers({ llm: { mode: "local" } }),
		azureSnapshot(),
	)
	assert.equal(readiness.badge, "AZURE CONFIGURED - INCOMPLETE")
	assert.equal(readiness.status, "configuration_incomplete")
	assert.equal(readiness.azureConfigured, false)
	assert.equal(readiness.components.llm.state, "misconfigured")
	assert.ok(readiness.incompleteComponents.includes("llm"))
})

test("a partial azure configuration is reported as partial", () => {
	const readiness = computeAzureReadiness(
		{ ...LOCAL_MODES, aiMode: "azure" },
		providers(),
		azureSnapshot(),
	)
	assert.equal(readiness.partial, true)
	assert.deepEqual(readiness.azureComponents, ["llm", "embeddings"])
	assert.equal(readiness.components.knowledge.state, "local")
	assert.equal(readiness.badge, "AZURE CONFIGURED")
})

test("a missing deployment name downgrades the component to incomplete", () => {
	const snapshot = azureSnapshot()
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), {
		...snapshot!,
		foundry: { ...snapshot!.foundry, embeddingDeployment: "" },
	})
	assert.equal(readiness.badge, "AZURE CONFIGURED - INCOMPLETE")
	assert.equal(readiness.components.embeddings.state, "incomplete")
	assert.deepEqual(readiness.incompleteComponents, ["embeddings"])
	assert.match(readiness.components.embeddings.detail ?? "", /AZURE_EMBEDDING_DEPLOYMENT/)
})

test("a missing credential downgrades foundry and embeddings", () => {
	const snapshot = azureSnapshot()
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), {
		...snapshot!,
		foundry: { ...snapshot!.foundry, hasCredential: false },
	})
	assert.equal(readiness.azureConfigured, false)
	assert.deepEqual(readiness.incompleteComponents, ["llm", "embeddings"])
})

test("an invalid embedding dimension is caught locally", () => {
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), azureSnapshot({ embeddingDim: 0 }))
	assert.equal(readiness.components.embeddings.state, "incomplete")
	assert.match(readiness.components.embeddings.detail ?? "", /EMBEDDING_DIM/)
})

test("a non-https endpoint is rejected syntactically, without a network call", () => {
	const snapshot = azureSnapshot()
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), {
		...snapshot!,
		foundry: { ...snapshot!.foundry, endpoint: "not-a-url" },
	})
	assert.equal(readiness.components.llm.state, "incomplete")
	assert.match(readiness.components.llm.detail ?? "", /FOUNDRY_ENDPOINT/)
})

test("AZURE CONFIGURED requires every selected component complete and correctly loaded", () => {
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), azureSnapshot())
	assert.equal(readiness.badge, "AZURE CONFIGURED")
	assert.equal(readiness.status, "configured")
	assert.equal(readiness.azureConfigured, true)
	assert.equal(readiness.partial, false)
	assert.equal(readiness.incompleteComponents.length, 0)
	assert.equal(readiness.azureComponents.length, 6)
})

test("readiness never claims a live connection", () => {
	const readiness = computeAzureReadiness(AZURE_MODES, providers(), azureSnapshot())
	const serialized = JSON.stringify(readiness)
	assert.doesNotMatch(serialized, /CONNECTED/)
	assert.doesNotMatch(serialized, /verified/i)
})

test("componentSummary never leaks more than configured / not_configured / local", () => {
	const status = (state: "configured" | "local" | "incomplete" | "misconfigured") => ({
		configured: state === "configured",
		implementation: "azure",
		state,
	})
	assert.equal(componentSummary(status("configured")), "configured")
	assert.equal(componentSummary(status("local")), "local")
	assert.equal(componentSummary(status("misconfigured")), "not_configured")
	assert.equal(componentSummary(status("incomplete")), "not_configured")
	assert.equal(componentSummary(undefined), "not_configured")
})
