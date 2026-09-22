# Azure integration (prepared, disabled by default)

NOVA runs entirely locally today. Azure adapters exist behind the same interfaces the local
implementations satisfy, and **nothing in this document is active** until the modes below are
changed by hand. NOVA never auto-detects Azure credentials and never silently calls Azure.

## Switching modes

```
AI_MODE=azure
KNOWLEDGE_MODE=azure
AUTH_MODE=entra
ACTION_MODE=azure
VECTOR_STORE=azure_search
```

There is **no `APP_MODE` variable**. The overall mode is derived from the provider modes
above; if `APP_MODE` is set in the environment and disagrees with the derived mode, startup
fails with a `ConfigError` telling you to remove it. Likewise, a mode variable set to an
unsupported value (for example `VECTOR_STORE=azure` instead of `azure_search`) now throws
instead of silently falling back to the local default.

No code change is required: the provider factories read configuration at startup.
The UI badge becomes **AZURE CONFIGURED** when every Azure-selected component has the real
Azure implementation loaded and all of its required non-secret settings are present. If a
setting is missing or a local implementation is loaded where Azure was selected, the badge
reads **AZURE CONFIGURED - INCOMPLETE**, with a per-component reason in
`health.azureReadiness.components`.

The badge never claims **AZURE CONNECTED**, because `/api/health` performs local
configuration and readiness checks only: it calls no Azure Foundry model, no Azure AI
Search query, and consumes zero tokens (`liveProbe: false` in the payload). Real
connectivity is proven by real application traffic — chat and embedding requests surface
structured `LLMError` / `EmbeddingError` failures — or by the manual
`npm run test:foundry` check below.

## Microsoft Foundry project (NOVA)

The Foundry project and both model deployments already exist. The project name is
lowercase `nova-foundry` everywhere — never `NOVA-Foundry`.

| Setting | Value |
| --- | --- |
| Project | `nova-foundry` |
| Project endpoint | `https://nova-foundry-hn-2376.services.ai.azure.com/api/projects/nova-foundry` |
| Chat deployment | `nova-chat` (GPT-4.1-mini, Global Standard) |
| Embedding deployment | `nova-embedding` (text-embedding-3-small, Global Standard) |

How NOVA calls it:

```
POST <FOUNDRY_ENDPOINT>/openai/v1/chat/completions
POST <FOUNDRY_ENDPOINT>/openai/v1/embeddings

Headers: api-key: <AZURE_API_KEY>        (or Authorization: Bearer <Entra token>)
Body:    { "model": "<deployment name>", ... }
```

- The **deployment name** goes in the body's `model` field — not in the URL.
- The `/openai/v1` route takes **no `api-version` query parameter**; `FOUNDRY_API_VERSION`
  has been removed from the configuration.
- `EMBEDDING_DIM` (default `384`) is sent to `text-embedding-3-small` as `dimensions`, so
  Foundry vectors match NOVA's existing vector width. A mismatch fails loudly rather than
  silently corrupting the index.
- Embeddings produced by `nova-embedding` are **not** comparable with local hashed-lexical
  vectors. Re-index after switching `AI_MODE`.

### Error and status handling

Foundry failures are categorised (`auth`, `rate_limited`, `timeout`, `bad_request`,
`not_found`, `network`, `upstream`) and carry the verbatim upstream HTTP status and request
id internally. What the NOVA API returns to a client is deliberately narrower, so upstream
authentication and resource details are never leaked:

| Upstream / category | NOVA public status |
| --- | --- |
| `rate_limited` (429) | 429 |
| `timeout` | 504 |
| everything else, including 401/403/404 | 502 |

The full category, upstream status and request id are logged server-side and surfaced in
health diagnostics; the client response carries only the safe `category` field.

### Credentials

`AZURE_API_KEY` is a **backend-only** secret, read exclusively from the environment. It is
never committed, never sent to the frontend, never logged, and never printed by tests. The
preferred production path is Microsoft Entra ID against the project endpoint (scope
`https://ai.azure.com/.default`), supplied via `AZURE_ACCESS_TOKEN` or managed identity;
when a token is present it takes precedence over the key.

