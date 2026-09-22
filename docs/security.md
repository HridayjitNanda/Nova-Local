# Security model

## Principle: authorization before retrieval

```mermaid
flowchart LR
  U[User identity] --> S[Access scope: tenant, role, department, clearance, grants]
  S --> F[SQL predicate applied inside the vector store]
  F --> R[Authorized chunks only]
  R --> L[LLM]
```

The model never receives content the caller may not read. NOVA does not retrieve everything and ask
the model to keep quiet.

## Tenant isolation

- Every tenant-scoped table has `tenant_id` and a tenant-first index.
- Retrieval filters on `tenant_id` in three joined tables (chunk, document, version) inside the store.
- Conversations, messages, citations, incidents and audit rows are all tenant-scoped.
- Tests 1 and the `tenant-01/02` evaluations assert that Acme content is unreachable from NovaTech
  and vice versa, including when the question quotes the other tenant's document title verbatim.

## RBAC

Roles are tenant data, not code. A role is a key plus a list of grants of the form
`(department | '*', maximum classification)`. Classification levels: public 1, internal 2,
confidential 3, restricted 4.

`decideDocumentAccess` returns an allow/deny plus a reason: `tenant_mismatch`, `explicit_user_grant`,
`admin_role`, `role_not_in_document_acl`, `classification_above_clearance`, `role_grant`.

Seeded demo grants:

| Role | Grants |
| --- | --- |
| EMPLOYEE, MANAGER | `('*', internal)` |
| ENGINEERING_MANAGER | `+ ('Engineering', confidential)` |
| FINANCE_MANAGER | `+ ('Finance', confidential)`, `('Procurement', confidential)` |
| HR_MANAGER | `+ ('Human Resources', confidential)` |
| SAFETY_MANAGER | `+ ('Safety', confidential)`, `('Manufacturing Operations', confidential)` |
| ADMIN | `('*', restricted)` |

## Denial without disclosure

When the authorized evidence cannot answer the question but material beyond the caller's clearance
matches better, NOVA returns:

```
ACCESS DENIED

Your current role does not have permission to access this information.
```

The probe used to reach that conclusion is metadata-only: the store returns counts, never titles,
metadata or text. The denial is audited as `Restricted Knowledge Request — Denied`.

## Prompt injection defence

- Documents are scanned at ingestion (`documents/injection.ts`) for instruction-override,
  system-prompt-extraction, role-override, secret-extraction, exfiltration, authorization-bypass and
  fake-authority patterns.
- Matching lines are replaced with `[neutralised untrusted instruction: ...]` before the chunk enters
  model context; the original document is never modified.
- The system prompt labels all evidence as untrusted data that may contain instructions to ignore.
- User-supplied attacks are detected separately (`detectUserAttack`) and refused.
- `knowledge/novatech/security/vendor_integration_notice.md` is a deliberately malicious fixture used
  by the tests.

## Citation integrity

Citations are reconciled against the actual retrieved chunk set. A reference the model invents is
dropped rather than displayed, and an answer left without evidence is downgraded to
`INSUFFICIENT EVIDENCE`.

## Logging and privacy

- Structured JSON logs carry request ID, tenant, user, latency, retrieval status, citation count,
  authorization result and action status.
- `redact()` strips anything resembling a secret, token, password, API key or credential, and truncates
  long values. Document text is never logged; activity details are metadata only.
- Customer documents are treated as confidential by default, are not used for training or fine-tuning,
  and are deletable with immediate effect on retrieval.

## Security test suite (`npm test`)

1. Cross-tenant leakage 2. Unauthorized document access 3. Document prompt injection
4. System prompt extraction 5. Secret extraction 6. Citation fabrication 7. Hallucination
8. Inactive document retrieval 9. Superseded version retrieval 10. Unauthorized action execution

11. Same-tenant unauthorized conversation read 12. Same-tenant unauthorized conversation delete
13. Cross-tenant conversation id probing 14. Feedback ownership

`tests/security.test.ts` contains **14** security cases (the 10 required, plus
the 4 ownership cases added by the continuity pass). `tests/platform.test.ts`
contains **9** platform cases, so `npm test` executes **23** tests in total.

> Verification status: these counts are read from the source of the test files
> in this repository. They were **not** confirmed by executing `npm test` in
> the environment that produced this revision, because dependency installation
> had no registry network access there. See `production-blockers.md` for the
> honest per-command PASS / FAIL / NOT RUN status.

---

## Hardening pass (continuity + security release)

This section documents what was implemented in the repository-level hardening
pass, including deliberate non-decisions. Nothing here is aspirational: if a
control is planned rather than implemented, it says so.

### Ownership is enforced per user, not per tenant

Tenant match alone was previously treated as authorization for conversation
reads, deletes, chat appends and message feedback. Two people in the same
workspace are different principals, so tenant scoping leaked sibling data.

Implemented:

- `ConversationService.getOwned(tenantId, userId, conversationId)` is the only
  read path used by request handlers. `get()` remains for internal,
  already-authorized use.
- `ConversationService.ownsMessage(tenantId, userId, messageId)` joins
  `messages -> conversations` on `user_id`, so feedback cannot be written by
  knowing a message id.
- `GET /api/conversations/:id`, `DELETE /api/conversations/:id`,
  `POST /api/chat` (when `conversationId` is supplied) and
  `POST /api/messages/:id/feedback` all resolve ownership first.
- Failures return **404 Not Found**, not 403. A 403 would confirm that the
  resource exists and belongs to somebody else.
