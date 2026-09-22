# NOVA — Enterprise Knowledge Intelligence Platform

> Your company's knowledge. One intelligent interface.

NOVA is a reusable, multi-tenant enterprise knowledge platform. A company brings its own
documents, users, roles and permissions; NOVA provides ingestion, permission-aware retrieval,
grounded answers with citations, and agentic workflows.

The repository ships with a demo tenant (**NovaTech Manufacturing**) and a second tenant
(**Acme Logistics**) that exists purely to prove tenant isolation. Nothing about either company
is hard-coded in business logic — company name, departments, roles, classifications and documents
all come from tenant data.

**Everything runs locally.** No Azure, no Microsoft Foundry, no Azure AI Search, no Entra ID,
no paid API is required or contacted. Azure adapters exist behind interfaces and are disabled.

---

## 1. Quick start (LOCAL_MODE)

```bash
cp .env.example .env       # optional: defaults already run fully locally
npm run seed-demo          # creates tenants, users, roles, documents, vector index
./start-dev                # builds the frontend and starts the server on :4317
```

Open http://127.0.0.1:4317 and click **Enter Demo**.

Other commands:

| Command | Purpose |
| --- | --- |
| `npm run seed-demo` | Seed/refresh demo data. Safe to rerun (checksum-based, idempotent). |
| `npm run reset-demo` | Delete local database + storage, then reseed from scratch. |
| `npm test` | Unit + security test suite (23 tests: 14 security + 9 platform). |
| `npm run eval` | 28-question evaluation harness across 10 categories. |
| `npm run typecheck` | Type-checks backend, scripts and tests. |
| `npm run build` | Typecheck + frontend bundle. |
| `npm run lint` / `npm run format` | Prettier check / write. |

Node 22.5+ is required (`node:sqlite` is used as the local database driver — no native deps).

---

## 2. Demo personas

Local authentication is a **DEMO PERSONA** selector, clearly labelled as non-production.
Pick a persona from the sidebar or the login page; no passwords exist.

| Persona | Email | Role | Sees |
| --- | --- | --- | --- |
| Alex Mendes | `alex@novatech.example` | EMPLOYEE (Manufacturing Operations) | Public + internal only |
| Sarah Iyer | `sarah@novatech.example` | ENGINEERING_MANAGER | + Engineering confidential |
| David Rao | `david@novatech.example` | FINANCE_MANAGER | + Finance/Procurement confidential |
| Priya Nair | `priya@novatech.example` | HR_MANAGER | + Human Resources confidential |
| Admin User | `admin@novatech.example` | ADMIN | Everything in the tenant, admin portal |

Second tenant (isolation proof): `meera@acme.example`, `admin@acme.example`.

---

## 3. Five-minute demo flow

1. **Grounded retrieval** — as Alex: *"What is our machine failure procedure?"* → grounded answer citing
   Machine Failure SOP v2026.2 with sections.
2. **Multi-document reasoning** — *"Can I approve an ₹80,000 equipment purchase?"* → combines Procurement
   Policy and Approval Matrix.
3. **Authorization** — as Alex: *"Show me the engineering salary structure."* → `ACCESS DENIED`,
   no document name, no content. Switch to Priya → authorized answer.
4. **Live ingestion** — Admin → Knowledge → Upload a new policy → ask a question that was previously
   unanswerable → the answer now cites the new document. No code changes.
5. **Agentic action** — *"Machine M-204 has malfunctioned. Help me report it."* → the agent explains the SOP,
   collects `machine_id`, `description`, `severity`, `location`, `observed_at`, `reporter`, asks for what is
   missing, and creates `INC-2026-0001` labelled **SIMULATED ACTION**.
6. **Future path** — the same interfaces map to Microsoft Foundry, Foundry IQ, Azure AI Search and Entra ID
   (see `docs/azure-integration.md`). Azure remains off.

---

## 4. Layout

```
backend/src/
  api/            HTTP router + server wiring
  agents/         query understanding, prompt, knowledge agent, incident agent
  knowledge/      KnowledgeProvider: base / local / azure_foundry_iq
  retrieval/      vector store (base/local/azure) + re-ranking
  llm/            LLMProvider: base / local / azure_foundry
  embeddings/     EmbeddingProvider: base / local / azure
  auth/           AuthProvider: base / demo / entra
  authorization/  access scope + document access policy (pre-retrieval)
  tenants/ documents/ citations/ actions/ conversations/ observability/ models/ config/ db/
frontend/src/     components/ pages/ hooks/ services/ providers/ types/ utils/
knowledge/        seed corpora: novatech/<dept>/, acme/
tests/            security + platform tests, eval question set
docs/             architecture, local-development, onboarding, ingestion, security, evaluation, azure, deployment
```

See `docs/architecture.md` for diagrams and `docs/local-development.md` for day-to-day workflow.

---

## 5. Known limitations

- No local model server is bundled. With `LOCAL_LLM_BASE_URL` empty, answers come from a deterministic
  extractive composer labelled `FALLBACK` in the UI. Point `LOCAL_LLM_BASE_URL` at any OpenAI-compatible
  endpoint (Ollama, LM Studio, vLLM) for fluent answers; retrieval, authorization and citations are unchanged.
- Local embeddings are a deterministic hashed-lexical vector (`nova-hashed-lexical-v1`), not a neural model.
  Swap via `LOCAL_EMBEDDING_BASE_URL` / `LOCAL_EMBEDDING_MODEL`.
- Evaluation currently passes 24/28; the open failures are answer-phrasing and "no data exists" cases that
  need a real model (see `docs/evaluation.md`).
- Azure adapters are implemented against documented REST APIs but are unverified against a live subscription.
- Frontend type-checking requires `@types/react`, which is not installed in this offline environment
  (`npm run typecheck:web` covers it once installed). The frontend bundle builds and runs.
