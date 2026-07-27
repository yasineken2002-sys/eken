/**
 * CP437-kodning (IBM PC 8-bitars extended ASCII) för SIE4-export.
 *
 * SIE 4B-specifikationen lämnar inget val:
 *   §5.8      "Teckenrepertoaren i filen ska vara IBM PC 8-bitars extended
 *              ASCII (Codepage 437)"
 *   §#FORMAT  "Tills vidare tillåter standarden endast IBM Extended 8-bit
 *              ASCII (PC8 - codepage 437)"
 *
 * UTF-8 är alltså inte ett tillåtet alternativ — filen deklarerade `#FORMAT PC8`
 * men skrevs som UTF-8, vilket gjorde att å/ä/ö i kontonamn och verifikations-
 * texter feltolkades av mottagande bokslutsprogram (ett "ö" blev två byte som
 * CP437 läser som två skräptecken).
 *
 * Tabellen handrullas hellre än att dra in ett beroende: det är 128 fasta
 * poster som aldrig ändras, och lockfilen i det här repot driver isär vid
 * `pnpm add`.
 */

/** Unicode-tecken för CP437-byte 0x80–0xFF, i ordning. */
const HIGH_RANGE =
  'ÇüéâäàåçêëèïîìÄÅ' + // 0x80–0x8F
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' + // 0x90–0x9F
  'áíóúñÑªº¿⌐¬½¼¡«»' + // 0xA0–0xAF
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' + // 0xB0–0xBF
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' + // 0xC0–0xCF
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' + // 0xD0–0xDF
  'αßΓπΣσµτΦΘΩδ∞φε∩' + // 0xE0–0xEF
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ' // 0xF0–0xFF

const UNICODE_TO_CP437 = new Map<string, number>()
for (let i = 0; i < HIGH_RANGE.length; i++) {
  UNICODE_TO_CP437.set(HIGH_RANGE[i]!, 0x80 + i)
}

/**
 * Tecken som saknar CP437-motsvarighet men har en rimlig ASCII-approximation.
 * Utan detta hade t.ex. ett typografiskt citattecken i ett kontonamn blivit
 * ersättningstecknet och sett ut som datafel i mottagarens program.
 */
const ASCII_FALLBACK: Record<string, string> = {
  '–': '-', // en dash
  '—': '-', // em dash
  '‘': "'", // vänster enkelt citattecken
  '’': "'", // höger enkelt citattecken / apostrof
  '“': '"', // vänster dubbelt citattecken
  '”': '"', // höger dubbelt citattecken
  '…': '...', // ellips
  ' ': ' ', // hard space → vanligt mellanslag (0xFF finns men läses ofta fel)
}

/** Tecken som varken finns i CP437 eller har en approximation. */
const REPLACEMENT = 0x3f // '?'

/**
 * Kodar en sträng till CP437-byte.
 *
 * Tecken utanför repertoaren ersätts deterministiskt — först via
 * ASCII_FALLBACK, annars med '?'. Att tappa ett tecken tyst vore värre: en
 * SIE-fil ska kunna läsas rad för rad av en revisor, och ett osynligt bortfall
 * i ett kontonamn är svårare att upptäcka än ett frågetecken.
 */
export function encodeCp437(text: string): Buffer {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (code < 0x80) {
      bytes.push(code) // ren ASCII — identisk i CP437
      continue
    }
    const mapped = UNICODE_TO_CP437.get(char)
    if (mapped !== undefined) {
      bytes.push(mapped)
      continue
    }
    const fallback = ASCII_FALLBACK[char]
    if (fallback !== undefined) {
      for (const f of fallback) bytes.push(f.charCodeAt(0))
      continue
    }
    bytes.push(REPLACEMENT)
  }
  return Buffer.from(bytes)
}

/** Avkodar CP437-byte till en sträng. Finns för test och felsökning. */
export function decodeCp437(buffer: Buffer): string {
  let out = ''
  for (const byte of buffer) {
    out += byte < 0x80 ? String.fromCharCode(byte) : HIGH_RANGE[byte - 0x80]!
  }
  return out
}
