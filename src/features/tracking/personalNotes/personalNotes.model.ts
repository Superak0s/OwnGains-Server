// Per-muscle notes: the `muscle_notes` table.

import { pool } from "@/config/database.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { ValidationError, NotFoundError } from "@/middleware/errorHandler.js"
import { requireOptionalNote } from "@/middleware/validation.js"

// Aliased to camelCase in SQL, so the query result is already the wire shape.
interface MuscleNote extends RowDataPacket {
  id: number
  muscleGroup: string
  content: string
  createdAt: Date
  updatedAt: Date
}

const NOTE_COLS = `id, muscle_group AS muscleGroup, content,
       created_at AS createdAt, updated_at AS updatedAt`

function requireContent(content: unknown): string {
  if (typeof content !== "string" || !content.trim())
    throw new ValidationError("Note content cannot be empty")
  // Same ceiling as every other tracking note.
  return requireOptionalNote(content.trim(), "content")!
}

export async function createNote(
  userId: number,
  muscleGroup: string,
  content: string,
): Promise<MuscleNote> {
  if (!muscleGroup) throw new ValidationError("Muscle group is required")

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO muscle_notes (user_id, muscle_group, content) VALUES (?, ?, ?)`,
    [userId, muscleGroup, requireContent(content)],
  )
  return getNoteById(userId, result.insertId)
}

async function getNoteById(userId: number, noteId: number): Promise<MuscleNote> {
  const [rows] = await pool.execute<MuscleNote[]>(
    `SELECT ${NOTE_COLS} FROM muscle_notes WHERE id = ? AND user_id = ?`,
    [noteId, userId],
  )
  /* v8 ignore next -- race: called right after the insert */
  if (!rows[0]) throw new NotFoundError("Note")
  return rows[0]
}

export async function getNotesByMuscle(
  userId: number,
  muscleGroup: string,
  limit = 100,
): Promise<MuscleNote[]> {
  const [rows] = await pool.execute<MuscleNote[]>(
    `SELECT ${NOTE_COLS} FROM muscle_notes
     WHERE user_id = ? AND muscle_group = ? ORDER BY updated_at DESC LIMIT ?`,
    [userId, muscleGroup, limit],
  )
  return rows
}

export async function deleteNote(
  userId: number,
  noteId: number,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `DELETE FROM muscle_notes WHERE id = ? AND user_id = ?`,
    [noteId, userId],
  )
  return result.affectedRows > 0
}
