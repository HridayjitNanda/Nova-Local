import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { api, setToken, getToken } from "../services/api.ts"
import type { HealthResponse, Me, Persona } from "../types/index.ts"

type SessionValue = {
	ready: boolean
	health: HealthResponse | null
	me: Me | null
	personas: Persona[]
	personaNotice: string
	tenants: Array<{ id: string; name: string; slug: string; industry: string; departments: string[] }>
	error: string | null
	signIn: (input: { tenantId?: string; userId?: string; email?: string }) => Promise<void>
	signOut: () => void
	refresh: () => Promise<void>
	loadPersonas: (tenantId?: string) => Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
	const [ready, setReady] = useState(false)
	const [health, setHealth] = useState<HealthResponse | null>(null)
	const [me, setMe] = useState<Me | null>(null)
	const [personas, setPersonas] = useState<Persona[]>([])
	const [personaNotice, setPersonaNotice] = useState("")
	const [tenants, setTenants] = useState<SessionValue["tenants"]>([])
	const [error, setError] = useState<string | null>(null)

	const loadPersonas = useCallback(async (tenantId?: string) => {
		try {
			const result = await api.personas(tenantId)
			setPersonas(result.personas)
			setPersonaNotice(result.notice)
		} catch {
			setPersonas([])
		}
	}, [])

	const refresh = useCallback(async () => {
		try {
			const [healthResult, tenantResult] = await Promise.all([api.health(), api.tenants().catch(() => ({ tenants: [] }))])
			setHealth(healthResult)
			setTenants(tenantResult.tenants)
			if (getToken()) {
				try {
					const meResult = await api.me()
					setMe(meResult)
					await loadPersonas(meResult.tenant.id)
				} catch {
					setToken(null)
					setMe(null)
					await loadPersonas(tenantResult.tenants[0]?.id)
				}
			} else {
				await loadPersonas(tenantResult.tenants[0]?.id)
			}
			setError(null)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Unable to reach the NOVA server.")
		} finally {
			setReady(true)
		}
	}, [loadPersonas])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const signIn = useCallback(
		async (input: { tenantId?: string; userId?: string; email?: string }) => {
			const session = await api.signIn(input)
			setToken(session.token)
			const meResult = await api.me()
			setMe(meResult)
			await loadPersonas(meResult.tenant.id)
		},
		[loadPersonas],
	)

	const signOut = useCallback(() => {
		setToken(null)
		setMe(null)
	}, [])

	const value = useMemo<SessionValue>(
		() => ({ ready, health, me, personas, personaNotice, tenants, error, signIn, signOut, refresh, loadPersonas }),
		[ready, health, me, personas, personaNotice, tenants, error, signIn, signOut, refresh, loadPersonas],
	)

	return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
	const value = useContext(SessionContext)
	if (!value) throw new Error("useSession must be used inside SessionProvider")
	return value
}
