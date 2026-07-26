import { inflateSync } from 'node:zlib'

/**
 * Sidräkning för PDF — utan tredjepartsberoende.
 *
 * Varför alls: Anthropic tar emot max 600 sidor per PDF. Utan en kontroll här
 * upptäcks en 700-sidig fil först vid modellanropet, efter att användaren
 * väntat på uppladdning och efter att vi betalat för att skicka den. Felet ska
 * komma när filen väljs, på svenska, inte som ett API-fel längre fram.
 *
 * Varför handrullat: samma resonemang som `file-validation.ts` — Eveno har
 * inget PDF-bibliotek, och att dra in ett för EN siffra är fel växling
 * (lockfilen är dessutom notoriskt brusig att röra). Räkningen nedan är liten,
 * deterministisk och läser bara struktur, aldrig innehåll.
 *
 * SÅ HÄR RÄKNAS DET, i tur och ordning:
 *  1. `/Type /Pages` med `/Count N` — sidträdets rotnod bär totalen. Störst
 *     vinner, för nästlade Pages-noder bär delsummor.
 *  2. Antalet `/Type /Page`-objekt (utan s) — fungerar när trädet inte har
 *     någon läsbar Count.
 *  3. Samma två sökningar igen, men inuti FlateDecode-komprimerade
 *     objektströmmar (PDF 1.5+ lägger sidträdet i en `/ObjStm`). Utan det här
 *     steget returnerar räknaren 0 för allt Word, Chrome och Puppeteer
 *     producerar — alltså för de flesta PDF:er en användare faktiskt har.
 *
 * RETURNERAR `null` när ingen av metoderna hittar något. Det är MEDVETET inte
 * ett fel: en fil vi inte kan räkna ska inte blockeras, den ska släppas fram
 * med en logg. Att avvisa en giltig PDF för att vår parser inte förstod den är
 * värre än att låta Anthropic avvisa den i det sällsynta fallet.
 */

/** Övre gräns på hur mycket vi inflaterar ur en enskild ström (DoS-räcke). */
const MAX_INFLATED_BYTES = 8 * 1024 * 1024
/** Max antal strömmar vi bryr oss om — sidträdet ligger tidigt, inte på slutet. */
const MAX_STREAMS_SCANNED = 200

const PAGES_COUNT_RE = /\/Type\s*\/Pages\b[^]{0,400}?\/Count\s+(\d+)/g
const COUNT_PAGES_RE = /\/Count\s+(\d+)[^]{0,400}?\/Type\s*\/Pages\b/g
// `/Type /Page` men INTE `/Pages` — negativ lookahead på s.
const PAGE_OBJ_RE = /\/Type\s*\/Page(?![s\w])/g

function scanText(text: string): number {
  let best = 0
  for (const re of [PAGES_COUNT_RE, COUNT_PAGES_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const n = Number.parseInt(m[1]!, 10)
      if (Number.isFinite(n) && n > best) best = n
    }
  }
  PAGE_OBJ_RE.lastIndex = 0
  const direct = text.match(PAGE_OBJ_RE)?.length ?? 0
  return Math.max(best, direct)
}

/**
 * Inflatera FlateDecode-strömmar och läs sidträdet ur dem. Nödvändigt för alla
 * moderna PDF:er, där objekten ligger i komprimerade objektströmmar.
 */
function scanCompressedStreams(buf: Buffer): number {
  let best = 0
  let searchFrom = 0
  let scanned = 0

  while (scanned < MAX_STREAMS_SCANNED) {
    const streamAt = buf.indexOf('stream', searchFrom, 'latin1')
    if (streamAt === -1) break

    // Hoppa över radbrytningen efter nyckelordet (\r\n eller \n).
    let dataAt = streamAt + 'stream'.length
    if (buf[dataAt] === 0x0d) dataAt++
    if (buf[dataAt] === 0x0a) dataAt++

    const endAt = buf.indexOf('endstream', dataAt, 'latin1')
    searchFrom = endAt === -1 ? streamAt + 6 : endAt + 9
    if (endAt === -1) break
    scanned++

    const raw = buf.subarray(dataAt, endAt)
    if (raw.length === 0 || raw.length > MAX_INFLATED_BYTES) continue

    try {
      const inflated = inflateSync(raw, { maxOutputLength: MAX_INFLATED_BYTES })
      const found = scanText(inflated.toString('latin1'))
      if (found > best) best = found
    } catch {
      // Inte en zlib-ström (bild, teckensnitt, annan filterkedja) — ointressant.
    }
  }

  return best
}

/**
 * Antal sidor i en PDF, eller `null` om det inte gick att avgöra.
 *
 * `latin1` används genomgående: PDF-strukturen är byteorienterad ASCII, och
 * utf8-avkodning skulle förstöra byte-offsets i binärt innehåll.
 */
export function countPdfPages(buffer: Buffer): number | null {
  const head = buffer.subarray(0, 5).toString('latin1')
  if (!head.startsWith('%PDF')) return null

  const plain = scanText(buffer.toString('latin1'))
  if (plain > 0) return plain

  const compressed = scanCompressedStreams(buffer)
  return compressed > 0 ? compressed : null
}
