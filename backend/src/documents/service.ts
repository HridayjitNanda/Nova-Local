/**
 * Document + version + chunk persistence and the ingestion pipeline:
 *   upload -> validate -> extract -> detect metadata -> chunk -> embed ->
 *   index -> store metadata -> searchable
 *
 * Nothing here knows about any specific company: every call is tenant-scoped.
 */
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Database } from "../db/index.ts"
import type {
	Classification,
	DocumentVersion,
	IngestStatus,
	KnowledgeDocument,
} from "../models/types.ts"
import { CLASSIFICATIONS } from "../models/types.ts"
import { chunkText, firstHeading } from "./chunk.ts"
import { extractText, extensionOf, ExtractionError, UnsupportedFileError } from "./extract.ts"
import { detectInjection } from "./injection.ts"
import type { EmbeddingProvider } from "../embeddings/base.ts"
import type { VectorStore } from "../retrieval/vector/base.ts"
import { floatsToBuffer } from "../embeddings/base.ts"
import { getConfig } from "../config/index.ts"
import { log, recordActivity } from "../observability/logger.ts"
import { tokenize } from "../embeddings/local.ts"

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

export class DocumentError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
	) {
		super(message)
		this.name = "DocumentError"
	}
}

export type IngestInput = {
	tenantId: string
	filename: string
	buffer: Buffer
	uploadedBy: string
	title?: string
	department?: string
	category?: string
	classification?: Classification
	version?: string
	effectiveDate?: string
	allowedRoles?: string[]
	allowedUsers?: string[]
	/** When true, a new version supersedes the previous active version. */
	activate?: boolean
}

export type IngestResult = {
	document: KnowledgeDocument
	version: DocumentVersion
	chunkCount: number
	warnings: string[]
	injectionFlags: string[]
}

function rowToDocument(r: any): KnowledgeDocument {
	return {
		id: r.id,
		tenantId: r.tenant_id,
		title: r.title,
		filename: r.filename,
		department: r.department,
		category: r.category,
		classification: r.classification,
		sourceType: r.source_type,
		status: r.status,
		allowedRoles: JSON.parse(r.allowed_roles_json || "[]"),
		allowedUsers: JSON.parse(r.allowed_users_json || "[]"),
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}
}

function rowToVersion(r: any): DocumentVersion {
	return {
		id: r.id,
		tenantId: r.tenant_id,
		documentId: r.document_id,
		version: r.version,
		status: r.status,
		effectiveDate: r.effective_date,
		uploadedAt: r.uploaded_at,
		uploadedBy: r.uploaded_by,
		storagePath: r.storage_path,
		checksum: r.checksum,
		charCount: r.char_count,
		chunkCount: r.chunk_count,
		ingestStatus: r.ingest_status,
		ingestError: r.ingest_error,
	}
}

/** Heuristic metadata detection from the document body (overridable by the admin). */
/**
 * Many enterprise documents open with a bare title line before any heading or
 * `Key: value` front matter. Treat that first line as the document title.
 */
