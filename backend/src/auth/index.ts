import type { AuthProvider } from "./base.ts"
import { DemoAuthProvider } from "./demo.ts"
import { EntraAuthProvider } from "./entra.ts"
import type { Database } from "../db/index.ts"
import { getConfig } from "../config/index.ts"

/** Provider selection is driven only by explicit configuration. */
export function createAuthProvider(db: Database): AuthProvider {
	const config = getConfig()
	if (config.modes.authMode === "entra") {
		return new EntraAuthProvider(db, {
			tenantId: config.azure?.entra.tenantId ?? "",
			clientId: config.azure?.entra.clientId ?? "",
			audience: config.azure?.entra.audience ?? "",
		})
	}
	return new DemoAuthProvider(db, config.demoAuth.sessionSecret)
}

export type { AuthProvider } from "./base.ts"
export { AuthError } from "./base.ts"
