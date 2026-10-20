/** An accepted friend as listed to the caller. */
export interface Friend {
  friendshipId: number
  friendsSince: Date
  /** The friend's uuid. */
  friendUserId: string
  username: string
  name: string
  /** Changes whenever the friend replaces their profile photo. Null without one. */
  photoHash: string | null
}

/** A pending friend request. Incoming ones carry `userId`, sent ones carry `friendId`. */
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

/** One hit of a user search, with how the caller relates to that user. */
export interface UserSearchResult {
  /** The user's uuid. */
  id: string
  username: string
  friendshipStatus: FriendshipStatus
}

/** What a grant lets the other user do with the grantor's data. */
export type PermissionType =
  | "history"
  | "analytics"
  | "program"
  | "joint_session"
  | "watch_session"
  | "trainer"
  | "tracking"

/** A grant between two users, as received or as given. */
export interface Permission {
  id: number
  /** The other user's uuid: `from` on received grants, `to` on granted ones. */
  fromUserId?: string
  toUserId?: string
  permissionType: PermissionType
  /** Whether this grant has a payload (a shared program snapshot), read from GET /permissions/:id/payload. */
  hasPayload: boolean
  createdAt: Date
  updatedAt: Date
  fromUsername?: string
  toUsername?: string
}

/** One user taking part in a joint workout and where they are in it. */
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

/** A workout done together by several friends. */
export interface JointSession {
  id: number
  status: string
  createdAt: Date
  participants: JointSessionParticipant[]
}

/** A partial update to a participant's position in a joint workout. Omitted fields stay unchanged. */
export interface ParticipantProgress {
  exerciseIndex?: number | null
  setIndex?: number | null
  exerciseName?: string | null
  readyForNext?: boolean
  exerciseNames?: string[] | null
}
