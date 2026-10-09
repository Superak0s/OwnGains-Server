/** Full profile row returned from the `users` table. */
interface UserProfile {
  /** Internal key. Never sent to a client: `uuid` is the public identity. */
  id: number
  uuid: string
  username: string
  email: string
  name: string
  /** Which branch of the US-Navy body-fat formula to use. Not an identity field. */
  bfFormulaSex: "male" | "female" | null
  heightCm: number | null
  height_unit: "cm" | "ft" | null
  weight_unit: "kg" | "lbs" | null
  isAdmin: boolean
  createdAt: Date
  /** The Terms/Privacy Policy version last accepted, or null if never. */
  termsVersion: string | null
  termsAcceptedAt: Date | null
  /** When explicit health-data consent was given, or null if never or withdrawn. */
  healthConsentAt: Date | null
  /** False for an account created through Google sign-in, which has no usable password. */
  hasPassword: boolean
  googleLinked: boolean
}

/** Subset attached to `req.user` after JWT authentication. */
export type AuthUser = Pick<
  UserProfile,
  | "id"
  | "uuid"
  | "username"
  | "email"
  | "name"
  | "createdAt"
  | "isAdmin"
  | "heightCm"
  | "bfFormulaSex"
  | "termsVersion"
  | "termsAcceptedAt"
  | "healthConsentAt"
  | "hasPassword"
  | "googleLinked"
>

/** What the app sends at signup and on PUT /api/auth/consent. */
export interface ConsentInput {
  termsVersion?: string
  healthConsent?: boolean
}

export interface UserBodyData {
  heightCm: number | null
  bfFormulaSex: "male" | "female"
  weightUnit: "kg" | "lbs"
}
