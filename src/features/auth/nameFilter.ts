// Distinctive enough to refuse even inside a longer word ("xfuckx").
const EMBEDDED = [
  "fuck", "shit", "cunt", "bitch", "pussy", "asshole", "bastard", "whore",
  "slut", "wank", "twat", "bollocks", "porn", "rapist", "pedophile", "paedophile",
  "molest", "incest", "nigger", "nigga", "faggot", "retard", "tranny", "wetback",
  "raghead", "hitler", "dildo", "hentai", "vagina", "malaka", "poutana",
  "poustis", "kariolis",
]

// Refused only as a whole word, since they also occur inside real names
// ("Hancock", "Grapes", "Spicer", "Analise", "Cumberland").
const WHOLE = [
  "fuk", "fck", "cock", "dick", "prick", "rape", "pedo", "paedo", "fag", "spic",
  "chink", "kike", "gook", "nazi", "kkk", "cum", "anal", "boob", "boobs", "tits",
  "penis", "sex", "nude", "milf", "xxx", "gamw", "gamo", "mouni",
]

const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b",
  "@": "a", "$": "s", "!": "i", "|": "l",
}

// Lowercase Latin words, with spelled-out runs ("f u c k", "f.u.c.k") joined into one.
function words(value: string): string[] {
  const raw = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[0-9@$!|]/g, (c) => LEET[c] ?? c)
    .split(/[^a-z]+/)
    .filter(Boolean)
  const out: string[] = []
  let run = ""
  for (const w of raw) {
    if (w.length === 1) { run += w; continue }
    if (run) out.push(run)
    run = ""
    out.push(w)
  }
  if (run) out.push(run)
  return out
}

// ponytail: a fixed word list, so misspellings and non-Latin scripts get through. Reports cover the rest.
export function containsBannedWord(value: string): boolean {
  return words(value).some((w) => WHOLE.includes(w) || EMBEDDED.some((b) => w.includes(b)))
}

/** Letters (any script), digits, single inner spaces and . ' - _ */
const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}.'_-]| (?=[^ ]))*$/u

/** Why `name` (already trimmed) is refused as a display name, or null when it is fine. */
export function displayNameError(name: string): string | null {
  if (!DISPLAY_NAME_PATTERN.test(name)) return "Name can only contain letters, numbers, spaces and . ' - _"
  if (containsBannedWord(name)) return "Name contains a word that isn't allowed"
  return null
}

export function usernameError(username: string): string | null {
  return containsBannedWord(username) ? "Username contains a word that isn't allowed" : null
}
