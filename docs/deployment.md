# Deployment

## Local / demo (supported today)

Single Node process serving the API and the built frontend, with SQLite and local file storage.

```bash
npm run build        # typecheck + frontend bundle
npm run seed-demo
npm start            # listens on HOST:PORT (default 127.0.0.1:4317)
```

Persistent state lives in `data/nova.db` and `data/storage/`. Back up or delete that directory to
snapshot or reset an environment; `npm run reset-demo` does the latter safely.

Recommended process supervision: any standard runner (systemd, pm2, Docker with a Node 22.5+ base
image). Set `HOST=0.0.0.0` only behind a reverse proxy that terminates TLS.

## Configuration checklist for a shared environment

| Variable | Why |
| --- | --- |
| `DEMO_SESSION_SECRET` | Must be changed from the default; signs demo session tokens |
| `DATABASE_URL`, `STORAGE_DIR` | Point at durable, backed-up volumes |
| `LOG_LEVEL` | `info` in normal operation; logs are structured JSON |
| `LOCAL_LLM_BASE_URL` | Set to a real model endpoint so answers are not the labelled fallback |
| `AUTH_MODE` | `demo` is explicitly not production authentication |

Never commit `.env`; it is git-ignored. Secrets are read from the environment only and are redacted
from logs.

## Production posture

The demo auth provider is a persona selector, not authentication. A production deployment should run
`AUTH_MODE=entra` (or another real identity provider implementing `AuthProvider`) behind TLS, with
SQLite replaced by a managed database if concurrency demands it. The data-access layer is already
centralised in `backend/src/db/`, and authorization is expressed as a predicate pushed into the store,
so the security model survives that swap.

## Azure deployment path (not active)

1. Provision the resources listed in `docs/azure-integration.md`.
2. Deploy the same container/process to App Service or Container Apps with a managed identity.
3. Set `AI_MODE/KNOWLEDGE_MODE/AUTH_MODE/ACTION_MODE/VECTOR_STORE` to their Azure values
   (`VECTOR_STORE=azure_search`). There is no `APP_MODE` variable; the overall mode is derived.
4. Re-index knowledge into Azure AI Search (embeddings must be regenerated with the Azure embedding
   deployment; embedding models are not interchangeable).
5. Confirm `/api/health` reports **AZURE CONFIGURED** (not `- INCOMPLETE`) for every provider. That
   badge means configuration is complete and the Azure implementations are loaded; it is a local
   check that makes no Azure model call. To prove live connectivity, run `npm run test:foundry`
   once by hand or simply issue a real chat/knowledge request.

Until step 3 is performed by hand, no Azure endpoint is contacted.

## Operations

- **Health** — `GET /api/health` returns mode, badge and per-provider configuration state. It is a
  local-only, zero-model-usage endpoint: no LLM, embedding or Search request is made, so it is safe
  to poll from a load balancer or uptime monitor. `liveProbe` is always `false`.
- **Audit** — `/admin/activity` and `GET /api/admin/activity`; metadata only, never document text.
- **Metrics** — `/admin` shows documents, knowledge sources, users, queries, average latency, citation
  rate, access-denied attempts, incidents and system status.
- **Knowledge lifecycle** — upload a new version and activate it; deactivate or delete removes content
  from retrieval immediately while preserving the audit trail.