- Conversation deletion is recorded in the activity log.

Covered by `tests/security.test.ts` cases 11-14 (same-tenant read, same-tenant
delete, cross-tenant id probe, feedback ownership).

### Knowledge statistics scope

`GET /api/knowledge` previously returned tenant-wide document statistics to
every caller, which disclosed counts of documents the caller could not read.
Statistics are now derived from the caller's already-authorized document list;
the tenant-wide aggregate is returned only to administrators.

### Rate limiting

Implemented in `backend/src/api/security.ts` as a fixed-window, in-process
limiter keyed by a SHA-256 prefix of the bearer token, falling back to
`x-forwarded-for` / socket address for unauthenticated routes.

| Bucket | Default | Env override | Routes |
| --- | --- | --- | --- |
| auth | 20 / min | `RATE_LIMIT_AUTH` | `POST /api/session` |
| onboarding | 5 / 10 min | `RATE_LIMIT_ONBOARDING` | `POST /api/onboarding/tenants` |
| chat | 40 / min | `RATE_LIMIT_CHAT` | `POST /api/chat` |
| upload | 20 / 10 min | `RATE_LIMIT_UPLOAD` | `POST /api/knowledge/upload` |
| action | 30 / min | `RATE_LIMIT_ACTION` | action execution |
| feedback | 120 / min | `RATE_LIMIT_FEEDBACK` | `POST /api/messages/:id/feedback` |
| adminWrite | 60 / min | `RATE_LIMIT_ADMIN_WRITE` | admin mutations |
| read | 600 / min | `RATE_LIMIT_READ` | general reads |

Exceeding a bucket returns `429` with `retry-after`, `x-ratelimit-limit` and
`x-ratelimit-remaining`, and a generic message that does not disclose the
window algorithm. `RATE_LIMIT_DISABLED=true` turns the limiter off for load
testing.

**Known limitation:** the counter lives in process memory. Behind more than one
node it degrades to per-instance limits. A shared store (Redis / Azure Cache)
is required before horizontal scaling. This is not implemented.

### Security headers

`applySecurityHeaders()` runs on every response:

- `Content-Security-Policy`: `default-src 'self'`; `object-src 'none'`;
  `frame-ancestors 'none'`; `form-action 'self'`; `script-src 'self'`;
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`;
  `font-src 'self' https://fonts.gstatic.com data:`;
  `img-src 'self' data: blob:`; `connect-src 'self'`.
  - `'unsafe-inline'` is retained for styles only, because the app ships
    inline style attributes for motion variables. Scripts have no such
    exception. Removing the style exception requires a nonce pipeline in the
    esbuild step; that is **not implemented**.
  - Google Fonts hosts are allowlisted because the shell loads Anton, Inter,
    Archivo Black and IBM Plex Mono from there. Self-hosting the fonts would
    let both entries be dropped.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`,
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`.
- `Strict-Transport-Security` is emitted **only** when `HTTPS_ENABLED=true` or
  the request arrived with `x-forwarded-proto: https`, so local HTTP
  development is never pinned to HTTPS.

### Session strategy and CSRF

Current state, stated plainly:

- **LOCAL demo auth** issues a signed demo token that the browser keeps in
  `localStorage` and sends as `Authorization: Bearer`. This is a demonstration
  identity mechanism, not production authentication, and the UI labels the
  deployment `LOCAL DEMO MODE`.
- Because the credential is an explicitly attached header rather than an
  ambient cookie, classic form-based CSRF does not apply to authenticated
  routes: a cross-site form cannot attach the header.
- The two mutating routes that accept unauthenticated requests
  (`POST /api/session`, `POST /api/onboarding/tenants`) are additionally guarded
  by `assertSameOrigin()`, which rejects a cross-origin `Origin` header.
- **Planned, not implemented:** the production path should move to an
  `HttpOnly; Secure; SameSite=Lax` cookie issued after Entra ID sign-in, at
  which point a double-submit or origin-bound CSRF token becomes mandatory for
  every state-changing route. Adding CSRF tokens today would be ceremony
  against a threat the current scheme does not have.

### Input validation

Every public route validates before it acts: identifiers must match
`/^[A-Za-z0-9_:.-]{1,128}$/`, free text is length-bounded (chat message 4000
chars, tenant name 160, email 320), feedback values are whitelisted to
`up | down | null`, and pagination limits are clamped. Backend validation is
authoritative; the frontend is never trusted.

### Errors and audit logging

Handlers return a safe public message plus the `x-request-id` that correlates
to the server-side structured log. Stack traces, database paths, provider
endpoints and prompts are never sent to the client. The audit log records
timestamp, request id, tenant, user, role, action, resource, status, latency
and authorization outcome, and never records tokens, secrets or document
bodies.

### Authorization precedes retrieval

This is an architectural invariant, not a UI behaviour. The pipeline is
identity -> tenant -> role -> department -> classification -> authorized
retrieval -> grounding -> model. Restricted chunks are filtered out before the
prompt is assembled; the model is never given material and asked to withhold
it. Cases 1-10 of the security suite exercise this.

### Prompt injection

Retrieved documents are treated as untrusted data. Mitigations: retrieved text
is delimited and labelled as data, the system prompt states that document
content cannot issue instructions, answers must cite retrieved chunks, and the
action path re-checks role permissions rather than trusting model output. Case
3 of the security suite feeds a poisoned document and asserts the model neither
leaks the system prompt nor invents a secret.

NOVA does not claim to be injection-proof. These are mitigations with tests,
not a guarantee.
