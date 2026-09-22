# Azure readiness - actual state

Companion to `azure-integration.md`, which describes how the Azure adapters are
*configured*. This file records what is actually true today. It separates four
states and never conflates them:

1. **Already coded adapter** - code exists in this repository
2. **Resource required in Azure** - nothing works until it is provisioned
3. **Live subscription verification required** - never exercised against Azure
4. **Production infrastructure still missing** - not implemented at all

| Capability | State | Evidence in repo |
| --- | --- | --- |
| LLM (Microsoft Foundry, `nova-chat`) | 1 + 3 (resource **exists**) | `backend/src/llm/azure_foundry.ts`, `backend/src/azure/foundry.ts` |
| Knowledge (Foundry IQ) | 1 + 2 + 3 | `backend/src/knowledge/azure_foundry_iq.ts` |
| Embeddings (Microsoft Foundry, `nova-embedding`) | 1 + 3 (resource **exists**) | `backend/src/embeddings/azure.ts` |
| Vector store | 1 + 2 + 3 | `backend/src/retrieval/vector/azure.ts` |
| Auth (Entra ID) | 1 + 2 + 3 | `backend/src/auth/entra.ts` |
| Actions | 1 + 2 + 3 | `backend/src/actions/azure.ts` |
| Azure Blob Storage | 4 | Documents are written to local disk (`fs.writeFileSync`, `backend/src/documents/service.ts`) |
| PostgreSQL | 4 | SQLite only (`DatabaseSync` from `node:sqlite`, `backend/src/db/index.ts`) |
| Application Insights | 4 | Local redacting logger only (`backend/src/observability/logger.ts`) |
| Managed Identity | 4 | No `DefaultAzureCredential` anywhere in `backend/src` |
| Key Vault | 4 | Secrets are read from environment/config only |
| App Service / Container Apps | 4 | No IaC, pipeline or deployment manifest in the repository |

## Microsoft Foundry connection status

| Item | Status |
| --- | --- |
| Foundry project `nova-foundry` | **DEPLOYED** (exists in Azure) |
| Chat deployment `nova-chat` (GPT-4.1-mini) | **DEPLOYED** |
| Embedding deployment `nova-embedding` (text-embedding-3-small) | **DEPLOYED** |
| NOVA chat adapter against the v1 route | **IMPLEMENTED** |
| NOVA embedding adapter against the v1 route | **IMPLEMENTED** |
| Live chat call to `nova-chat` | **NOT VERIFIED (not run)** |
| Live embedding call to `nova-embedding` | **NOT VERIFIED (not run)** |
| `/api/health` against Foundry | **N/A - health makes no Foundry call (zero-token, local-only)** |
| Azure AI Search / Foundry IQ | **NOT CONNECTED** |
| Azure Blob Storage | **NOT CONNECTED** |
| PostgreSQL / Neon | **NOT CONNECTED** |
| Microsoft Entra ID | **NOT CONNECTED** |
| Application Insights | **NOT CONNECTED** |

The adapters were written against the documented Foundry v1 surface but have
not been executed against the live project from this revision. Run
`npm run test:foundry` locally to move the two **NOT VERIFIED** rows; it
prints `CHAT PASS`, `EMBEDDING PASS` and `RESULT: PASS` and exits non-zero on
any failure.

Azure AI Search, Blob Storage, Neon/PostgreSQL and Entra ID are **not yet
implemented end to end** and are deliberately later phases; only their adapter
seams exist.

## Provider abstractions (preserved)

`LLMProvider`, `KnowledgeProvider`, `VectorStore`, `EmbeddingProvider`,
`AuthProvider` and `ActionProvider` remain the only seams between the
application and any backend. Azure configuration stays separate from local
mode, and the model and embedding deployments remain configurable through
`FOUNDRY_MODEL_DEPLOYMENT` and `AZURE_EMBEDDING_DEPLOYMENT`. No model name is
hard-coded into application logic.

## Honest connection status (local-only, zero-token)

The badge is computed by `computeAzureReadiness` in
`backend/src/api/health.ts` (unit-tested in `tests/config.test.ts` and
`tests/health.test.ts`) and served by `backend/src/api/server.ts`. The function
is pure: it reads the selected modes, the `mode` reported by the provider
instances that were actually constructed, and the presence of the required
non-secret settings. It performs no network request of any kind.

- `LOCAL DEMO MODE` - no component is configured for Azure
- `AZURE CONFIGURED` - every Azure-selected component has the real Azure
  implementation loaded and all of its required settings present
- `AZURE CONFIGURED - INCOMPLETE` - at least one Azure-selected component is
  missing required settings, or a local implementation is loaded where Azure
  was selected

Per-component state (`local`, `configured`, `incomplete`, `misconfigured`) is
returned in `health.azureReadiness.components`, with a `detail` that names the
missing settings but never their values.

There is deliberately **no** `AZURE CONNECTED` badge any more. Claiming a live
connection required calling `nova-chat` with a "ping" and `nova-embedding` with
"health" on every health request, which burned model tokens for no operational
benefit. `/api/health` therefore reports `liveProbe: false` and never implies
that a remote request succeeded. Live connectivity is demonstrated by real
chat/embedding traffic, or by running `npm run test:foundry` manually.

## Bottom line

NOVA is **Azure-pluggable, not Azure-deployed**. Storage, database, telemetry,
identity and secret management are still local-mode implementations. Claiming
"fully Azure ready" would be false until the state-4 rows above are built and
the state-3 rows are verified against a live subscription.

See `production-blockers.md` for session strategy, CSP, rate limiting and the
per-command test verification status.
