import bcrypt from "bcrypt"
import { AppError } from "@/middleware/errorHandler.js"
import { envInt } from "@/config/env.js"

/**
 * Password hashing, kept off the event loop and bounded.
 *
 * Native `bcrypt` runs each hash on the libuv threadpool, so a signin flood no
 * longer freezes every other request the way pure-JS bcryptjs did (~250 ms of
 * main-thread CPU per hash). It still verifies every `$2a$`/`$2b$` hash
 * bcryptjs wrote, so no stored password needs rehashing.
 *
 * The threadpool is shared with fs, dns.lookup and zlib (the `compression`
 * middleware), so hashes are also capped by a semaphore: at most
 * BCRYPT_MAX_CONCURRENCY run at once, a bounded queue waits behind them, and
 * anything past that is refused with 429 rather than piling up unbounded.
 */

export const BCRYPT_COST = 12

const MAX_CONCURRENT = envInt("BCRYPT_MAX_CONCURRENCY", 2, 1)
const MAX_QUEUED = 100

let active = 0
const waiting: (() => void)[] = []

async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED)
      throw new AppError(
        "Server is busy, please try again shortly",
        429,
        null,
        "AUTH_BUSY",
      )
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else {
    active++
  }
  try {
    return await fn()
  } finally {
    // Hand the slot straight to the next waiter instead of releasing it, so a
    // newcomer can't jump the queue between the decrement and the wake-up.
    const next = waiting.shift()
    if (next) next()
    else active--
  }
}

export const hashPassword = (plain: string): Promise<string> =>
  withHashSlot(() => bcrypt.hash(plain, BCRYPT_COST))

export const verifyPassword = (plain: string, hashed: string): Promise<boolean> =>
  withHashSlot(() => bcrypt.compare(plain, hashed))

/**
 * Stand-in hash for the "no such user" signin path, so an unknown username
 * pays the same bcrypt cost as a real one and response time is no
 * account-existence oracle. A constant: the plaintext was random bytes that
 * were thrown away, so nothing can match it, and there is no hashSync at boot
 * or on the first signin. Same cost as real hashes, or the timing would differ.
 */
export const DUMMY_PASSWORD_HASH =
  "$2b$12$69VqkZhnVRf2noOLjENg9OriVY6EfQ3DGD9JlpheCj9U9.kO0VUAO"
