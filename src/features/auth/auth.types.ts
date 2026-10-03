export interface JwtPayload {
  /** The user's public uuid. */
  userId: string
  tokenVersion: number
  /** Seconds since epoch, set by jsonwebtoken from JWT_EXPIRES_IN. */
  exp?: number
}
