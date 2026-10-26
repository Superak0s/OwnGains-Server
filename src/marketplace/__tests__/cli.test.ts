import { describe, it, expect, vi } from "vitest"
import { randomUUID } from "node:crypto"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { pool } from "../../config/database.js"
import { main } from "../cli.js"

const insertSkin = async (authorUuid: string) => {
  const [res] = await pool.execute<ResultSetHeader>(
    "INSERT INTO skins (author_uuid, author_name, name, body, has_theme, has_boards) VALUES (?, 'cli', 'Cli', '{}', 1, 0)",
    [authorUuid],
  )
  return res.insertId
}

const row = async (id: number) =>
  (await pool.execute<RowDataPacket[]>("SELECT author_uuid, author_name, taken_down_at FROM skins WHERE id = ?", [id]))[0][0]

describe("marketplace CLI", () => {
  vi.spyOn(console, "log").mockImplementation(() => {})

  it("forget anonymizes an author", async () => {
    const uuid = randomUUID()
    const id = await insertSkin(uuid)
    expect(await main(["forget", uuid])).toBe(0)
    expect(await row(id)).toMatchObject({ author_uuid: null, author_name: null })
  })

  it("remove takes a skin down", async () => {
    const id = await insertSkin(randomUUID())
    expect(await main(["remove", String(id)])).toBe(0)
    expect((await row(id)).taken_down_at).not.toBeNull()
  })

  it("rejects a bad uuid", async () => {
    expect(await main(["forget", "nope"])).toBe(1)
  })
})
