import type { KnowledgeProvider } from "./base.ts"
import { LocalKnowledgeProvider } from "./local.ts"
import { AzureKnowledgeProvider } from "./azure_foundry_iq.ts"
import { LocalVectorStore } from "../retrieval/vector/local.ts"
import { AzureVectorStore } from "../retrieval/vector/azure.ts"
import type { VectorStore } from "../retrieval/vector/base.ts"
import type { EmbeddingProvider } from "../embeddings/base.ts"
import type { Database } from "../db/index.ts"
import { getConfig } from "../config/index.ts"

export function createVectorStore(db: Database): VectorStore {
	const config = getConfig()
	if (config.modes.vectorStore === "azure_search") {
		return new AzureVectorStore({
			endpoint: config.azure?.search.endpoint ?? "",
			index: config.azure?.search.index ?? "",
			apiVersion: config.azure?.search.apiVersion ?? "2024-07-01",
			apiKey: config.azure?.apiKey,
		})
	}
	return new LocalVectorStore(db)
}

export function createKnowledgeProvider(vectorStore: VectorStore, embeddings: EmbeddingProvider): KnowledgeProvider {
	const config = getConfig()
	if (config.modes.knowledgeMode === "azure") {
		return new AzureKnowledgeProvider(vectorStore, embeddings)
	}
	return new LocalKnowledgeProvider(vectorStore, embeddings)
}

export type { KnowledgeProvider, RetrievalRequest, RetrievalResult } from "./base.ts"

// minor update 12
// minor update 19