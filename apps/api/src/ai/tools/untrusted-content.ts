// ── Prompt-injection-härdning av owner-AI:ns tool-results ───────────────────────
// Fält vars VÄRDE kan vara skrivet av en hyresgäst eller extern betalare (t.ex.
// felanmälnings-fritext, banköverföringens meddelande/OCR, hyresgäst-angivna namn).
// Sådan text matas tillbaka till modellen i tool-loopen och får ALDRIG tolkas som
// instruktioner. Spegel av tenant-AI:ns inramning (<HYRESGAST_MEDDELANDE> + taggstripp).
//
// Ren utility utan service-beroenden (importeras av tool-executor + testet utan att
// dra in hela DI-grafen/AWS-SDK).

const UNTRUSTED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'description',
  'title',
  'content',
  'notes',
  'rawOcr',
  'ocr',
  'firstName',
  'lastName',
  'companyName',
  'reason',
  'message',
])

// Sentinel-taggar som ramar in osäker text. Unicode-hörnparenteser (⟦ ⟧) väljs för
// att de nästan aldrig förekommer i verklig data och är lätta att strippa i förväg.
export const UNTRUSTED_OPEN = '⟦OSÄKER⟧'
export const UNTRUSTED_CLOSE = '⟦/OSÄKER⟧'

// Misstänkta injektionsmönster — loggas best-effort (blockerar ej; inramningen +
// systemprompten är försvaret). Spegel av TenantAiService.INJECTION_PATTERN.
const OWNER_INJECTION_PATTERN =
  /\b(ignorera|bortse från|glöm)\b.{0,30}\b(instruktion|regler|ovan|tidigare|system)\b|system\s*prompt|system\s*:|du är nu|you are now|admin[- ]?läge|developer mode|jailbreak|pausa\s+(alla\s+)?påminnelser|markera.{0,20}betald/i

// Strippar sentinel- och XML-liknande taggar så att osäker text inte kan stänga
// ⟦OSÄKER⟧ i förtid eller förfalska ett systemblock (samma princip som tenant-AI
// rad 154), och ramar därefter in värdet. Sätter flags.hit vid misstänkt mönster.
export function neutralizeUntrusted<T>(
  value: T,
  key?: string,
  flags?: { hit: boolean },
  depth = 0,
): T {
  if (depth > 12 || value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((v) => neutralizeUntrusted(v, key, flags, depth + 1)) as unknown as T
  }
  if (typeof value === 'object' && !(value instanceof Date) && !(value instanceof Buffer)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = neutralizeUntrusted(v, k, flags, depth + 1)
    }
    return out as unknown as T
  }
  if (typeof value === 'string' && key && UNTRUSTED_FIELD_NAMES.has(key)) {
    if (flags && OWNER_INJECTION_PATTERN.test(value)) flags.hit = true
    const clean = value.replace(/⟦\/?[^⟦⟧]*⟧/g, ' ').replace(/<\/?[A-Za-z_]+>/g, ' ')
    return `${UNTRUSTED_OPEN}${clean}${UNTRUSTED_CLOSE}` as unknown as T
  }
  return value
}
