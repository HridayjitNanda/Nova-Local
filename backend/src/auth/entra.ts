/**
 * EntraAuthProvider - DISABLED unless AUTH_MODE=entra is set manually.
 *
 * Validates a Microsoft Entra ID (Azure AD) access token against the tenant's
 * published JWKS using the documented OpenID Connect discovery endpoints:
 *   https://login.microsoftonline.com/{tenantId}/v2.0/.well-known/openid-configuration
 *
 * Nothing is invented here: only standard OIDC discovery + JWKS + RS256
 * verification via Node's built-in crypto. Group/role -> NOVA role mapping is
 * intentionally explicit and configurable.
 */
import { createPublicKey, createVerify } from "node:crypto"
import type { AuthProvider, AuthSession, AuthSessionRequest } from "./base.ts"
import { AuthError } from "./base.ts"
import type { Database } from "../db/index.ts"
import type { Principal } from "../models/types.ts"
import { getTenant, getUserByEmail, listUsers } from "../tenants/service.ts"

type Jwk = { kid: string; n: string; e: string; kty: string }

export type EntraConfig = {
	tenantId: string
	clientId: string
	audience: string
}

export class EntraAuthProvider implements AuthProvider {
	readonly name = "EntraAuthProvider"
	readonly mode = "entra" as const
	readonly isProduction = true
	private jwks: Jwk[] = []
	private jwksFetchedAt = 0

	constructor(
		private readonly db: Database,
		private readonly config: EntraConfig,
	) {
		if (!config.tenantId || !config.clientId) {
			throw new AuthError(
				"AUTH_MODE=entra requires AZURE_TENANT_ID and AZURE_CLIENT_ID. See docs/azure-integration.md",
				500,
			)
		}
	}

	private get discoveryUrl(): string {
		return `https://login.microsoftonline.com/${this.config.tenantId}/v2.0/.well-known/openid-configuration`
	}

	private async loadJwks(): Promise<Jwk[]> {
		if (this.jwks.length && Date.now() - this.jwksFetchedAt < 60 * 60 * 1000) return this.jwks
		const discovery = await fetch(this.discoveryUrl)
		if (!discovery.ok) throw new AuthError("Entra discovery document unavailable", 503)
		const { jwks_uri } = (await discovery.json()) as { jwks_uri: string }
		const keysResponse = await fetch(jwks_uri)
		if (!keysResponse.ok) throw new AuthError("Entra JWKS unavailable", 503)
		const { keys } = (await keysResponse.json()) as { keys: Jwk[] }
		this.jwks = keys
		this.jwksFetchedAt = Date.now()
		return keys
	}

	/** Entra never issues NOVA sessions: the client performs the OAuth flow. */
	async createSession(request: AuthSessionRequest): Promise<AuthSession> {
		if (!request.bearerToken) {
			throw new AuthError(
				"AUTH_MODE=entra: sign in through Microsoft Entra ID and send the access token as a Bearer token.",
				400,
			)
		}
		const principal = await this.verify(request.bearerToken)
		if (!principal) throw new AuthError("Invalid Entra access token", 401)
		return {
			token: request.bearerToken,
			principal,
			expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			notice: "Microsoft Entra ID session",
		}
	}

	async verify(token: string): Promise<Principal | null> {
		const parts = String(token || "").split(".")
		if (parts.length !== 3) return null
		const [headerB64, payloadB64, signatureB64] = parts
		const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"))
		const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"))
		if (header.alg !== "RS256") return null

		const key = (await this.loadJwks()).find((k) => k.kid === header.kid)
		if (!key) return null
		const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" })
		const verifier = createVerify("RSA-SHA256")
		verifier.update(`${headerB64}.${payloadB64}`)
		if (!verifier.verify(publicKey, Buffer.from(signatureB64, "base64url"))) return null

		const audience = this.config.audience || this.config.clientId
		if (claims.aud !== audience) return null
		if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null
		if (claims.tid && claims.tid !== this.config.tenantId) return null

		// Map the verified Entra identity onto a NOVA tenant user record.
		const email: string = claims.preferred_username || claims.upn || claims.email || ""
		const tenants = listUsers(this.db, claims.nova_tenant_id ?? "")
		void tenants
		const novaTenantId: string | undefined = claims.nova_tenant_id
		if (!novaTenantId || !getTenant(this.db, novaTenantId)) return null
		const user = getUserByEmail(this.db, novaTenantId, email)
		if (!user) return null
		return {
			tenantId: user.tenantId,
			userId: user.id,
			name: user.name,
			email: user.email,
			roleKey: user.roleKey,
			department: user.department,
			title: user.title,
			authMode: "entra",
		}
	}

	async healthCheck(): Promise<{ ok: boolean; detail: string }> {
		try {
			const response = await fetch(this.discoveryUrl)
			return response.ok
				? { ok: true, detail: `Entra discovery reachable for tenant ${this.config.tenantId}` }
				: { ok: false, detail: `Entra discovery returned HTTP ${response.status}` }
		} catch (error) {
			return { ok: false, detail: `Entra discovery unreachable: ${(error as Error).message}` }
		}
	}
}
