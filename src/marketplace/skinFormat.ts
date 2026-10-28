import { ValidationError } from "../middleware/errorHandler.js"

export type WidgetSize = "small" | "medium" | "large"

export interface SkinWidget {
  type: string
  size: WidgetSize
  order: number
  title?: string
  icon?: string
  subtitle?: string
}

export interface SkinDocument {
  format: 1
  theme?: { name: string; colors: Record<string, string> }
  boards?: Record<string, SkinWidget[]>
}

export interface SkinUpload {
  name: string
  description: string
  skin: SkinDocument
}

const SIZES: ReadonlySet<string> = new Set(["small", "medium", "large"])
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGBA = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/
const COLOR_KEY = /^[a-zA-Z]{1,40}$/
const BOARD_ID = /^[a-z]+(?:\.[a-zA-Z]+)?$/
const WIDGET_TYPE = /^\w{1,64}$/

const fail = (path: string, problem: string): never => {
  throw new ValidationError(`${path} ${problem}`)
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

function text(v: unknown, path: string, min: number, max: number): string {
  if (typeof v !== "string") return fail(path, "must be a string")
  const t = v.trim()
  if (t.length < min || t.length > max) fail(path, `must be ${min} to ${max} characters`)
  return t
}

function optionalText(v: unknown, path: string, max: number): string | undefined {
  return v === undefined ? undefined : text(v, path, 0, max)
}

function theme(v: unknown): SkinDocument["theme"] {
  if (!isObject(v)) return fail("skin.theme", "must be an object")
  const name = text(v.name, "skin.theme.name", 1, 60)
  if (!isObject(v.colors)) return fail("skin.theme.colors", "must be an object")
  const entries = Object.entries(v.colors)
  if (entries.length > 60) fail("skin.theme.colors", "has too many keys")
  const colors: Record<string, string> = {}
  for (const [key, value] of entries) {
    const path = `skin.theme.colors.${key}`
    if (!COLOR_KEY.test(key)) fail(path, "is not a valid color name")
    if (typeof value !== "string" || !(HEX.test(value) || RGBA.test(value)))
      fail(path, "must be a hex or rgba() color")
    colors[key] = value as string
  }
  return { name, colors }
}

function widget(v: unknown, path: string): SkinWidget {
  if (!isObject(v)) return fail(path, "must be an object")
  if (typeof v.type !== "string" || !WIDGET_TYPE.test(v.type)) fail(`${path}.type`, "is not a valid widget type")
  if (typeof v.size !== "string" || !SIZES.has(v.size)) fail(`${path}.size`, "must be small, medium or large")
  if (!Number.isInteger(v.order) || (v.order as number) < 0 || (v.order as number) > 999)
    fail(`${path}.order`, "must be an integer from 0 to 999")
  const out: SkinWidget = { type: v.type as string, size: v.size as WidgetSize, order: v.order as number }
  const title = optionalText(v.title, `${path}.title`, 60)
  const icon = optionalText(v.icon, `${path}.icon`, 40)
  const subtitle = optionalText(v.subtitle, `${path}.subtitle`, 60)
  if (title !== undefined) out.title = title
  if (icon !== undefined) out.icon = icon
  if (subtitle !== undefined) out.subtitle = subtitle
  return out
}

function boards(v: unknown): Record<string, SkinWidget[]> {
  if (!isObject(v)) return fail("skin.boards", "must be an object")
  const entries = Object.entries(v)
  if (entries.length > 30) fail("skin.boards", "has too many boards")
  const out: Record<string, SkinWidget[]> = {}
  for (const [id, list] of entries) {
    const path = `skin.boards.${id}`
    if (!BOARD_ID.test(id)) fail(path, "is not a valid board id")
    if (!Array.isArray(list)) return fail(path, "must be a list")
    if (list.length > 40) fail(path, "has too many widgets")
    out[id] = list.map((w, i) => widget(w, `${path}[${i}]`))
  }
  return out
}

/** Validates a publish or update body, keeping only the known fields. Throws `ValidationError` naming the first bad path. */
export function validateSkinUpload(body: unknown): SkinUpload {
  if (!isObject(body)) return fail("body", "must be an object")
  const name = text(body.name, "name", 1, 60)
  const description = body.description === undefined ? "" : text(body.description, "description", 0, 500)
  const raw = body.skin
  if (!isObject(raw)) return fail("skin", "must be an object")
  if (raw.format !== 1) fail("skin.format", "must be 1")
  const skin: SkinDocument = { format: 1 }
  if (raw.theme !== undefined) skin.theme = theme(raw.theme)
  if (raw.boards !== undefined) skin.boards = boards(raw.boards)
  const hasBoards = skin.boards !== undefined && Object.keys(skin.boards).length > 0
  if (!skin.theme && !hasBoards) throw new ValidationError("skin must include a theme or boards")
  return { name, description, skin }
}

const SWATCH_KEYS = ["background", "surface", "accent", "textPrimary"]

export function swatchOf(skin: SkinDocument): string[] {
  const colors = skin.theme?.colors
  if (!colors) return []
  return SWATCH_KEYS.flatMap((k) => (colors[k] ? [colors[k]] : []))
}

/** The skins columns derived from a skin, in order: body, has_theme, has_boards, swatch. */
export const skinColumns = (skin: SkinDocument) => [
  JSON.stringify(skin),
  !!skin.theme,
  !!skin.boards && Object.keys(skin.boards).length > 0,
  JSON.stringify(swatchOf(skin)),
]
