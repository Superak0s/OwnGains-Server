// CLI branches the shared test database can't produce safely: no users at all,
// a purge of every user's data, a failed update. The models are mocked here.
import { describe, it, expect, vi } from "vitest"

const answer = vi.hoisted(() => ({ value: "" }))
const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listAdmins: vi.fn(),
  setUserAdmin: vi.fn(),
  listReports: vi.fn(),
  countHealthData: vi.fn(),
  deleteHealthData: vi.fn(),
}))

vi.mock("node:readline", () => ({
  createInterface: () => ({ question: (_q: string, cb: (a: string) => void) => cb(answer.value), close() {} }),
}))
vi.mock("../features/auth/auth.model.js", async (orig) => ({
  ...(await orig<object>()),
  listUsers: mocks.listUsers,
  listAdmins: mocks.listAdmins,
  setUserAdmin: mocks.setUserAdmin,
}))
vi.mock("../features/social/friends/friends.model.js", async (orig) => ({
  ...(await orig<object>()),
  listReports: mocks.listReports,
}))
vi.mock("../features/tracking/healthConsent.js", async (orig) => ({
  ...(await orig<object>()),
  countHealthData: mocks.countHealthData,
  deleteHealthData: mocks.deleteHealthData,
}))

import { runCli, uniqueName } from "../tests/helpers.js"
import { createUser } from "../features/auth/auth.model.js"

describe("owngains CLI (mocked models)", () => {
  it("list handles no users and marks suspended ones", async () => {
    mocks.listUsers.mockResolvedValueOnce([])
    expect((await runCli(["list"])).out).toBe("No users found")

    mocks.listUsers.mockResolvedValueOnce([
      { id: 1, uuid: "u", username: "sus", email: "e", name: "n", isAdmin: false, disabled: true, createdAt: new Date(0) },
    ])
    expect((await runCli(["list"])).out).toContain("[susp.] id=1")
  })

  it("remove refuses to demote the last admin", async () => {
    const username = uniqueName("last")
    const id = await createUser(username, `${username}@test.local`, "Passw0rd-123")
    mocks.listAdmins.mockResolvedValueOnce([{ id }])
    const res = await runCli(["remove", username])
    expect(res.code).toBe(2)
    expect(res.out).toContain("only admin")
  })

  it("add reports a failed update", async () => {
    const username = uniqueName("fail")
    await createUser(username, `${username}@test.local`, "Passw0rd-123")
    mocks.setUserAdmin.mockResolvedValueOnce(false)
    expect(await runCli(["add", username])).toEqual({ code: 1, out: "Failed to update user admin status" })
  })

  it("reports prints every shape of report and clamps the limit", async () => {
    mocks.listReports.mockResolvedValueOnce([])
    expect((await runCli(["reports", "abc"])).out).toBe("No reports filed")
    expect(mocks.listReports).toHaveBeenLastCalledWith(100)

    mocks.listReports.mockResolvedValueOnce([
      { id: 1, created_at: "t", reporter_username: null, reported_username: null, reported_exists: 0, reported_disabled: 0, reason: "spam", details: "why" },
      { id: 2, created_at: "t", reporter_username: "a", reported_username: "b", reported_exists: 1, reported_disabled: 1, reason: "abuse", details: null },
    ])
    const r = await runCli(["reports", "-5"])
    expect(mocks.listReports).toHaveBeenLastCalledWith(1)
    expect(r.out).toContain("[deleted user] reported [unknown] [deleted] (spam)")
    expect(r.out).toContain("    why")
    expect(r.out).toContain("a reported b [suspended] (abuse)")
  })

  it("purge-local-only needs a feature list, dry-runs, then deletes with --yes", async () => {
    delete process.env.LOCAL_ONLY_FEATURES
    expect((await runCli(["purge-local-only"])).code).toBe(2)

    process.env.LOCAL_ONLY_FEATURES = "tracking"
    try {
      mocks.countHealthData.mockResolvedValueOnce({ measurements: 3 })
      const dry = await runCli(["purge-local-only"])
      expect(dry.out).toContain("  measurements: 3")
      expect(dry.out).toContain("Dry run")
      expect(mocks.deleteHealthData).not.toHaveBeenCalled()

      mocks.deleteHealthData.mockResolvedValueOnce({ measurements: 3 })
      const yes = await runCli(["purge-local-only", "--yes"])
      expect(yes.out).toContain("Deleted the server copy of: tracking.")
      expect(mocks.deleteHealthData).toHaveBeenCalledWith(null, ["tracking"])
    } finally {
      delete process.env.LOCAL_ONLY_FEATURES
    }
  })

  it("prompts for the password when it isn't on the command line", async () => {
    const username = uniqueName("prm")
    await createUser(username, `${username}@test.local`, "Passw0rd-123")

    answer.value = "   "
    expect(await runCli(["passwd", username])).toEqual({ code: 2, out: "No password entered" })

    answer.value = " Prompted-999 "
    expect((await runCli(["passwd", username])).code).toBe(0)

    const created = uniqueName("prc")
    expect((await runCli(["create", created, `${created}@test.local`])).out).toBe(`Created ${created}.`)
  })
})
