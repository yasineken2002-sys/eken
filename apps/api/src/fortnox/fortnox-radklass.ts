/**
 * TESTKUND-20261004/008 — RADKLASS: händelse, roll och momsbehandling per bokföringsrad, härledd ur
 * verifikatets källa i organisationsgränsen (KONTRAKT-008 §2, KONTRAKTSBESKED-008 V1/V3).
 *
 * Stödda händelser i v1 (allt annat är EVENT_UNSUPPORTED med namn):
 *   H1 hyra bostad        INVOICE rent-notice:<avi>             1510 D KUNDFORDRAN / 39xx K HYRESINTAKT MOMSFRI
 *   H2 hyresbetalning     rent-notice-(bank-)payment:<al>  19xx D LIKVID / 1510 K KUNDFORDRAN
 *   H3 deposition         deposit-invoice:<dep>            1510 D KUNDFORDRAN / 2890 K DEPOSITIONSSKULD
 *                         deposit-manual-payment:<dep>     19xx D LIKVID / 1510 K KUNDFORDRAN
 *                         deposit-refund:<dep> utan avdrag 2890 D DEPOSITIONSSKULD / 19xx K LIKVID
 *   H4 leverantörsfaktura supplier-invoice:<id>            kostnad D KOSTNAD, 2641 D INGAENDE_MOMS,
 *                                                          2440 K LEVERANTORSSKULD
 *                         supplier-invoice-payment:<id>    2440 D LEVERANTORSSKULD / 19xx K LIKVID
 *   Rättelse              ärver originalets roll och behandling per motsvarande rad (B-3/K2.3).
 *
 * TESTKUND-027 (KONTRAKT-P2-027, KRITERIER-P2-024/025):
 *   H3 deposition (c1/c3) invoice-(manual|bank)-payment:<al> 19xx D LIKVID / 1510 K KUNDFORDRAN —
 *                         bara för Invoice(type DEPOSIT) med Deposit(invoiceId) i organisationen
 *   H3 deposition (c2)    rent-notice-(bank-)payment:<al>  avi type DEPOSIT med Deposit(rentNoticeId)
 *   D1 återbetalning      deposit-refund kräver dessutom att depositionens MOTTAGNINGAR (alla
 *                         kvarvarande allokeringar + deposit-manual-payment) är CONFIRMED i samma
 *                         Fortnox-företag och summerar exakt till Deposit.amount. År spelar ingen roll.
 *   L3 makulering         supplier-invoice-cancel:<id> = rättelse av supplier-invoice:<id>: exakt
 *                         omvända rader, roller ärvda, målkonton ur ORIGINALETS export (byggaren).
 *   Rättat före export    ett verifikat som har en rättelse (reversalOfEntryId) och ännu inte är
 *                         CONFIRMED exporteras aldrig (REVERSED_BEFORE_EXPORT).
 *
 * URSPRUNG (V3/K8.2): en betalning, en depositionsbetalning/-återbetalning och en leverantörs-
 * betalning exporteras bara när fordrans/skuldens ursprungsverifikat är CONFIRMED i SAMMA
 * Fortnox-företag, eller när fordran/depositionen uttryckligen ingår i ett VERKSTÄLLT öppningspaket
 * (redan IB i Fortnox). UNKNOWN, REJECTED, DRY_RUN_READY och "datum före brytdatum" räcker inte.
 * Samma regel i test- och kundvägen.
 */
import type { Prisma } from '@prisma/client'
import { arBelagdInnehallsavvisning } from '@eken/shared'
import { arIntaktskonto, harledBehandlingar } from './fortnox-intaktsgrind'
import { iKontoklass, type Momsbehandling, type Roll } from './fortnox-kontomappning'

export interface Radklass {
  roll: Roll
  behandling: Momsbehandling
}

