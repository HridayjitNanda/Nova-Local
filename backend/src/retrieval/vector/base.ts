/** Vector store abstraction (local SQLite-backed today, Azure AI Search later). */
import type { Classification } from "../../models/types.ts"

export type VectorRecord = {
	chunkId: string
	tenantId: string
	documentId: string
	versionId: string
	embedding: Float32Array
	text: string
	section: string
	seq: number
	keywords: string
	injectionFlags: string[]
	documentTitle: string
	department: string
	category: string
	classification: Classification
	version: string
}

/** Filters are applied inside the store so unauthorized rows never leave it. */
export type VectorQueryFilter = {
	tenantId: string
	/** Precomputed SQL authorization predicate (local store) or OData filter (Azure). */
	accessSql?: { sql: string; params: any[] }
	departments?: string[]
	onlyActiveVersions?: boolean
	maxClassificationLevel?: number
}

export interface VectorStore {
	readonly name: string
	readonly mode: "local" | "azure_search"
	upsert(records: VectorRecord[]): Promise<void>
	deleteByVersion(tenantId: string, versionId: string): Promise<void>
	deleteByDocument(tenantId: string, documentId: string): Promise<void>
	search(
		queryVector: Float32Array,
		queryTerms: string[],
		filter: VectorQueryFilter,
		limit: number,
	): Promise<Array<VectorRecord & { vectorScore: number; keywordScore: number }>>
	/** Metadata-only probe: returns counts, never text. Used for denial detection. */
	countMatchingOutsideScope?(queryTerms: string[], filter: VectorQueryFilter): Promise<number>
	/**
	 * Metadata-only probe returning how many distinct query terms the single best
	 * out-of-scope chunk matches. No text, title or metadata ever leaves the store;
	 * the agent uses this to tell "you may not see this" apart from "we do not know".
	 */
	bestTermMatchOutsideScope?(queryTerms: string[], filter: VectorQueryFilter): Promise<number>
	healthCheck(): Promise<{ ok: boolean; detail: string }>
}
