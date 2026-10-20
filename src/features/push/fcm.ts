// FCM push, on only when FCM_SERVICE_ACCOUNT holds a working Firebase
// service-account key (the JSON itself or a path to it). Messages are off without it.
import fs from "node:fs"
import { JWT } from "google-auth-library"
import { logger } from "@/utils/logger.js"
import { forgetToken, tokensFor } from "./push.model.js"

interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

function loadAccount(): ServiceAccount | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT?.trim()
  if (!raw) return null
  try {
    return JSON.parse(raw.startsWith("{") ? raw : fs.readFileSync(raw, "utf8")) as ServiceAccount
  } catch (err) {
    logger.warn(`FCM_SERVICE_ACCOUNT is not a readable service-account key: ${(err as Error).message}`)
    return null
  }
}

// How long a missing or refused key stays off before it is read again, so a fixed key file comes back without a restart.
const RECHECK_MS = 60_000

let account: ServiceAccount | null = null
let checkedAt = -Infinity
let jwt: JWT | undefined

function getAccount(): ServiceAccount | null {
  if (account || Date.now() - checkedAt < RECHECK_MS) return account
  checkedAt = Date.now()
  account = loadAccount()
  if (account) logger.info("FCM push is on, messages are enabled")
  else logger.warn("FCM push is off, so messages are disabled until FCM_SERVICE_ACCOUNT holds a working key")
  return account
}

/** Turns push, and with it messages, off until the next recheck. */
function markBroken(reason: string): void {
  logger.warn(`FCM refused the service-account key (${reason}), messages are disabled until it works again`)
  account = null
  jwt = undefined
  checkedAt = Date.now()
}

/** True when the server can send pushes. Messages are only served while it is. */
export const pushEnabled = (): boolean => getAccount() != null

/** A notification for every device of one user. */
export interface Push {
  title: string
  body: string
  /** Android channel the app created for this kind of notification. */
  channelId: string
  /** Same tag replaces the earlier notification instead of stacking another. */
  tag: string
  data: Record<string, string>
}

/**
 * Sends a push to every device the user registered and drops tokens FCM says are gone.
 * Never throws: a failed push only loses the notification, the data is already stored.
 */
export async function sendPush(userId: number, push: Push): Promise<void> {
  const key = getAccount()
  if (!key) return
  try {
    const tokens = await tokensFor(userId)
    if (!tokens.length) return
    jwt ??= new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    })
    let accessToken: string | null | undefined
    try {
      accessToken = (await jwt.getAccessToken()).token
    } catch (err) {
      markBroken((err as Error).message)
      return
    }
    await Promise.all(
      tokens.map(async (token) => {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${key.project_id}/messages:send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: push.title, body: push.body },
              data: push.data,
              android: { priority: "high", notification: { channel_id: push.channelId, tag: push.tag } },
            },
          }),
        })
        // 404 UNREGISTERED: the app was uninstalled or the token rotated.
        if (res.status === 404) await forgetToken(token)
        else if (res.status === 401 || res.status === 403) markBroken(`HTTP ${res.status}`)
        else if (!res.ok) logger.warn(`FCM push failed: HTTP ${res.status}`)
      }),
    )
  } catch (err) {
    logger.warn(`FCM push failed: ${(err as Error).message}`)
  }
}
