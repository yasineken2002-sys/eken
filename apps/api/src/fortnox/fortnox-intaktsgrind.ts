/**
 * TESTKUND-20261004/006 — INTÄKTSGRIND före Fortnox-export (F-TK-5, F-TK-6, G-1–G-3).
 *
 * VARFÖR: Eveno har ingen godkänd kontomappning. Exporten skickar Evenos kontonummer 1:1, men
 * samma nummer betyder inte samma sak i kundens Fortnox-plan (Bas 2026: 3911 "Hyresintäkter" med
 * momskod HFS = frivillig skattskyldighet; 3912 "Arrendeintäkter"; 3970 "Vinst vid avyttring" —
 * medan Eveno bokar momsfri bostadshyra, parkering resp. vattenersättning där). Att skicka en
 * intäktsrad på ett kontonummer vars innebörd inte stämts av vore att skicka på en GISSAD
 * innebörd. Därför stoppas varje intäktsrad före POST, med ett begripligt skäl per konto:
 *
 *   ACCOUNT_UNVERIFIED            kontot saknas eller är inaktivt i Fortnox (F-TK-5)
 *   ACCOUNT_VAT_MISMATCH          känd motsägelse mellan radens momsbehandling och kontots
 *                                 Fortnox-momskod, i BÅDA riktningar (F-TK-6, G-1)
 *   ACCOUNT_MEANING_UNRECONCILED  i övrigt: kontots innebörd är inte avstämd (G-3)
 *
 * Momskoden används för att namnge en känd motsägelse och — för MF vid belagd momsfri
 * bostadshyra — som "tekniskt förenlig momskod" (byggledarbeslut 006-A, ekonomisk policy B-2,
 * inte C1:s). Momskoden godkänner ALDRIG kontots innebörd: även en förenlig kod ger
 * ACCOUNT_MEANING_UNRECONCILED så länge ingen godkänd kontomappning finns. Null, tomt, saknat
 * eller okänt räknas aldrig som bevis. Ingen överstyrning, inget kontobyte, ingen ombokning.
 *
 * Momsbehandlingen härleds PER RAD ur radens källa (G-2), aldrig ur förekomsten av 26xx i
 * verifikatet. Bara hyresavins egen intäktsrad kan få en belagd behandling; manuell rad, AI-rad,
 * okänd källa, ändrad enhet eller avvikande belopp blir OBEVISAD. En rättelse ärver
 * originalradens behandling (B-3).
 *
 * Rader som inte är intäktsrader (betalningar, depositioner, moms, kostnader) berörs inte.
 */
import type { Prisma, UnitType } from '@prisma/client'
import { revenueAccountForUnitType, vatRateForRent } from '@eken/shared'

/** Fortnox momskoder för momspliktig försäljning (Fortnox: avvikelsekontrollens MP1–MP3/HFS). */
export const MOMSPLIKTIGA_KODER: readonly string[] = ['MP1', 'MP2', 'MP3', 'HFS']
/**
 * POLICY B-2 (byggledarbeslut 006-A, inte C1:s): MF ("Övrig försäljning utan moms", Skatteverket
 * fält 42) räknas som TEKNISKT FÖRENLIG momskod för en rad med belagd momsfri bostadshyra.
 * Det godkänner inte kontots innebörd (se ovan).
 */
export const MOMSFRI_FORENLIGA_KODER: readonly string[] = ['MF']

export type Behandling =
  | { typ: 'MOMSFRI'; kalla: string }
  | { typ: 'MOMSPLIKTIG'; sats: number; kalla: string }
  | { typ: 'OBEVISAD'; skal: string }

export interface FortnoxKontoFakta {
  number: number
  finns: boolean
  active: boolean | null
  name: string | null
  /** undefined = fältet saknades i svaret; null/'' = utan momskod. */
  vatCode: string | null | undefined
}

export type Intaktsutfall =
  | 'ACCOUNT_UNVERIFIED'
  | 'ACCOUNT_VAT_MISMATCH'
  | 'ACCOUNT_MEANING_UNRECONCILED'

export interface Kontobedomning {
  konto: number
  evenoNamn: string
  fortnox: FortnoxKontoFakta
  behandlingar: Behandling[]
  utfall: Intaktsutfall
  momskod: 'KONFLIKT' | 'FORENLIG' | 'EJ_BELAGD'
  text: string
}

