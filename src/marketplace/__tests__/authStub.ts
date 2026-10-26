import { vi } from "vitest"
import { randomUUID } from "node:crypto"
import { marketplaceConfig } from "../env.js"

export interface StubUser {
  token: string
  uuid: string
  username: string
  isAdmin: boolean
}

/** Answers `/api/auth/me` for the given users and counts calls. Other URLs reach the real fetch. */
export function stubAuthServer(users: StubUser[]) {
  const realFetch = globalThis.fetch
  const calls = { count: 0 }
  const meUrl = `${marketplaceConfig.authServerUrl}/api/auth/me`
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== meUrl) return realFetch(url, init)
    calls.count += 1
    const header = new Headers(init?.headers).get("authorization") ?? ""
    const user = users.find((u) => header === `Bearer ${u.token}`)
    if (!user) return Response.json({ success: false }, { status: 401 })
    return Response.json({ success: true, user: { id: user.uuid, username: user.username, isAdmin: user.isAdmin } })
  })
  return calls
}

export function fakeUser(username: string, isAdmin = false): StubUser {
  return { token: `tok-${randomUUID()}`, uuid: randomUUID(), username, isAdmin }
}

export const bearer = (u: StubUser) => ({ Authorization: `Bearer ${u.token}` })
