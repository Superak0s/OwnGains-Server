// Profile writes and reads the routes' validators stop first, and an export
// that holds a reference to an account that no longer exists.
import { describe, it, expect } from "vitest"
import { signup, internalId } from "../../../tests/helpers.js"
import { updateUserProfile, getUserBodyData, exportUserData } from "../user.model.js"
import { deleteUser } from "../auth.model.js"
import { reportUser } from "../../social/friends/friends.model.js"

describe("user model edges", () => {
  it("rejects an unknown formula sex and an empty update, and reads a stored height", async () => {
    const id = await internalId((await signup("uedge")).user.id)
    await expect(updateUserProfile(id, { bf_formula_sex: "other" } as never)).rejects.toThrow("bf_formula_sex")
    await expect(updateUserProfile(id, {})).rejects.toThrow("No valid fields")
    await updateUserProfile(id, { height_cm: 181 } as never)
    expect(await getUserBodyData(id)).toMatchObject({ heightCm: 181, weightUnit: "kg" })
    await expect(getUserBodyData(999_999_999)).rejects.toThrow("User")
  })

  it("exports a null for a reported account that was deleted, and no profile for no user", async () => {
    const [a, b] = [await internalId((await signup("uexa")).user.id), await internalId((await signup("uexb")).user.id)]
    await reportUser(a, b, "spam")
    await deleteUser(b)
    const data = await exportUserData(a)
    expect(data["user_reports"]).toEqual([expect.objectContaining({ reported_id: null })])
    expect((await exportUserData(999_999_999)).profile).toBeNull()
  })
})
