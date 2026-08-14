/**
 * SKALÄRA KOLUMNER PÅ EN PRISMA-MODELL — delad testhjälp.
 *
 * Används av partitionstesterna som bevakar SAFE_*_SELECT-konstanterna: varje
 * kolumn på modellen måste stå antingen i selecten eller i en deklarerad
 * utelämnandelista med skäl. Den kontrollen står och faller med att "kolumn"
 * betyder rätt sak.
 *
 * ── Varför den bor här och inte i varje spec ─────────────────────────────────
 *
 * Regeln nedan är subtil, och #445 kräver samma partition för fem modeller. Fem
 * kopior av en subtil regel är fem tillfällen för en att tyst drifta — och en
 * driftad relationsdetektor gör inte testet rött, den gör det BLINT. Det märks
 * inte förrän någon läcker något.
 *
 * ── Regeln, och felet den rättar ─────────────────────────────────────────────
 *
 * Ett fält är skalärt om dess typ är en Prisma-skalär ELLER ett enum som deklareras
 * i schemat. Allt annat är en relation.
 *
 * Första versionen (invoice-bank-transaction-select.spec.ts, #444) mönstermatchade
 * i stället på relationstypernas NAMN: `/^(Organization|Invoice|RentNotice)/`.
 * Den var korrekt på BankTransaction, men av en tillfällighet — prefixet
 * "Invoice" råkade fånga `InvoicePayment` och "RentNotice" råkade fånga
 * `RentNoticePayment`. En relation med ett annat namn hade sluppit igenom,
 * räknats som kolumn, och krävt en motivering som ingen kunde skriva.
 *
 * På Organization var samma sorts uppräkning direkt fel: `maintenanceTicketSequence`
 * och `invoiceNumberSequence` är 1:1-relationer utan `[]`, och de klassades som
 * kolumner. Det upptäcktes när typspärren visade att de kom ut som OBJEKT i
 * svaret — alltså två relaterade rader som inte returnerades innan. Ett fel
 * infört av själva åtgärden, fångat av negativkontrollen.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma')

/** Prisma 5:s inbyggda skalärtyper. */
const PRISMA_SKALÄRER = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
])

function läsSchema(): string {
  return readFileSync(SCHEMA, 'utf8')
}

/** Alla enum-namn som deklareras i schemat. Enums serialiseras som värden. */
function enumNamn(src: string): Set<string> {
  return new Set([...src.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1] as string))
}

/**
 * Skalära kolumner på `modell`, i schemats ordning. Relationer utelämnas — de
 * har sin egen SAFE_*_SELECT om de behöver en.
 *
 * Kastar om modellen inte finns, i stället för att returnera en tom lista: ett
 * stavfel i modellnamnet ska falla testet, inte göra partitionen tomt-sann.
 */
export function skaläraKolumner(modell: string): string[] {
  const src = läsSchema()
  const start = src.indexOf(`model ${modell} {`)
  if (start === -1) {
    throw new Error(`schema-columns: modellen ${modell} finns inte i schema.prisma`)
  }
  const enums = enumNamn(src)
  const kropp = src.slice(start, src.indexOf('\n}', start))

  const ut: string[] = []
  for (const rad of kropp.split('\n').slice(1)) {
    const t = rad.trim()
    if (t === '' || t.startsWith('//') || t.startsWith('@@')) continue
    const m = /^(\w+)\s+(\w+)(\[\])?/.exec(t)
    if (!m) continue
    const [, namn, typ, lista] = m
    if (namn === undefined || typ === undefined) continue
    if (lista !== undefined) continue // listrelation
    if (!PRISMA_SKALÄRER.has(typ) && !enums.has(typ)) continue // 1:1/1:n-relation
    ut.push(namn)
  }
  return ut
}