/** Är raden en intäktsrad (Evenos egen klassning REVENUE, eller kontoklass 3)? */
export function arIntaktskonto(account: { number: number; type?: string | null }): boolean {
  return account.type === 'REVENUE' || (account.number >= 3000 && account.number <= 3999)
}

const kodText = (v: string | null | undefined) =>
  v === undefined
    ? 'momskod saknas i svaret'
    : v === null || v === ''
      ? 'ingen momskod'
      : `momskod ${v}`

const behandlingText = (b: Behandling) =>
  b.typ === 'MOMSFRI'
    ? `momsfri (${b.kalla})`
    : b.typ === 'MOMSPLIKTIG'
      ? `momspliktig ${b.sats} % (${b.kalla})`
      : `obevisad: ${b.skal}`

/** Ren klassning av ett intäktskonto ur Fortnox-fakta och radernas behandlingar. */
export function bedomKonto(
  konto: number,
  evenoNamn: string,
  fortnox: FortnoxKontoFakta,
  behandlingar: Behandling[],
): Kontobedomning {
  const kod = fortnox.vatCode
  const tomKod = kod === undefined || kod === null || kod === ''
  let konflikt = false
  let allaForenliga = behandlingar.length > 0
  for (const b of behandlingar) {
    if (b.typ === 'MOMSFRI' && !tomKod && MOMSPLIKTIGA_KODER.includes(kod!)) konflikt = true
    else if (b.typ === 'MOMSPLIKTIG' && (tomKod || MOMSFRI_FORENLIGA_KODER.includes(kod!)))
      konflikt = true
    if (!(b.typ === 'MOMSFRI' && !tomKod && MOMSFRI_FORENLIGA_KODER.includes(kod!)))
      allaForenliga = false
  }
  const momskod = konflikt ? 'KONFLIKT' : allaForenliga ? 'FORENLIG' : 'EJ_BELAGD'
  const utfall: Intaktsutfall =
    !fortnox.finns || fortnox.active !== true
      ? 'ACCOUNT_UNVERIFIED'
      : konflikt
        ? 'ACCOUNT_VAT_MISMATCH'
        : 'ACCOUNT_MEANING_UNRECONCILED'
  const fx = fortnox.finns
    ? `Fortnox «${fortnox.name ?? '?'}» (${fortnox.active === true ? 'aktivt' : 'inaktivt'}, ${kodText(kod)})`
    : 'finns inte i Fortnox för året'
  const skal =
    utfall === 'ACCOUNT_UNVERIFIED'
      ? 'kontot är inte aktivt i Fortnox'
      : utfall === 'ACCOUNT_VAT_MISMATCH'
        ? 'momskoden motsäger radens momsbehandling'
        : momskod === 'FORENLIG'
          ? 'momskoden är förenlig (policy B-2) men kontots innebörd är inte avstämd — ingen godkänd kontomappning'
          : 'kontots innebörd och momsbehandling är inte avstämda — ingen godkänd kontomappning'
  const text = `${konto} Eveno «${evenoNamn}» ↔ ${fx}; rad: ${[...new Set(behandlingar.map(behandlingText))].join(', ')}; ${skal}`
  return { konto, evenoNamn, fortnox, behandlingar, utfall, momskod, text }
}

const UTFALL_ORDNING: Intaktsutfall[] = [
  'ACCOUNT_UNVERIFIED',
  'ACCOUNT_VAT_MISMATCH',
  'ACCOUNT_MEANING_UNRECONCILED',
]

/** Stoppkod och skäl för ett verifikats intäktskonton (null = inga intäktsrader). */
export function stoppForIntakter(
  bedomningar: Kontobedomning[],
): { kod: Intaktsutfall; text: string } | null {
  if (bedomningar.length === 0) return null
  const kod = UTFALL_ORDNING.find((u) => bedomningar.some((b) => b.utfall === u))!
  return {
    kod,
    text:
      'Intäktsrad stoppas före export: ' +
      bedomningar.map((b) => b.text).join(' | ') +
      '. Stäm av med redovisningsansvarig.',
  }
}

