/**
 * AzureKnowledgeProvider (Foundry IQ / Azure AI Search) - DISABLED unless
 * KNOWLEDGE_MODE=azure.
 *
 * It reuses the same KnowledgeProvider contract as the local implementation, so
 * the chat service is unchanged when this is switched on. Retrieval runs against
 * an Azure AI Search index (the store that Foundry IQ knowledge sources use),
 * with tenant + authorization expressed as an OData filter so trimming happens
 * service-side.
 */
import type { KnowledgeProvider, RetrievalRequest, RetrievalResult } from "./base.ts"
import type { VectorStore } from "../retrieval/vector/base.ts"
import type { EmbeddingProvider } from "../embeddings/base.ts"
import { CLASSIFICATION_LEVEL } from "../models/types.ts"
import type { RetrievedChunk } from "../models/types.ts"
import { rerank } from "../retrieval/rerank.ts"
import { getConfig } from "../config/index.ts"

export class AzureKnowledgeProvider implements KnowledgeProvider {
	readonly name = "AzureKnowledgeProvider"
	readonly mode = "azure" as const

	constructor(
		private readonly vectorStore: VectorStore,
		private readonly embeddings: EmbeddingProvider,
	) {}

	async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
		const started = Date.now()
		const config = getConfig()
		const topK = request.topK ?? config.retrieval.topK

		// Authorization is translated into store-side filters (security trimming).
		const departments = request.scope.isAdmin
			? undefined
			: Object.keys(request.scope.grants).filter((d) => d !== "*")
		const maxClassificationLevel = request.scope.isAdmin
			? CLASSIFICATION_LEVEL.restricted
			: request.scope.maxLevelAnywhere

		const queryVector = await this.embeddings.embedOne([request.question, ...request.terms].join(" "))
		const raw = await this.vectorStore.search(
			queryVector,
			[request.question, ...request.terms],
			{
				tenantId: request.scope.tenantId,
				departments: departments?.length ? departments : undefined,
				maxClassificationLevel,
				onlyActiveVersions: true,
			},
			config.retrieval.candidates,
		)

		const candidates: RetrievedChunk[] = raw.map((r) => ({
			chunkId: r.chunkId,
			tenantId: r.tenantId,
			documentId: r.documentId,
			versionId: r.versionId,
			documentTitle: r.documentTitle,
			department: r.department,
			category: r.category,
			classification: r.classification,
			version: r.version,
			section: r.section,
			seq: r.seq,
			text: r.text,
			vectorScore: r.vectorScore,
			keywordScore: r.keywordScore,
			score: 0,
			injectionFlags: [],
		}))

		const chunks = rerank(
			candidates,
			{
				vectorWeight: config.retrieval.vectorWeight,
				keywordWeight: config.retrieval.keywordWeight,
				userDepartment: request.scope.department,
				hintedDepartments: request.hintedDepartments,
				hintedCategories: request.hintedCategories,
			},
			topK,
		)

		return {
			chunks,
			diagnostics: {
				provider: this.name,
				candidateCount: candidates.length,
				returnedCount: chunks.length,
				vectorWeight: config.retrieval.vectorWeight,
				keywordWeight: config.retrieval.keywordWeight,
				embeddingModel: this.embeddings.model,
				latencyMs: Date.now() - started,
				restrictedMatches: 0,
				departmentsSearched: [...new Set(candidates.map((c) => c.department))],
			},
		}
	}

	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		return this.vectorStore.healthCheck()
	}
}
