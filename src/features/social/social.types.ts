export interface Friend {
  friendshipId: number
  friendsSince: Date
  /** The friend's uuid. */
  friendUserId: string
  username: string
  name: string
}

export interface FriendRequest {
  friendshipId: number
  /** Requester's uuid (incoming requests). */
  userId?: string
  /** Recipient's uuid (sent requests). */
  friendId?: string
  createdAt: Date
  username: string
  name: string
}

type FriendshipStatus =
  | "friend"
  | "request_sent"
  | "request_received"
  | "none"

export interface UserSearchResult {
  /** The user's uuid. */
  id: string
  username: string
  name: string
  friendshipStatus: FriendshipStatus
}

export type PermissionType =
  | "history"
  | "analytics"
  | "program"
  | "joint_session"
  | "watch_session"
  | "trainer"

export interface Permission {
  id: number
  /** The other user's uuid: `from` on received grants, `to` on granted ones. */
  fromUserId?: string
  toUserId?: string
  permissionType: PermissionType
  /** Inlined only with ?includePayload=true. See GET /permissions/:id/payload. */
  payload: Record<string, unknown> | null
  /** Whether this grant has a payload (a shared program snapshot). */
  hasPayload: boolean
  createdAt: Date
  updatedAt: Date
  fromUsername?: string
  toUsername?: string
}

export interface JointSessionParticipant {
  /** The participant's uuid. */
  userId: string
  sessionId: number | null
  username: string | null
  exerciseIndex: number | null
  setIndex: number | null
  exerciseName: string | null
  readyForNext: boolean
  exerciseNames: string[] | null
  lastUpdated: Date
}

export interface JointSession {
  id: number
  status: string
  createdAt: Date
  participants: JointSessionParticipant[]
}

export interface ParticipantProgress {
  exerciseIndex?: number | null
  setIndex?: number | null
  exerciseName?: string | null
  readyForNext?: boolean
  exerciseNames?: string[] | null
}