type Rad = {
  id: string
  debit: Prisma.Decimal | null
  credit: Prisma.Decimal | null
  account: { number: number; type?: string | null }
}
type Verifikat = {
  id: string
  sourceId: string | null
  source: string
  reversalOfEntryId: string | null
  lines: Rad[]
}
const ore = (d: Prisma.Decimal | null) => (d === null ? null : Math.round(Number(d) * 100))

/**
 * Behandling per intäktsrad ur verifikatets källa. Org-avgränsat. Rättelse ärver originalets
 * behandling för motsvarande rad (samma konto, motsatt sida, samma belopp).
 */
export async function harledBehandlingar(
  db: Prisma.TransactionClient,
  organizationId: string,
  entry: Verifikat,
  djup = 0,
): Promise<Map<string, Behandling>> {
  const ut = new Map<string, Behandling>()
  const intakter = entry.lines.filter((l) => arIntaktskonto(l.account))
  if (intakter.length === 0) return ut
  const obevisad = (skal: string) => {
    for (const l of intakter) ut.set(l.id, { typ: 'OBEVISAD', skal })
    return ut
  }
  if (entry.reversalOfEntryId) {
    if (djup > 0) return obevisad('rättelse av rättelse')
    const orig = await db.journalEntry.findFirst({
      where: { id: entry.reversalOfEntryId, organizationId },
      select: {
        id: true,
        sourceId: true,
        source: true,
        reversalOfEntryId: true,
        lines: {
          select: {
            id: true,
            debit: true,
            credit: true,
            account: { select: { number: true, type: true } },
          },
        },
      },
    })
    if (!orig) return obevisad('rättelsens original finns inte i organisationen')
    const origB = await harledBehandlingar(db, organizationId, orig, djup + 1)
    for (const l of intakter) {
      const motsv = orig.lines.find(
        (o) =>
          o.account.number === l.account.number &&
          ore(o.debit) === ore(l.credit) &&
          ore(o.credit) === ore(l.debit),
      )
      const b = motsv ? origB.get(motsv.id) : undefined
      ut.set(
        l.id,
        b
          ? b.typ === 'OBEVISAD'
            ? b
            : { ...b, kalla: `rättelse av ${b.kalla}` }
          : { typ: 'OBEVISAD', skal: 'rättelseraden motsvarar ingen originalrad' },
      )
    }
    return ut
  }
  const m = /^rent-notice:(.+)$/.exec(entry.sourceId ?? '')
  if (!m) return obevisad(`momsbehandling kan inte beläggas (källa ${entry.source})`)
  const avi = await db.rentNotice.findFirst({
    where: { id: m[1]!, organizationId },
    select: {
      noticeNumber: true,
      amount: true,
      vatAmount: true,
      lease: {
        select: {
          organizationId: true,
          unit: { select: { type: true, voluntaryTaxLiability: true } },
        },
      },
    },
  })
  if (!avi) return obevisad('hyresavin finns inte i organisationen')
  const unit = avi.lease?.organizationId === organizationId ? avi.lease.unit : null
  if (!unit?.type) return obevisad('avins avtal eller enhetstyp saknas')
  const vantatKonto = revenueAccountForUnitType(unit.type as UnitType)
  const netto = ore(avi.amount)
  const moms = ore(avi.vatAmount) ?? 0
  const sats = netto && netto > 0 ? Math.round((moms / netto) * 100) : 0
  const regel = vatRateForRent(unit.type as UnitType, unit.voluntaryTaxLiability)
  for (const l of intakter) {
    const skal =
      l.account.number !== vantatKonto
        ? `kontot stämmer inte med enhetens nuvarande typ ${unit.type} (${vantatKonto})`
        : l.debit !== null || ore(l.credit) !== netto
          ? 'raden motsvarar inte avins nettobelopp'
          : sats !== regel
            ? `avins moms ${sats} % stämmer inte med enhetens nuvarande momsregel ${regel} %`
            : null
    ut.set(
      l.id,
      skal
        ? { typ: 'OBEVISAD', skal }
        : sats === 0
          ? { typ: 'MOMSFRI', kalla: `hyresavi ${avi.noticeNumber}, ${unit.type}` }
          : { typ: 'MOMSPLIKTIG', sats, kalla: `hyresavi ${avi.noticeNumber}, ${unit.type}` },
    )
  }
  return ut
}