export type Klassning =
  | { ok: true; handelse: string; rader: Map<string, Radklass>; rattelseAv: string | null }
  | {
      ok: false
      kod: 'EVENT_UNSUPPORTED' | 'ORIGIN_NOT_CONFIRMED' | 'REVERSED_BEFORE_EXPORT'
      skal: string
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

const ore = (d: Prisma.Decimal | null | undefined) =>
  d === null || d === undefined ? 0 : Math.round(Number(d) * 100)
// F-009-1: samma kontoklassregel som målsidan (fortnox-kontomappning.ts KONTOKLASS).
const arLikvid = (n: number) => iKontoklass('LIKVID', n)
const ej = (skal: string): Klassning => ({
  ok: false,
  kod: 'EVENT_UNSUPPORTED',
  skal: `${skal} — händelsen stöds inte av kontomappningen i denna version`,
})
const ursprung = (skal: string): Klassning => ({ ok: false, kod: 'ORIGIN_NOT_CONFIRMED', skal })

/** Är verifikatet med sourceId CONFIRMED-exporterat till samma Fortnox-företag? */
async function bekraftad(
  db: Prisma.TransactionClient,
  organizationId: string,
  // S-009-4: källan ingår — samma sourceId under en annan källa (t.ex. MANUAL) är inte originalet.
  source: 'INVOICE' | 'SUPPLIER_INVOICE',
  sourceId: string,
  databaseNumber: number,
): Promise<boolean> {
  const je = await db.journalEntry.findFirst({
    where: { organizationId, source, sourceId },
    select: { id: true },
  })
  if (!je) return false
  const ex = await db.fortnoxVoucherExport.findFirst({
    where: {
      organizationId,
      journalEntryId: je.id,
      state: 'CONFIRMED',
      fortnoxDatabaseNumber: databaseNumber,
    },
    select: { id: true },
  })
  return !!ex
}

/**
 * TESTKUND-027 D1: depositionens MOTTAGNINGAR, härledda ur produktens kedja (inga antaganden):
 * deposit-manual-payment:<dep> samt verifikatet för varje KVARVARANDE allokering på depositionsavin
 * (rent-notice-(bank-)payment:<a>) eller depositionsfakturan (invoice-(bank|manual)-payment:<a>).
 * Varje mottagning måste vara CONFIRMED i SAMMA Fortnox-företag; summan (1510-kredit i öre) måste
 * vara exakt depositionens belopp. Räkenskapsår spelar ingen roll — varje export bär sitt eget år.
 */
async function mottagningar(
  db: Prisma.TransactionClient,
  organizationId: string,
  dep: {
    id: string
    amount: Prisma.Decimal
    invoiceId: string | null
    rentNoticeId: string | null
  },
  databaseNumber: number,
): Promise<{ ok: true; summa: number } | { ok: false; skal: string }> {
  let allokerat = 0
  const kandidater: Array<{ namn: string; sourceIds: string[] }> = [
    { namn: 'manuell betalning', sourceIds: [`deposit-manual-payment:${dep.id}`] },
  ]
  if (dep.rentNoticeId) {
    const al = await db.rentNoticePayment.findMany({
      where: { rentNoticeId: dep.rentNoticeId, rentNotice: { organizationId } },
      select: { id: true, amount: true },
    })
    for (const a of al) allokerat += ore(a.amount)
    for (const a of al)
      kandidater.push({
        namn: `allokering ${a.id.slice(0, 8)} (avi)`,
        sourceIds: [`rent-notice-bank-payment:${a.id}`, `rent-notice-payment:${a.id}`],
      })
  }
  if (dep.invoiceId) {
    const al = await db.invoicePayment.findMany({
      where: { invoiceId: dep.invoiceId, invoice: { organizationId } },
      select: { id: true, amount: true },
    })
    for (const a of al) allokerat += ore(a.amount)
    for (const a of al)
      kandidater.push({
        namn: `allokering ${a.id.slice(0, 8)} (faktura)`,
        sourceIds: [`invoice-bank-payment:${a.id}`, `invoice-manual-payment:${a.id}`],
      })
  }
  const problem: string[] = []
  let summa = 0
  let antal = 0
  for (const k of kandidater) {
    const je = await db.journalEntry.findFirst({
      where: { organizationId, source: 'PAYMENT', sourceId: { in: k.sourceIds } },
      select: {
        id: true,
        lines: { select: { debit: true, credit: true, account: { select: { number: true } } } },
      },
    })
    if (!je) {
      // Den manuella vägen finns bara om den använts; en allokering utan verifikat är ett fel.
      if (k.namn !== 'manuell betalning') problem.push(`${k.namn}: verifikat saknas`)
      continue
    }
    antal++
    if (k.namn === 'manuell betalning')
      allokerat += je.lines
        .filter((l) => l.account.number === 1510 && l.credit !== null)
        .reduce((s, l) => s + ore(l.credit), 0)
    const rattad = await db.journalEntry.findFirst({
      where: { organizationId, reversalOfEntryId: je.id },
      select: { id: true },
    })
    if (rattad) {
      problem.push(`${k.namn}: mottagningen är rättad (avmatchad)`)
      continue
    }
    const u = await originalUtfall(db, organizationId, je.id, databaseNumber)
    if (u.typ !== 'CONFIRMED')
      problem.push(`${k.namn}: ${u.typ === 'OKANT' ? `OKÄNT — ${u.text}` : u.text}`)
    else
      summa += je.lines
        .filter((l) => l.account.number === 1510 && l.credit !== null)
        .reduce((s, l) => s + ore(l.credit), 0)
  }
  const hanvisning =
    ' Om depositionen togs emot före Fortnox-kopplingen eller brytdatum ska den ingå i ett ' +
    'verkställt öppningspaket.'
  if (antal === 0)
    return {
      ok: false,
      skal:
        'Ingen mottagning av depositionen är registrerad i Eveno — återbetalningen skulle minska ' +
        'banken i Fortnox utan motsvarande inbetalning.' +
        hanvisning,
    }
  if (problem.length)
    return {
      ok: false,
      skal:
        `Depositionens mottagning är inte bekräftat exporterad till samma Fortnox-företag (${problem.join('; ')}) — ` +
        'återbetalningen skulle minska banken i Fortnox utan motsvarande inbetalning.' +
        hanvisning,
    }
  if (summa !== allokerat)
    return {
      ok: false,
      skal:
        `Mottagningarnas verifikat (${(summa / 100).toFixed(2)} kr på 1510) motsvarar inte allokeringarna ` +
        `(${(allokerat / 100).toFixed(2)} kr) — stäm av mottagningarna`,
    }
  if (summa !== ore(dep.amount))
    return {
      ok: false,
      skal:
        `Bekräftat exporterade mottagningar är ${(summa / 100).toFixed(2)} kr men depositionen är ` +
        `${(ore(dep.amount) / 100).toFixed(2)} kr (${summa < ore(dep.amount) ? 'delbetalning' : 'överbetalning'}) — ` +
        'återbetalningen exporteras inte förrän mottagningen motsvarar depositionen.',
    }
  return { ok: true, summa }
}

/**
 * TESTKUND-027 V-6: SANT utfall för ett originals export. Bara avsaknad av exportrad,
 * DRY_RUN_READY, BLOCKED eller REJECTED med en BELAGD innehållsavvisning (kodparslistan) får kallas
 * «inte exporterad». UNKNOWN, SENDING, RECEIPT_*, REJECTED_429_*, REJECTED_NA_* och äldre 'REJECTED'
 * utan kod är OKÄNDA — de kan ha skrivits i Fortnox.
 */
export type OriginalUtfall =
  | { typ: 'CONFIRMED' }
  | { typ: 'INTE_EXPORTERAT'; text: string }
  | { typ: 'OKANT'; text: string }
  | { typ: 'ANNAT_FORETAG'; text: string }
export async function originalUtfall(
  db: Prisma.TransactionClient,
  organizationId: string,
  journalEntryId: string,
  databaseNumber: number,
): Promise<OriginalUtfall> {
  const ex = await db.fortnoxVoucherExport.findFirst({
    where: { organizationId, journalEntryId },
    select: { state: true, fortnoxDatabaseNumber: true, lastOutcome: true },
  })
  if (!ex) return { typ: 'INTE_EXPORTERAT', text: 'inte exporterad' }
  if (ex.state === 'CONFIRMED')
    return ex.fortnoxDatabaseNumber === databaseNumber
      ? { typ: 'CONFIRMED' }
      : { typ: 'ANNAT_FORETAG', text: 'exporterad till ett annat Fortnox-företag' }
  if (ex.state === 'DRY_RUN_READY' || ex.state === 'BLOCKED')
    return { typ: 'INTE_EXPORTERAT', text: 'inte exporterad' }
  if (ex.state === 'REJECTED') {
    const m = /^REJECTED_(\d{3})_(\d+)$/.exec(ex.lastOutcome ?? '')
    if (m && arBelagdInnehallsavvisning(Number(m[1]), Number(m[2])))
      return {
        typ: 'INTE_EXPORTERAT',
        text: `avvisad av Fortnox (${m[1]}/${m[2]}), inte exporterad`,
      }
  }
  return {
    typ: 'OKANT',
    text: `utfallet är okänt/pågår (${ex.state}${ex.lastOutcome ? ` ${ex.lastOutcome}` : ''}) — stäm av originalet först`,
  }
}

/**
 * TESTKUND-027 B2.5: ett CONFIRMED originals klassning ur dess FRYSTA exportutkast (roll och
 * behandling per verifikatrad). Efter en avmatchning är allokeringen raderad, så en ny klassning av
 * originalet ur levande data säger «stöds inte» — men originalet ÄR exporterat, och rättelsen ska då
 * kunna återföra exakt det som skickades. Null om originalet inte är CONFIRMED i samma företag.
 */
async function frystKlass(
  db: Prisma.TransactionClient,
  organizationId: string,
  originalId: string,
  databaseNumber: number,
): Promise<{ handelse: string; rader: Map<string, Radklass> } | null> {
  const ex = await db.fortnoxVoucherExport.findFirst({
    where: {
      organizationId,
      journalEntryId: originalId,
      state: 'CONFIRMED',
      fortnoxDatabaseNumber: databaseNumber,
    },
    select: { draft: true },
  })
  const km = (ex?.draft as { kontomappning?: { handelse?: unknown; rader?: unknown } } | null)
    ?.kontomappning
  if (!km || !Array.isArray(km.rader)) return null
  const rader = new Map<string, Radklass>()
  for (const r of km.rader as Array<{
    journalEntryLineId?: unknown
    roll?: unknown
    behandling?: unknown
  }>) {
    if (
      typeof r.journalEntryLineId !== 'string' ||
      typeof r.roll !== 'string' ||
      typeof r.behandling !== 'string'
    )
      return null
    rader.set(r.journalEntryLineId, {
      roll: r.roll as Roll,
      behandling: r.behandling as Momsbehandling,
    })
  }
  return { handelse: typeof km.handelse === 'string' ? km.handelse : 'exporterat original', rader }
}

/** Rättelsens rader mot originalets: exakt omvända (konto, debet↔kredit), ärvd roll per rad. */
function omvandaRader(
  rader: Map<string, Radklass>,
  rattelse: Rad[],
  original: Rad[],
  originalKlass: Map<string, Radklass>,
): string | null {
  const anvanda = new Set<string>()
  for (const l of rattelse) {
    const motsv = original.find(
      (o) =>
        !anvanda.has(o.id) &&
        o.account.number === l.account.number &&
        ore(o.debit) === ore(l.credit) &&
        ore(o.credit) === ore(l.debit),
    )
    const rk = motsv ? originalKlass.get(motsv.id) : undefined
    if (!motsv || !rk) return 'rättelseraden motsvarar ingen originalrad'
    anvanda.add(motsv.id)
    rader.set(l.id, rk)
  }
  if (anvanda.size !== original.length) return 'rättelsen återför inte hela originalet'
  return null
}

/** Ingår öppningsraden i ett VERKSTÄLLT öppningspaket i organisationen? */
async function iVerkstalltPaket(
  db: Prisma.TransactionClient,
  organizationId: string,
  openingRowId: string | null,
): Promise<boolean> {
  if (!openingRowId) return false
  const r = await db.openingPackageRow.findFirst({
    where: { id: openingRowId, package: { organizationId, status: 'EXECUTED' } },
    select: { id: true },
  })
  return !!r
}

/** Exakt två rader: debet på `d`, kredit på `k`, samma belopp (öre). */
function tvaRader(e: Verifikat, d: (n: number) => boolean, k: (n: number) => boolean) {
  if (e.lines.length !== 2) return null
  const deb = e.lines.find((l) => l.debit !== null && ore(l.debit) > 0 && l.credit === null)
  const kre = e.lines.find((l) => l.credit !== null && ore(l.credit) > 0 && l.debit === null)
  if (!deb || !kre || deb === kre) return null
  if (!d(deb.account.number) || !k(kre.account.number)) return null
  if (ore(deb.debit) !== ore(kre.credit)) return null
  return { deb, kre, belopp: ore(deb.debit) }
}

export async function klassaVerifikat(
  db: Prisma.TransactionClient,
  organizationId: string,
  entry: Verifikat,
  databaseNumber: number,
  djup = 0,
): Promise<Klassning> {
  const rader = new Map<string, Radklass>()
  const satt = (l: Rad, roll: Roll, behandling: Momsbehandling = 'EJ_TILLAMPLIG') =>
    rader.set(l.id, { roll, behandling })

  // ── Rättelse: ärver originalets roll/behandling för motsvarande rad. ──
  if (entry.reversalOfEntryId) {
    if (djup > 0) return ej('rättelse av rättelse')
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
    if (!orig) return ej('rättelsens original finns inte i organisationen')
    const fryst = await frystKlass(db, organizationId, orig.id, databaseNumber)
    const k = fryst
      ? ({ ok: true, ...fryst, rattelseAv: null } as const)
      : await klassaVerifikat(db, organizationId, orig, databaseNumber, djup + 1)
    if (!k.ok) return k.kod === 'EVENT_UNSUPPORTED' ? ej(`rättelse av: ${k.skal}`) : k
    const fel = omvandaRader(rader, entry.lines, orig.lines, k.rader)
    if (fel) return ej(fel)
    return { ok: true, handelse: `rättelse av ${k.handelse}`, rader, rattelseAv: orig.id }
  }

  // ── TESTKUND-027 B2.6: rättat FÖRE export. Ett verifikat som har en rättelse och ännu inte är
  // bekräftat exporterat skickas aldrig: originalet och rättelsen tar ut varandra i Eveno, och
  // Fortnox har ingetdera. (Ett CONFIRMED original byggs aldrig om; dess rättelse exporteras.)
  if (djup === 0) {
    const rattelse = await db.journalEntry.findFirst({
      where: { organizationId, reversalOfEntryId: entry.id },
      select: { id: true, sourceId: true },
    })
    if (rattelse)
      return {
        ok: false,
        kod: 'REVERSED_BEFORE_EXPORT',
        skal:
          `Verifikatet rättades (${rattelse.sourceId ?? 'rättelse'}) innan det exporterades — varken ` +
          'det eller rättelsen skickas till Fortnox; de tar ut varandra i Eveno',
      }
  }

  const sid = entry.sourceId ?? ''
  let m: RegExpExecArray | null

  // ── H1 hyra bostad ──
  // Produkten bokför hyresavin med source INVOICE och sourceId rent-notice:<id>
  // (AccountingService.createJournalEntryForRentNotice) — mätt i riggkörning 46.
  if ((m = /^rent-notice:(.+)$/.exec(sid)) && entry.source === 'INVOICE') {
    const avi = await db.rentNotice.findFirst({
      where: { id: m[1]!, organizationId },
      select: {
        type: true,
        totalAmount: true,
        lease: { select: { organizationId: true, unit: { select: { type: true } } } },
      },
    })
    if (!avi) return ej('hyresavin finns inte i organisationen')
    if (avi.type !== 'RENT') return ej('avin är ingen hyresavi')
    // A-1 (KRITERIER-006-A): bara bostad (APARTMENT) är belagd momsfri bostadshyra i v1.
    const enhet = avi.lease?.organizationId === organizationId ? avi.lease.unit.type : null
    if (enhet !== 'APARTMENT') return ej(`hyra för enhetstyp ${enhet ?? 'okänd'}`)
    const beh = await harledBehandlingar(db, organizationId, entry)
    for (const l of entry.lines) {
      if (arIntaktskonto(l.account)) {
        const b = beh.get(l.id)
        if (b?.typ !== 'MOMSFRI')
          return ej(
            b?.typ === 'MOMSPLIKTIG'
              ? `momspliktig hyra ${b.sats} % (${b.kalla})`
              : `intäktsraden är obevisad (${b?.typ === 'OBEVISAD' ? b.skal : 'okänd'})`,
          )
        satt(l, 'HYRESINTAKT', 'MOMSFRI')
      } else if (
        l.account.number === 1510 &&
        l.credit === null &&
        ore(l.debit) === ore(avi.totalAmount)
      )
        satt(l, 'KUNDFORDRAN')
      else return ej(`raden på konto ${l.account.number} hör inte till en momsfri hyresavi`)
    }
    if (![...rader.values()].some((r) => r.roll === 'KUNDFORDRAN'))
      return ej('hyresavins kundfordran saknas')
    return { ok: true, handelse: 'hyresavi (bostad, momsfri)', rader, rattelseAv: null }
  }

  // ── H2 hyresbetalning ──
  if ((m = /^rent-notice-(?:bank-)?payment:(.+)$/.exec(sid)) && entry.source === 'PAYMENT') {
    const alloc = await db.rentNoticePayment.findFirst({
      where: { id: m[1]!, rentNotice: { organizationId } },
      select: {
        amount: true,
        rentNotice: { select: { id: true, type: true, origin: true, openingRowId: true } },
      },
    })
    if (!alloc) return ej('betalningen saknar allokering till en hyresavi i organisationen')
    const t = tvaRader(entry, arLikvid, (n) => n === 1510)
    if (!t) return ej('betalningen är inte en ren inbetalning 19xx/1510')
    if (t.belopp !== ore(alloc.amount)) return ej('beloppet motsvarar inte allokeringen')
    const avi = alloc.rentNotice
    if (avi.type === 'DEPOSIT') {
      // TESTKUND-027 c2: bankmatchad (eller manuell) betalning av en DEPOSITIONSAVI. Klassas som
      // deposition bara om avin har en Deposit i organisationen; ursprunget är depositionsfakturan.
      const dep = await db.deposit.findFirst({
        where: { rentNoticeId: avi.id, organizationId },
        select: { id: true, origin: true, openingRowId: true },
      })
      if (!dep) return ej('depositionsavin saknar deposition i organisationen')
      const ok =
        dep.origin === 'OPENING_PACKAGE'
          ? await iVerkstalltPaket(db, organizationId, dep.openingRowId)
          : await bekraftad(
              db,
              organizationId,
              'INVOICE',
              `deposit-invoice:${dep.id}`,
              databaseNumber,
            )
      if (!ok)
        return ursprung(
          'Depositionsfakturan är inte bekräftat exporterad till samma Fortnox-företag (eller ' +
            'ingår inte i ett verkställt öppningspaket) — betalningen skulle kreditera kundfordringar utan debet',
        )
      satt(t.deb, 'LIKVID')
      satt(t.kre, 'KUNDFORDRAN')
      return {
        ok: true,
        handelse: `depositionsbetalning (${/^rent-notice-bank-/.test(sid) ? 'bank' : 'manuell'}, avi)`,
        rader,
        rattelseAv: null,
      }
    }
    if (avi.type !== 'RENT') return ej(`betalning av avityp ${avi.type}`)
    if (avi.origin === 'OPENING_PACKAGE') {
      if (!(await iVerkstalltPaket(db, organizationId, avi.openingRowId)))
        return ursprung('Fordran ingår inte i ett verkställt öppningspaket')
    } else if (
      !(await bekraftad(db, organizationId, 'INVOICE', `rent-notice:${avi.id}`, databaseNumber))
    )
      return ursprung(
        'Hyresavins fordran är inte bekräftat exporterad till samma Fortnox-företag — ' +
          'betalningen skulle kreditera kundfordringar utan motsvarande debet',
      )
    satt(t.deb, 'LIKVID')
    satt(t.kre, 'KUNDFORDRAN')
    return { ok: true, handelse: 'hyresbetalning', rader, rattelseAv: null }
  }

  // ── H3 deposition ──
  if ((m = /^deposit-(invoice|manual-payment|refund):(.+)$/.exec(sid))) {
    const [, slag, depId] = m
    const dep = await db.deposit.findFirst({
      where: { id: depId!, organizationId },
      select: {
        id: true,
        amount: true,
        origin: true,
        openingRowId: true,
        invoiceId: true,
        rentNoticeId: true,
      },
    })
    if (!dep) return ej('depositionen finns inte i organisationen')
    if (slag === 'invoice') {
      if (entry.source !== 'INVOICE') return ej('okänd källa för depositionsfaktura')
      const t = tvaRader(
        entry,
        (n) => n === 1510,
        (n) => n === 2890,
      )
      if (!t || t.belopp !== ore(dep.amount))
        return ej('depositionsfakturan är inte 1510/2890 med depositionens belopp')
      satt(t.deb, 'KUNDFORDRAN')
      satt(t.kre, 'DEPOSITIONSSKULD')
      return { ok: true, handelse: 'depositionsfaktura', rader, rattelseAv: null }
    }
    const fakturaOk =
      dep.origin === 'OPENING_PACKAGE'
        ? await iVerkstalltPaket(db, organizationId, dep.openingRowId)
        : await bekraftad(
            db,
            organizationId,
            'INVOICE',
            `deposit-invoice:${dep.id}`,
            databaseNumber,
          )
    if (slag === 'manual-payment') {
      if (entry.source !== 'PAYMENT') return ej('okänd källa för depositionsbetalning')
      const t = tvaRader(entry, arLikvid, (n) => n === 1510)
      if (!t) return ej('depositionsbetalningen är inte en ren inbetalning 19xx/1510')
      if (!fakturaOk)
        return ursprung(
          'Depositionsfakturan är inte bekräftat exporterad till samma Fortnox-företag (eller ' +
            'ingår inte i ett verkställt öppningspaket) — betalningen skulle kreditera kundfordringar utan debet',
        )
      satt(t.deb, 'LIKVID')
      satt(t.kre, 'KUNDFORDRAN')
      return { ok: true, handelse: 'depositionsbetalning', rader, rattelseAv: null }
    }
    if (entry.source !== 'PAYMENT') return ej('okänd källa för depositionsåterbetalning')
    const t = tvaRader(entry, (n) => n === 2890, arLikvid)
    if (!t) return ej('återbetalning med avdrag eller annan form än 2890/19xx')
    if (!fakturaOk)
      return ursprung(
        'Depositionsskulden är inte bekräftat exporterad till samma Fortnox-företag (eller ingår ' +
          'inte i ett verkställt öppningspaket)',
      )
    // TESTKUND-027 D1 (F-015-1): också MOTTAGNINGEN ska vara bekräftat exporterad — annars minskar
    // banken i Fortnox utan motsvarande inbetalning. Ett verkställt öppningspaket bär redan både
    // skulden och mottagningen (IB) och behandlas som tidigare.
    if (dep.origin !== 'OPENING_PACKAGE') {
      const mt = await mottagningar(db, organizationId, dep, databaseNumber)
      if (!mt.ok) return ursprung(mt.skal)
      if (t.belopp > mt.summa)
        return ursprung(
          `Återbetalningen ${(t.belopp / 100).toFixed(2)} kr överstiger bekräftat mottaget ${(mt.summa / 100).toFixed(2)} kr`,
        )
    }
    satt(t.deb, 'DEPOSITIONSSKULD')
    satt(t.kre, 'LIKVID')
    return { ok: true, handelse: 'depositionsåterbetalning', rader, rattelseAv: null }
  }

  // ── TESTKUND-027 c1/c3: betalning av en DEPOSITIONSFAKTURA (manuell eller bankmatchad) ──
  if ((m = /^invoice-(manual|bank)-payment:(.+)$/.exec(sid)) && entry.source === 'PAYMENT') {
    const [, vag, allocId] = m
    const alloc = await db.invoicePayment.findFirst({
      where: { id: allocId!, invoice: { organizationId } },
      select: { amount: true, invoice: { select: { id: true, type: true } } },
    })
    if (!alloc) return ej('betalningen saknar allokering till en faktura i organisationen')
    // B2.2: en vanlig faktura klassas aldrig som deposition (stöds inte i denna version).
    if (alloc.invoice.type !== 'DEPOSIT')
      return ej(`betalning av faktura av typ ${alloc.invoice.type}`)
    const dep = await db.deposit.findFirst({
      where: { invoiceId: alloc.invoice.id, organizationId },
      select: { id: true, origin: true, openingRowId: true },
    })
    if (!dep) return ej('depositionsfakturan saknar deposition i organisationen')
    const t = tvaRader(entry, arLikvid, (n) => n === 1510)
    if (!t) return ej('betalningen är inte en ren inbetalning 19xx/1510')
    if (t.belopp !== ore(alloc.amount)) return ej('beloppet motsvarar inte allokeringen')
    const ok =
      dep.origin === 'OPENING_PACKAGE'
        ? await iVerkstalltPaket(db, organizationId, dep.openingRowId)
        : await bekraftad(
            db,
            organizationId,
            'INVOICE',
            `deposit-invoice:${dep.id}`,
            databaseNumber,
          )
    if (!ok)
      return ursprung(
        'Depositionsfakturan är inte bekräftat exporterad till samma Fortnox-företag (eller ' +
          'ingår inte i ett verkställt öppningspaket) — betalningen skulle kreditera kundfordringar utan debet',
      )
    satt(t.deb, 'LIKVID')
    satt(t.kre, 'KUNDFORDRAN')
    return {
      ok: true,
      handelse: `depositionsbetalning (${vag === 'bank' ? 'bank' : 'manuell'}, faktura)`,
      rader,
      rattelseAv: null,
    }
  }

  // ── TESTKUND-027 L3: makulering av leverantörsfaktura = rättelse av originalet ──
  if ((m = /^supplier-invoice-cancel:(.+)$/.exec(sid)) && entry.source === 'SUPPLIER_INVOICE') {
    const f = await db.supplierInvoice.findFirst({
      where: { id: m[1]!, organizationId },
      select: { id: true, cancelledAt: true },
    })
    // Makuleringsverifikatet skapas bara av produktens cancel (som sätter cancelledAt i samma
    // transaktion); verifikatet självt är beviset för att fakturan är makulerad.
    if (!f) return ej('leverantörsfakturan finns inte i organisationen')
    const orig = await db.journalEntry.findFirst({
      where: { organizationId, source: 'SUPPLIER_INVOICE', sourceId: `supplier-invoice:${f.id}` },
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
    if (!orig) return ej('leverantörsfakturans originalverifikat saknas')
    const fryst = await frystKlass(db, organizationId, orig.id, databaseNumber)
    const k = fryst
      ? ({ ok: true, ...fryst, rattelseAv: null } as const)
      : await klassaVerifikat(db, organizationId, orig, databaseNumber, djup + 1)
    if (!k.ok) return k.kod === 'EVENT_UNSUPPORTED' ? ej(`makulering av: ${k.skal}`) : k
    const u = await originalUtfall(db, organizationId, orig.id, databaseNumber)
    if (u.typ !== 'CONFIRMED')
      return ursprung(
        u.typ === 'OKANT'
          ? `Originalets ${u.text}; makuleringen exporteras inte förrän originalets utfall är bekräftat`
          : `Leverantörsfakturan är ${u.text} — makuleringen skulle återföra en post som inte finns i Fortnox`,
      )
    const fel = omvandaRader(rader, entry.lines, orig.lines, k.rader)
    if (fel) return ej(`makuleringen: ${fel}`)
    return { ok: true, handelse: 'makulering av leverantörsfaktura', rader, rattelseAv: orig.id }
  }

  // ── H4 leverantörsfaktura ──
  if ((m = /^supplier-invoice(-payment)?:(.+)$/.exec(sid)) && entry.source === 'SUPPLIER_INVOICE') {
    const [, betalning, fid] = m
    const f = await db.supplierInvoice.findFirst({
      where: { id: fid!, organizationId },
      select: {
        id: true,
        expenseAccount: true,
        netAmount: true,
        vatAmount: true,
        totalAmount: true,
        cancelledAt: true,
      },
    })
    if (!f) return ej('leverantörsfakturan finns inte i organisationen')
    if (!betalning && djup === 0) {
      const mak = await db.journalEntry.findFirst({
        where: {
          organizationId,
          source: 'SUPPLIER_INVOICE',
          sourceId: `supplier-invoice-cancel:${f.id}`,
        },
        select: { id: true },
      })
      if (f.cancelledAt || mak)
        return {
          ok: false,
          kod: 'REVERSED_BEFORE_EXPORT',
          skal:
            'Leverantörsfakturan makulerades innan den exporterades — varken fakturan eller makuleringen ' +
            'skickas till Fortnox; de tar ut varandra i Eveno',
        }
    }
    if (betalning) {
      const t = tvaRader(entry, (n) => n === 2440, arLikvid)
      if (!t || t.belopp !== ore(f.totalAmount))
        return ej('leverantörsbetalningen är inte 2440/19xx med fakturans belopp')
      if (
        !(await bekraftad(
          db,
          organizationId,
          'SUPPLIER_INVOICE',
          `supplier-invoice:${f.id}`,
          databaseNumber,
        ))
      )
        return ursprung(
          'Leverantörsfakturan är inte bekräftat exporterad till samma Fortnox-företag — ' +
            'betalningen skulle debitera leverantörsskulder utan motsvarande kredit',
        )
      satt(t.deb, 'LEVERANTORSSKULD')
      satt(t.kre, 'LIKVID')
      return { ok: true, handelse: 'leverantörsbetalning', rader, rattelseAv: null }
    }
    for (const l of entry.lines) {
      const n = l.account.number
      if (
        n === f.expenseAccount &&
        iKontoklass('KOSTNAD', n) &&
        l.credit === null &&
        ore(l.debit) === ore(f.netAmount)
      )
        satt(l, 'KOSTNAD')
      else if (
        n === 2641 &&
        l.credit === null &&
        ore(l.debit) === ore(f.vatAmount) &&
        ore(f.vatAmount) > 0
      )
        satt(l, 'INGAENDE_MOMS', 'AVDRAGSGILL')
      else if (n === 2440 && l.debit === null && ore(l.credit) === ore(f.totalAmount))
        satt(l, 'LEVERANTORSSKULD')
      else return ej(`raden på konto ${n} motsvarar inte leverantörsfakturan`)
    }
    if (rader.size !== entry.lines.length || ![...rader.values()].some((r) => r.roll === 'KOSTNAD'))
      return ej('leverantörsfakturans rader är ofullständiga')
    return { ok: true, handelse: 'leverantörsfaktura', rader, rattelseAv: null }
  }

  return ej(
    entry.source === 'MANUAL'
      ? 'manuellt verifikat'
      : entry.source === 'AI'
        ? 'verifikat skapat av AI'
        : `källa ${entry.source}${sid ? ` (${sid.split(':')[0]})` : ''}`,
  )
}
