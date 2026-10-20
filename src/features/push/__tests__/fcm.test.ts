import { describe, it, expect, vi, beforeEach } from "vitest"

const model = vi.hoisted(() => ({ tokensFor: vi.fn(), forgetToken: vi.fn() }))
vi.mock("../push.model.js", () => model)
const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }))
vi.mock("google-auth-library", () => ({
  JWT: class {
    getAccessToken = auth.getAccessToken
  },
}))

const push = { title: "t", body: "b", channelId: "messages", tag: "tag", data: { type: "message" } }

describe("sendPush", () => {
  beforeEach(() => {
    vi.resetModules()
    model.tokensFor.mockReset().mockResolvedValue(["good", "gone", "bad"])
    model.forgetToken.mockReset()
    auth.getAccessToken.mockReset().mockResolvedValue({ token: "access" })
  })

  it("does nothing without a service account", async () => {
    vi.stubEnv("FCM_SERVICE_ACCOUNT", "")
    const fetchMock = vi.spyOn(globalThis, "fetch")
    const { sendPush, pushEnabled } = await import("../fcm.js")
    await sendPush(1, push)
    expect(pushEnabled()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends to every token and forgets the unregistered ones", async () => {
    vi.stubEnv("FCM_SERVICE_ACCOUNT", JSON.stringify({ project_id: "p", client_email: "e", private_key: "k" }))
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { token } = JSON.parse(String(init!.body)).message
      return new Response("{}", { status: token === "gone" ? 404 : token === "bad" ? 500 : 200 })
    })
    const { sendPush, pushEnabled } = await import("../fcm.js")
    await sendPush(1, push)
    expect(pushEnabled()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toBe("https://fcm.googleapis.com/v1/projects/p/messages:send")
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).message.android.notification).toEqual({
      channel_id: "messages",
      tag: "tag",
    })
    expect(model.forgetToken).toHaveBeenCalledExactlyOnceWith("gone")
  })

  it("turns push off when Google refuses the key, and reads it again a minute later", async () => {
    vi.useFakeTimers()
    vi.stubEnv("FCM_SERVICE_ACCOUNT", JSON.stringify({ project_id: "p", client_email: "e", private_key: "k" }))
    auth.getAccessToken.mockRejectedValueOnce(new Error("invalid_grant"))
    const { sendPush, pushEnabled } = await import("../fcm.js")
    await sendPush(1, push)
    expect(pushEnabled()).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(pushEnabled()).toBe(true)
    vi.useRealTimers()
  })
})
