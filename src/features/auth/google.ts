import { OAuth2Client } from "google-auth-library"
import { ForbiddenError, UnauthorizedError } from "@/middleware/errorHandler.js"

const client = new OAuth2Client()

export interface GoogleIdentity {
  sub: string
  email: string
  name: string | null
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  let payload
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_WEB_CLIENT_ID,
    })
    payload = ticket.getPayload()
  } catch {
    throw new UnauthorizedError("Invalid Google token", "GOOGLE_TOKEN_INVALID")
  }
  if (!payload?.sub || !payload.email)
    throw new UnauthorizedError("Invalid Google token", "GOOGLE_TOKEN_INVALID")
  if (payload.email_verified !== true)
    throw new ForbiddenError("This Google account's email is not verified", "GOOGLE_EMAIL_UNVERIFIED")
  return { sub: payload.sub, email: payload.email, name: payload.name ?? null }
}
