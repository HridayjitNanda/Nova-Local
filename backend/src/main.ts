/** NOVA entrypoint. */
import { getConfig, loadEnv } from "./config/index.ts"
import { createServer, createServices } from "./api/server.ts"
import { log } from "./observability/logger.ts"
import { listTenants } from "./tenants/service.ts"

loadEnv()
const config = getConfig()
const services = createServices()
const server = createServer(services)

/**
 * Bind to the configured port, automatically trying the next ports when it's
 * busy (EADDRINUSE) — a stale dev server should never block a fresh start.
 */
const MAX_PORT_ATTEMPTS = 100
let attempt = 0

function tryListen(port: number): void {
	server.once("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
			attempt += 1
			log.warn("server.port_busy", { port, trying: port + 1 })
			tryListen(port + 1)
			return
		}
		throw error
	})
	server.listen(port, config.server.host, () => {
		const tenants = listTenants(services.db)
		log.info("server.started", {
			url: `{{http://${config.server.host}}}:${port}`,
			mode: config.isFullyLocal ? "LOCAL DEMO MODE" : "AZURE MODE",
			modes: config.modes,
			llm: services.providers.llm.model,
			embeddings: services.providers.embeddings.model,
			tenants: tenants.length,
			...(attempt > 0 ? { note: `configured port was busy, bound to ${port} instead` } : {}),
		})
		if (attempt > 0) {
			console.log(`\n  ⚠ Port ${config.server.port} was busy — NOVA is running at {{http://${config.server.host}}}:${port} instead\n`)
		}
		if (tenants.length === 0) log.warn("server.no_tenants", { hint: "Run: npm run seed-demo" })
	})
}

tryListen(config.server.port)

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		log.info("server.stopping", { signal })
		server.close(() => process.exit(0))
	})
}