function leadingTitleLine(head: string): string | undefined {
	for (const raw of head.split(/\r?\n/).slice(0, 5)) {
		const line = raw.trim()
		if (!line) continue
		if (line.startsWith("#")) return line.replace(/^#+\s*/, "").trim() || undefined
		// A front-matter pair or an over-long sentence is not a title.
		if (/^[A-Za-z][A-Za-z &/_-]{2,30}:\s/.test(line)) return undefined
		if (line.length < 3 || line.length > 120 || line.endsWith(".")) return undefined
		return line
	}
	return undefined
}

export function detectMetadata(text: string, filename: string) {
	const head = text.slice(0, 4000)
	const version = /version[:\s]+([0-9]{4}\.[0-9]+|v?[0-9]+\.[0-9]+)/i.exec(head)?.[1]
	const effectiveDate = /effective(?:\s+date)?[:\s]+([0-9]{4}-[0-9]{2}-[0-9]{2})/i.exec(head)?.[1]
	const department = /department[:\s]+([A-Za-z &]{3,40})/i.exec(head)?.[1]?.trim()
	const classificationMatch = /classification[:\s]+(public|internal|confidential|restricted)/i.exec(head)?.[1]
	const category = /category[:\s]+([A-Za-z &/\-]{3,40})/i.exec(head)?.[1]?.trim()
	const title =
		/^title[:\s]+(.{3,120})$/im.exec(head)?.[1]?.trim() ??
		leadingTitleLine(head) ??
		firstHeading(text) ??
		path.basename(filename, extensionOf(filename)).replace(/[_-]+/g, " ")
	return {
		title: title.replace(/^#+\s*/, "").trim(),
		version,
		effectiveDate,
		department,
		category,
		classification: classificationMatch?.toLowerCase() as Classification | undefined,
	}
}

function nextVersionLabel(previous?: string): string {
	const year = new Date().getFullYear()
	if (!previous) return `${year}.1`
	const match = /^(\d{4})\.(\d+)$/.exec(previous)
	if (match) return `${match[1]}.${Number(match[2]) + 1}`
	return `${year}.1`
}

export class DocumentService {
	constructor(
		private readonly db: Database,
		private readonly embeddings: EmbeddingProvider,
		private readonly vectorStore: VectorStore,
	) {}

	/* ----------------------------- queries ------------------------------- */

	listDocuments(tenantId: string): Array<KnowledgeDocument & { versions: DocumentVersion[] }> {
		const documents = this.db
			.all(`SELECT * FROM documents WHERE tenant_id = ? ORDER BY department, title`, tenantId)
			.map(rowToDocument)
		return documents.map((document) => ({ ...document, versions: this.listVersions(tenantId, document.id) }))
	}

	getDocument(tenantId: string, documentId: string): KnowledgeDocument | null {
		const row = this.db.get(`SELECT * FROM documents WHERE tenant_id = ? AND id = ?`, tenantId, documentId)
		return row ? rowToDocument(row) : null
	}

	listVersions(tenantId: string, documentId: string): DocumentVersion[] {
		return this.db
			.all(
				`SELECT * FROM document_versions WHERE tenant_id = ? AND document_id = ? ORDER BY uploaded_at DESC`,
				tenantId,
				documentId,
			)
			.map(rowToVersion)
	}

	activeVersion(tenantId: string, documentId: string): DocumentVersion | null {
		const row = this.db.get(
			`SELECT * FROM document_versions WHERE tenant_id = ? AND document_id = ? AND status = 'active' ORDER BY uploaded_at DESC LIMIT 1`,
			tenantId,
			documentId,
		)
		return row ? rowToVersion(row) : null
	}

	/* ---------------------------- ingestion ------------------------------ */

	async ingest(input: IngestInput): Promise<IngestResult> {
		const config = getConfig()

		// 1. VALIDATE
		if (!input.filename) throw new DocumentError("A filename is required.")
		if (input.buffer.byteLength === 0) throw new DocumentError("The uploaded file is empty.")
		if (input.buffer.byteLength > MAX_UPLOAD_BYTES) {
			throw new DocumentError(`File exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB upload limit.`)
		}
		if (input.classification && !CLASSIFICATIONS.includes(input.classification)) {
			throw new DocumentError(`Unknown classification "${input.classification}".`)
		}

		// 2. EXTRACT
		let extracted
		try {
			extracted = extractText(input.filename, input.buffer)
		} catch (error) {
			if (error instanceof UnsupportedFileError || error instanceof ExtractionError) {
				throw new DocumentError(error.message, 415)
			}
			throw new DocumentError("The file could not be processed.", 422)
		}

		// 3. DETECT METADATA (explicit admin values always win)
		const detected = detectMetadata(extracted.text, input.filename)
		const title = input.title?.trim() || detected.title
		const department = input.department?.trim() || detected.department || "General"
		const category = input.category?.trim() || detected.category || "policy"
		const classification = input.classification || detected.classification || "internal"

		const now = new Date().toISOString()
		const checksum = createHash("sha256").update(input.buffer).digest("hex")

		// 4. UPSERT DOCUMENT (filename is the per-tenant document key)
		const existing = this.db.get(
			`SELECT * FROM documents WHERE tenant_id = ? AND filename = ?`,
			input.tenantId,
			input.filename,
		)
		const documentId: string = existing?.id ?? `doc_${randomUUID()}`
		if (existing) {
			this.db.run(
				`UPDATE documents SET title = ?, department = ?, category = ?, classification = ?,
					source_type = ?, allowed_roles_json = ?, allowed_users_json = ?, updated_at = ?, status = 'active'
				 WHERE id = ? AND tenant_id = ?`,
				title,
				department,
				category,
				classification,
				extracted.sourceType,
				JSON.stringify(input.allowedRoles ?? JSON.parse(existing.allowed_roles_json || "[]")),
				JSON.stringify(input.allowedUsers ?? JSON.parse(existing.allowed_users_json || "[]")),
				now,
				documentId,
				input.tenantId,
			)
		} else {
			this.db.run(
				`INSERT INTO documents (id, tenant_id, title, filename, department, category, classification,
					source_type, status, allowed_roles_json, allowed_users_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
				documentId,
				input.tenantId,
				title,
				input.filename,
				department,
				category,
				classification,
				extracted.sourceType,
				JSON.stringify(input.allowedRoles ?? []),
				JSON.stringify(input.allowedUsers ?? []),
				now,
				now,
			)
		}

		// 5. STORE THE FILE (local blob storage, tenant-partitioned)
		const previousVersions = this.listVersions(input.tenantId, documentId)
		const versionLabel =
			input.version?.trim() ||
			detected.version ||
			nextVersionLabel(previousVersions.find((v) => v.status === "active")?.version ?? previousVersions[0]?.version)

		// Idempotent re-ingestion: identical bytes are never indexed twice, which
		// keeps `seed-demo` safe to re-run.
		const sameChecksum = previousVersions.find((v) => v.checksum === checksum)
		if (sameChecksum) {
			return {
				document: this.getDocument(input.tenantId, documentId)!,
				version: sameChecksum,
				chunkCount: sameChecksum.chunkCount,
				warnings: ["This exact file was already ingested; the existing version was reused."],
				injectionFlags: [],
			}
		}

		if (previousVersions.some((v) => v.version === versionLabel)) {
			throw new DocumentError(`Version ${versionLabel} already exists for this document.`, 409)
		}

		const storageDir = path.resolve(getConfig().paths.storageDir, input.tenantId, documentId)
		fs.mkdirSync(storageDir, { recursive: true })
		const storagePath = path.join(storageDir, `${versionLabel}${extensionOf(input.filename)}`)
		fs.writeFileSync(storagePath, input.buffer)

		const versionId = `ver_${randomUUID()}`
		this.db.run(
			`INSERT INTO document_versions (id, tenant_id, document_id, version, status, effective_date, uploaded_at,
				uploaded_by, storage_path, checksum, char_count, chunk_count, ingest_status)
			 VALUES (?, ?, ?, ?, 'inactive', ?, ?, ?, ?, ?, ?, 0, 'extracting')`,
			versionId,
			input.tenantId,
			documentId,
			versionLabel,
			input.effectiveDate || detected.effectiveDate || now.slice(0, 10),
			now,
			input.uploadedBy,
			storagePath,
			checksum,
			extracted.text.length,
		)

		// 6. CHUNK + 7. EMBED + 8. INDEX
		const injectionFlags = new Set<string>()
		let chunkCount = 0
		try {
			this.setIngestStatus(input.tenantId, versionId, "indexing")
			const chunks = chunkText(extracted.text, {
				targetChars: config.retrieval.chunkChars,
				overlapChars: config.retrieval.chunkOverlap,
			})
			const vectors = await this.embeddings.embed(chunks.map((c) => `${title}\n${c.text}`))

			for (let i = 0; i < chunks.length; i += 1) {
				const chunk = chunks[i]
				const flags = detectInjection(chunk.text)
				flags.forEach((f) => injectionFlags.add(f))
				const keywords = [...new Set(tokenize(`${chunk.section} ${chunk.text}`))].slice(0, 40).join(" ")
				this.db.run(
					`INSERT INTO document_chunks (id, tenant_id, document_id, version_id, seq, section, text,
						char_count, keywords, embedding, embedding_model, injection_flags)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					`chk_${randomUUID()}`,
					input.tenantId,
					documentId,
					versionId,
					chunk.seq,
					chunk.section,
					chunk.text,
					chunk.text.length,
					keywords,
					floatsToBuffer(vectors[i]),
					this.embeddings.model,
					JSON.stringify(flags),
				)
			}
			chunkCount = chunks.length

			// Mirror into an external vector store when one is configured.
			if (this.vectorStore.mode !== "local") {
				await this.vectorStore.upsert(
					chunks.map((chunk, i) => ({
						chunkId: `${versionId}:${chunk.seq}`,
						tenantId: input.tenantId,
						documentId,
						versionId,
						embedding: vectors[i],
						text: chunk.text,
						section: chunk.section,
						seq: chunk.seq,
						keywords: "",
						injectionFlags: detectInjection(chunk.text),
						documentTitle: title,
						department,
						category,
						classification,
						version: versionLabel,
					})),
				)
			}

			this.db.run(
				`UPDATE document_versions SET chunk_count = ?, ingest_status = 'indexed', ingest_error = NULL WHERE id = ? AND tenant_id = ?`,
				chunkCount,
				versionId,
				input.tenantId,
			)
		} catch (error) {
			this.db.run(
				`UPDATE document_versions SET ingest_status = 'failed', ingest_error = ? WHERE id = ? AND tenant_id = ?`,
				String((error as Error).message).slice(0, 300),
				versionId,
				input.tenantId,
			)
			log.error("ingestion.failed", { tenantId: input.tenantId, documentId, detail: (error as Error).message })
			throw new DocumentError("Indexing failed for this document. It was stored but is not searchable.", 500)
		}

		// 9. ACTIVATE (supersedes the previous active version)
		if (input.activate !== false) this.activateVersion(input.tenantId, documentId, versionId)

		const document = this.getDocument(input.tenantId, documentId)!
		const version = this.listVersions(input.tenantId, documentId).find((v) => v.id === versionId)!
		// Audit trail: metadata only. Document text is never written to activity logs.
		recordActivity(this.db, {
			tenantId: input.tenantId,
			userId: input.uploadedBy,
			action: "Knowledge Ingested",
			resourceType: "document",
			resourceId: documentId,
			status: "success",
			detail: `${document.title} v${versionLabel} - ${department} / ${classification} - ${chunkCount} chunks`,
		})
		log.info("ingestion.completed", {
			tenantId: input.tenantId,
			documentId,
			version: versionLabel,
			chunkCount,
			injectionFlags: [...injectionFlags],
		})
		return {
			document,
			version,
			chunkCount,
			warnings: extracted.warnings,
			injectionFlags: [...injectionFlags],
		}
	}

	private setIngestStatus(tenantId: string, versionId: string, status: IngestStatus): void {
		this.db.run(
			`UPDATE document_versions SET ingest_status = ? WHERE id = ? AND tenant_id = ?`,
			status,
			versionId,
			tenantId,
		)
	}

	/* --------------------------- lifecycle ------------------------------- */

	activateVersion(tenantId: string, documentId: string, versionId: string): DocumentVersion {
		const version = this.db.get(
			`SELECT * FROM document_versions WHERE tenant_id = ? AND document_id = ? AND id = ?`,
			tenantId,
			documentId,
			versionId,
		)
		if (!version) throw new DocumentError("Version not found.", 404)
		if (version.ingest_status !== "indexed") {
			throw new DocumentError("Only successfully indexed versions can be activated.", 409)
		}
		this.db.transaction(() => {
			this.db.run(
				`UPDATE document_versions SET status = 'inactive' WHERE tenant_id = ? AND document_id = ?`,
				tenantId,
				documentId,
			)
			this.db.run(
				`UPDATE document_versions SET status = 'active' WHERE tenant_id = ? AND id = ?`,
				tenantId,
				versionId,
			)
			this.db.run(
				`UPDATE documents SET status = 'active', updated_at = ? WHERE tenant_id = ? AND id = ?`,
				new Date().toISOString(),
				tenantId,
				documentId,
			)
		})
		return rowToVersion(
			this.db.get(`SELECT * FROM document_versions WHERE tenant_id = ? AND id = ?`, tenantId, versionId),
		)
	}

	deactivateVersion(tenantId: string, documentId: string, versionId: string): void {
		this.db.run(
			`UPDATE document_versions SET status = 'inactive' WHERE tenant_id = ? AND document_id = ? AND id = ?`,
			tenantId,
			documentId,
			versionId,
		)
	}

	/** Deactivating a document removes it from retrieval but preserves history. */
	setDocumentStatus(tenantId: string, documentId: string, status: "active" | "inactive"): void {
		this.db.run(
			`UPDATE documents SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
			status,
			new Date().toISOString(),
			tenantId,
			documentId,
		)
	}

	updateMetadata(
		tenantId: string,
		documentId: string,
		patch: {
			title?: string
			department?: string
			category?: string
			classification?: Classification
			allowedRoles?: string[]
			allowedUsers?: string[]
		},
	): KnowledgeDocument {
		const document = this.getDocument(tenantId, documentId)
		if (!document) throw new DocumentError("Document not found.", 404)
		const next = { ...document, ...patch }
		this.db.run(
			`UPDATE documents SET title = ?, department = ?, category = ?, classification = ?,
				allowed_roles_json = ?, allowed_users_json = ?, updated_at = ?
			 WHERE tenant_id = ? AND id = ?`,
			next.title,
			next.department,
			next.category,
			next.classification,
			JSON.stringify(next.allowedRoles),
			JSON.stringify(next.allowedUsers),
			new Date().toISOString(),
			tenantId,
			documentId,
		)
		return this.getDocument(tenantId, documentId)!
	}

	/** Full delete: chunks leave the retrieval index, files are removed. */
	async deleteDocument(tenantId: string, documentId: string): Promise<void> {
		const versions = this.listVersions(tenantId, documentId)
		await this.vectorStore.deleteByDocument(tenantId, documentId)
		for (const version of versions) {
			try {
				if (fs.existsSync(version.storagePath)) fs.rmSync(version.storagePath)
			} catch (error) {
				log.warn("document.file_delete_failed", { detail: (error as Error).message })
			}
		}
		this.db.run(`DELETE FROM document_chunks WHERE tenant_id = ? AND document_id = ?`, tenantId, documentId)
		this.db.run(`DELETE FROM document_versions WHERE tenant_id = ? AND document_id = ?`, tenantId, documentId)
		this.db.run(`DELETE FROM documents WHERE tenant_id = ? AND id = ?`, tenantId, documentId)
	}

	stats(tenantId: string) {
		const documents = this.db.get(
			`SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND status = 'active'`,
			tenantId,
		)
		const chunks = this.db.get(`SELECT COUNT(*) AS n FROM document_chunks WHERE tenant_id = ?`, tenantId)
		const versions = this.db.get(`SELECT COUNT(*) AS n FROM document_versions WHERE tenant_id = ?`, tenantId)
		const failed = this.db.get(
			`SELECT COUNT(*) AS n FROM document_versions WHERE tenant_id = ? AND ingest_status = 'failed'`,
			tenantId,
		)
		const departments = this.db.all(
			`SELECT department, COUNT(*) AS n FROM documents WHERE tenant_id = ? AND status = 'active' GROUP BY department ORDER BY n DESC`,
			tenantId,
		)
		return {
			documents: Number(documents?.n ?? 0),
			chunks: Number(chunks?.n ?? 0),
			versions: Number(versions?.n ?? 0),
			failedIngestions: Number(failed?.n ?? 0),
			byDepartment: departments.map((d) => ({ department: d.department, count: Number(d.n) })),
		}
	}
}
