# Local development

NOVA runs fully locally. No Azure credential, Foundry project, Entra tenant or paid API is used.

## Requirements

- Node.js 22.5 or newer (`node:sqlite` ships with it; there is no native build step)
- No network access is required after checkout

## First run

```bash
cp .env.example .env     # optional, defaults are already local
npm run seed-demo
./start-dev              # equivalent to: npm run build:web && npm start
```

The server listens on `http://127.0.0.1:4317` and serves both the API and the built frontend.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Build frontend, start the API server |
| `npm run watch:web` | Rebuild the frontend bundle on change |
| `npm run seed-demo` | Idempotent seed of tenants, roles, users, documents and the vector index |
| `npm run reset-demo` | Remove `data/nova.db` and `data/storage/`, then reseed |
| `npm test` | Platform + security tests |
| `npm run eval` | Evaluation harness (28 questions, 10 categories) |
| `npm run typecheck` | Backend/scripts/tests type check |
| `npm run typecheck:web` | Frontend type check (needs `@types/react` installed) |
| `npm run build` | Typecheck + bundle |
| `npm run lint` / `npm run format` | Prettier |

## Configuration

All switches live in `.env` (see `.env.example`). The defaults are:

```
AI_MODE=local
KNOWLEDGE_MODE=local
AUTH_MODE=demo
ACTION_MODE=local
VECTOR_STORE=local
```

Nothing auto-detects Azure. If Azure variables are present but the modes are `local`,
no Azure call is ever made and the UI keeps showing **LOCAL DEMO MODE**.

There is no `APP_MODE` variable: the overall mode is derived from the provider modes.
Setting `APP_MODE` to something that disagrees with the derived mode fails at startup.

## Using a real local model (optional)

With `LOCAL_LLM_BASE_URL` empty, the `LocalLLMProvider` uses a deterministic extractive composer and
the UI labels the answer as a fallback. To use a real model, point the provider at any
OpenAI-compatible server:

```
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1     # Ollama, LM Studio, vLLM, llama.cpp server...
LOCAL_LLM_MODEL=qwen2.5:7b-instruct
LOCAL_LLM_API_KEY=
```

Embeddings work the same way: leave `LOCAL_EMBEDDING_BASE_URL` empty for the built-in deterministic
hashed-lexical embedding, or point it at an embedding endpoint and set `LOCAL_EMBEDDING_MODEL` and
`EMBEDDING_DIM`. Re-run `npm run reset-demo` after changing the embedding model so the index is rebuilt.

## Local data locations

| Path | Contents |
| --- | --- |
| `data/nova.db` | SQLite database (all tables) |
| `data/storage/<tenant>/<document>/` | Original uploaded files |
| `knowledge/` | Seed corpora used by `seed-demo` |

Both `data/` and `.env` are git-ignored.

## Troubleshooting

- **`Knowledge base ready.` but no answers** — run `npm run seed-demo`; check `/admin` shows a
  non-zero indexed chunk count. (`/api/health` reports configuration only: it is local-only and
  makes no model, embedding or Search call, so it costs zero tokens and never proves connectivity.)
- **Port in use** — set `PORT` in `.env`.
- **Answers look like bullet extracts** — that is the no-model fallback; configure `LOCAL_LLM_BASE_URL`.
- **Changed seed documents** — `npm run reset-demo` to rebuild cleanly.

> Verification note: the revision that introduced the hidden/reveal console
> rail could not execute these commands (no npm registry network access for
> `npm ci`). See `production-blockers.md` for per-command PASS / FAIL /
> NOT RUN status.
