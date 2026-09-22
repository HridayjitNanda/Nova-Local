/**
 * AzureVectorStore - DISABLED unless VECTOR_STORE=azure_search.
 *
 * Maps onto the documented Azure AI Search REST data-plane:
 *   POST {endpoint}/indexes/{index}/docs/index?api-version={v}        (upsert/delete)
 *   POST {endpoint}/indexes/{index}/docs/search?api-version={v}       (hybrid search)
 *
 * Tenant isolation is expressed as an OData $filter on tenant_id, and the
 * authorization predicate is translated the same way, so filtering still
 * happens in the store - never in the application after the fact.
 */
import type { VectorQueryFilter, VectorRecord, VectorStore } from "./base.ts"

export type AzureVectorStoreOptions = {
	endpoint: string
	index: string
	apiVersion: string
	apiKey?: string
	bearerToken?: string
	vectorField?: string
}

export class AzureVectorStore implements VectorStore {
	readonly name = "AzureVectorStore"
	readonly mode = "azure_search" as const

	constructor(private readonly options: AzureVectorStoreOptions) {
		if (!options.endpoint || !options.index) {
			throw new Error("VECTOR_STORE=azure_search requires AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_INDEX")
		}
	}

	private url(path: string): string {
		return `${this.options.endpoint.replace(/\/$/, "")}/indexes/${this.options.index}/${path}?api-version=${this.options.apiVersion}`
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { "content-type": "application/json" }
		if (this.options.bearerToken) headers["authorization"] = `Bearer ${this.options.bearerToken}`
		else if (this.options.apiKey) headers["api-key"] = this.options.apiKey
		return headers
	}

	private async post(path: string, body: unknown): Promise<any> {
		const response = await fetch(this.url(path), {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		})
		if (!response.ok) throw new Error(`Azure AI Search HTTP ${response.status}`)
		return response.json()
	}

	async upsert(records: VectorRecord[]): Promise<void> {
		if (records.length === 0) return
		await this.post("docs/index", {
			value: records.map((r) => ({
				"@search.action": "mergeOrUpload",
				id: r.chunkId,
				tenant_id: r.tenantId,
				document_id: r.documentId,
				version_id: r.versionId,
				document_title: r.documentTitle,
				department: r.department,
				category: r.category,
				classification: r.classification,
				version: r.version,
				section: r.section,
				seq: r.seq,
				content: r.text,
				[this.options.vectorField ?? "content_vector"]: Array.from(r.embedding),
			})),
		})
	}

	async deleteByVersion(tenantId: string, versionId: string): Promise<void> {
		const found = await this.post("docs/search", {
			search: "*",
			filter: `tenant_id eq '${tenantId}' and version_id eq '${versionId}'`,
			select: "id",
			top: 1000,
		})
		const ids: string[] = (found.value ?? []).map((v: any) => v.id)
		if (ids.length === 0) return
		await this.post("docs/index", { value: ids.map((id) => ({ "@search.action": "delete", id })) })
	}

	async deleteByDocument(tenantId: string, documentId: string): Promise<void> {
		const found = await this.post("docs/search", {
			search: "*",
			filter: `tenant_id eq '${tenantId}' and document_id eq '${documentId}'`,
			select: "id",
			top: 1000,
		})
		const ids: string[] = (found.value ?? []).map((v: any) => v.id)
		if (ids.length === 0) return
		await this.post("docs/index", { value: ids.map((id) => ({ "@search.action": "delete", id })) })
	}

	async search(
		queryVector: Float32Array,
		queryTerms: string[],
		filter: VectorQueryFilter,
		limit: number,
	): Promise<Array<VectorRecord & { vectorScore: number; keywordScore: number }>> {
		const odata = [`tenant_id eq '${filter.tenantId}'`]
		if (filter.departments?.length) {
			odata.push(`(${filter.departments.map((d) => `department eq '${d}'`).join(" or ")})`)
		}
		if (typeof filter.maxClassificationLevel === "number") {
			odata.push(`classification_level le ${filter.maxClassificationLevel}`)
		}
		const result = await this.post("docs/search", {
			search: queryTerms.join(" "),
			filter: odata.join(" and "),
			top: limit,
			vectorQueries: queryVector.length
				? [
						{
							kind: "vector",
							vector: Array.from(queryVector),
							fields: this.options.vectorField ?? "content_vector",
							k: limit,
						},
					]
				: undefined,
		})
		return (result.value ?? []).map((v: any) => ({
			chunkId: v.id,
			tenantId: v.tenant_id,
			documentId: v.document_id,
			versionId: v.version_id,
			embedding: new Float32Array(0),
			text: v.content,
			section: v.section ?? "",
			seq: v.seq ?? 0,
			keywords: "",
			injectionFlags: [],
			documentTitle: v.document_title,
			department: v.department,
			category: v.category ?? "",
			classification: v.classification,
			version: v.version ?? "",
			vectorScore: Number(v["@search.score"] ?? 0),
			keywordScore: Number(v["@search.rerankerScore"] ?? 0),
		}))
	}

	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		try {
			await this.post("docs/search", { search: "*", top: 1 })
			return { ok: true, detail: `Azure AI Search index ${this.options.index} reachable` }
		} catch (error) {
			return { ok: false, detail: `Azure AI Search unreachable: ${(error as Error).message}` }
		}
	}
}
