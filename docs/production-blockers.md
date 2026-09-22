# Production blockers & verification status

This document is deliberately unflattering. It records what is **implemented**,
what is **tested**, what is **unverified**, and what is **planned**, using only
what can be read in this repository.

Rule applied throughout: the presence of an environment variable, a config key
or an adapter file is **not** evidence that a cloud resource exists or works.

---

## 1. Test execution status for this revision

| Command | Status | Note |
| --- | --- | --- |
| `npm ci` | **NOT RUN** | The environment that produced this revision had no npm registry network access. |
| `npm test` | **NOT RUN** | Not executed in the environment that produced this revision. |
| `npm run eval` | **NOT RUN** | Not executed. Requires a seeded database. |
| `npm run typecheck` | **NOT RUN** | Not executed. |
| `npm run typecheck:web` | **NOT RUN** | Not executed. Requires `@types/react`. |
| `npm run build` | **NOT RUN** | Not executed. |
| `npm run test:foundry` | **NOT RUN** | Not executed, and the environment had no outbound network access; no live call was made to `nova-chat` or `nova-embedding`. |

No claim of passing tests is made anywhere in this repository for this
revision. To verify locally, on a machine with registry access:

```bash
npm ci
npm test
npm run eval
npm run typecheck
npm run typecheck:web
npm run build

# Foundry connectivity (requires AZURE_API_KEY or AZURE_ACCESS_TOKEN in .env)
npm run test:foundry
```

The Microsoft Foundry integration in this revision is **implemented but
unverified**. No chat completion or embedding call was executed against
`nova-foundry`. Note that `/api/health` can no longer verify anything remotely
by design: it is a local-only, zero-model-usage endpoint.

### Counts observed by reading the source (not by execution)

| Suite | Count | File |
| --- | --- | --- |
| Security tests | 14 | `tests/security.test.ts` (cases 1-14) |
| Platform tests | 9 | `tests/platform.test.ts` |
| Config / Azure-readiness tests | 15 | `tests/config.test.ts` |
| Health (zero-token) tests | 10 | `tests/health.test.ts` |
| **`npm test` total** | **48** | |
| Evaluation questions | 28 | `tests/eval/questions.json` |

Evaluation categories present in `questions.json`: simple retrieval (5),
semantic retrieval (4), multi-document reasoning (3), authorization (3),
prompt injection (3), unknown questions (2), hallucination (2), document
versioning (2), cross-tenant isolation (2), agentic actions (2). All 10
required categories are covered, so no questions were added or rewritten, and
no second evaluation file was created.

---

## 2. Azure readiness

Full breakdown in `azure-readiness-status.md`. Summary:

- **Coded adapters** exist for LLM, knowledge, embeddings, vector store, auth
  and actions.
- **Not implemented at all**: Azure Blob Storage, PostgreSQL, Application
  Insights, Managed Identity, Key Vault, and any App Service / Container Apps
  deployment definition.
- Documents are still written to the local filesystem
  (`backend/src/documents/service.ts`) and state still lives in SQLite via
  `node:sqlite` (`backend/src/db/index.ts`).
- **No adapter has been exercised against a live Azure subscription.**

NOVA is Azure-pluggable, not Azure-deployed. The connection states
(`LOCAL DEMO MODE`, `AZURE CONFIGURED`, `AZURE CONFIGURED - INCOMPLETE`)
remain distinct and are computed locally in `backend/src/api/health.ts`:
`AZURE CONFIGURED` requires that every Azure-selected component has the real
Azure implementation loaded and all required settings present. A partial or
misconfigured Azure setup reads `- INCOMPLETE`.

The badge deliberately stops short of claiming connectivity. `/api/health` and
`/api/admin/metrics` make **no** model, embedding or Search request, so they
cost zero tokens and cannot assert that Foundry answered. Live connectivity is
evidenced by real application requests or by the manual `npm run test:foundry`
check.

---

## 3. Production blockers

### 3.1 Session strategy - BLOCKER

Current: a demo bearer token held in `localStorage`. This is LOCAL DEMO
authentication, not production authentication; any successful XSS can read it.

Target: `HttpOnly; Secure; SameSite` cookie sessions with CSRF protection
(double-submit token or origin-bound synchroniser).

Why documented rather than implemented: it changes the auth surface of every
request path, the login and persona-switch flows, and the frontend API client
at once. A partial migration would leave two half-trusted credential paths
live simultaneously, which is worse than one clearly-labelled demo path. The
demo flow is intentionally left working and intentionally not described as
production-grade.

### 3.2 Content Security Policy - PARTIAL

The policy in `backend/src/api/security.ts` still contains:

- `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`
- `font-src 'self' https://fonts.gstatic.com data:`

What genuinely requires them today:

- **Inline styles**: components set dynamic `style={{...}}` values (animation
  delays, `--fill` meters, column ratios), which React emits as inline style
  attributes.
- **External fonts**: `frontend/index.html` loads Archivo Black, Anton, Inter,
  IBM Plex Mono, Instrument Serif and Caveat from Google Fonts.
- Hero imagery and the frame sequence are same-origin and need no exception.

A nonce-based CSP that removes `'unsafe-inline'` requires a server-rendered
document so a per-response nonce can be injected. This project serves a static
`index.html`, so there is nowhere to mint one. Remaining hardening item:
either self-host the fonts (removes both Google Fonts exceptions) or introduce
server-side rendering of the shell (enables nonces). Neither was attempted
here, because guessing would break font loading or the application itself.

### 3.3 Rate limiting - SCALING LIMITATION, NOT A DEFECT

The limiter is in-process (`backend/src/api/security.ts`).

- Single backend instance: **supported**.
- Multiple backend instances: **requires distributed rate limiting**, because
  each process would otherwise enforce its own independent budget.

No Redis or other distributed dependency was introduced. That is deliberate
for a system that currently runs as a single process.

### 3.4 Durability - BLOCKER for production

SQLite plus local disk storage binds all state to one machine's filesystem.
Horizontal scale, managed backup and point-in-time restore all depend on the
PostgreSQL and Blob Storage work listed as not implemented above.

---

## 4. Preserved authorization order

Unchanged, and intended to stay that way:

```
identity -> authorization -> retrieval -> LLM
```

Restricted content is excluded from the candidate set before generation. The
model is never asked to keep a secret it has already been shown.