### Connectivity check (manual, consumes tokens)

```
npm run test:foundry
```

This is the **only** place NOVA deliberately calls Foundry to prove connectivity, and it is
never run automatically — not by `/api/health`, not by `/api/admin/metrics`, and not by any
timer or background task. Calls `nova-chat` (expects the exact reply `NOVA Azure connection works.`) and
`nova-embedding` (prints only `Dimensions: <n>`), and exits non-zero on failure. It uses the
real NOVA providers — there is no second Foundry client in the repository.

## Variables

| Variable | Used by |
| --- | --- |
| `FOUNDRY_ENDPOINT`, `FOUNDRY_PROJECT`, `FOUNDRY_MODEL_DEPLOYMENT` | `llm/azure_foundry.ts` |
| `FOUNDRY_AGENT_ID` | Optional Foundry Agent Service target |
| `AZURE_EMBEDDING_DEPLOYMENT` | `embeddings/azure.ts` |
| `AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_INDEX`, `AZURE_SEARCH_API_VERSION` | `retrieval/vector/azure.ts`, `knowledge/azure_foundry_iq.ts` |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER` | Document storage |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `ENTRA_AUDIENCE` | `auth/entra.ts` |
| `AZURE_API_KEY` | Backend-only Foundry key; alternative to Entra / managed identity |
| `AZURE_ACCESS_TOKEN` | Optional pre-acquired Entra token (`https://ai.azure.com/.default`); wins over `AZURE_API_KEY` |
| `AZURE_ACTION_WORKFLOW_URL`, `AZURE_ACTION_API_KEY` | `actions/azure.ts` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Telemetry export |

## Azure resources required

1. **Azure AI Foundry project** with a chat model deployment (for example GPT-4o-mini or GPT-4.1) and
   an embedding deployment (`text-embedding-3-small` or larger).
2. **Azure AI Search** service and an index whose fields mirror the local vector record:
   `chunkId, tenantId, documentId, versionId, contentVector, text, section, seq, keywords,
   documentTitle, department, category, classification, version`. Use a vector profile matching
   `EMBEDDING_DIM` and enable filterable attributes on the tenant/metadata fields — security filters
   must run inside the service, not in application code.
3. **Foundry IQ knowledge source** pointing at that index if you want Foundry-managed retrieval
   instead of direct Search queries.
4. **Azure Blob Storage** account and container for original documents (encryption at rest is on by
   default).
5. **Microsoft Entra ID** app registration exposing an API scope, plus app roles or group claims that
   map to NOVA roles.
6. **Application Insights** workspace if you want telemetry export.
7. **Managed identity** (recommended over client secrets) with `Search Index Data Contributor`,
   `Search Index Data Reader`, `Storage Blob Data Contributor` and `Cognitive Services OpenAI User`
   role assignments.

## Implementation notes

- The Foundry adapters call the OpenAI-compatible v1 routes on the project endpoint
  (`chat/completions`, `embeddings`). The Azure AI Search adapter keeps its own
  `api-version` because Search is a different service. No SDK classes or methods are
  invented, and the deprecated Assistants API is not used.
- Tenant isolation carries over as an OData filter (`tenantId eq '...'` plus classification and
  department predicates) applied by the service, exactly like the local SQL predicate.
- Entra tokens are validated for issuer, audience and signature; the resulting claims are mapped into
  the same `AccessScope` the demo provider produces, so authorization logic is unchanged.
- These adapters have not been executed against a live subscription from this repository. Treat the
  first Azure run as an integration test: verify each health check individually before enabling all
  modes at once.

---

## Actual readiness state

This file documents configuration. For what is actually implemented versus
what still requires Azure resources or live verification, see
`azure-readiness-status.md`. Environment variables alone never mean a
capability is implemented or connected.
