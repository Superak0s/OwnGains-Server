import { Router, Request, Response } from "express"
import { authenticateToken } from "@/middleware/auth.js"
import { healthConsentGuard } from "../healthConsent.js"
import { queryLimit, parseIntParam } from "@/middleware/validation.js"
import { NotFoundError } from "@/middleware/errorHandler.js"
import {
  createNote,
  getNotesByMuscle,
  deleteNote,
} from "./personalNotes.model.js"
import { idempotent } from "@/middleware/idempotency.js"

const router: Router = Router()

router.use(authenticateToken)
router.use(healthConsentGuard)

router.post("/", idempotent, async (req: Request, res: Response) => {
  const { muscleGroup, content } = req.body
  const result = await createNote(req.user!.id, muscleGroup, content)
  res.status(201).json({ success: true, data: result })
})

router.get("/muscle/:muscleGroup", async (req: Request, res: Response) => {
  const muscleGroup = String(req.params.muscleGroup)
  const notes = await getNotesByMuscle(
    req.user!.id,
    muscleGroup,
    queryLimit(req, { def: 100, max: 500 }),
  )
  res.json({ success: true, data: notes })
})

router.delete("/:id", async (req: Request, res: Response) => {
  const id = parseIntParam(String(req.params.id), "note ID")
  if (!(await deleteNote(req.user!.id, id))) throw new NotFoundError("Note")
  res.json({ success: true })
})

export default router
