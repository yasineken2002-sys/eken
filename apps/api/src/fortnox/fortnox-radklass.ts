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
 * URSPRUNG (V3/K8.2): en betalning, en depositionsbetalning/-återbetalning och en leverantörs-
 * betalning exporteras bara när fordrans/skuldens ursprungsverifikat är CONFIRMED i SAMMA
 * Fortnox-företag, eller när fordran/depositionen uttryckligen ingår i ett VERKSTÄLLT öppningspaket
 * (redan IB i Fortnox). UNKNOWN, REJECTED, DRY_RUN_READY och "datum före brytdatum" räcker inte.
 * Samma regel i test- och kundvägen.
 */
import type { Prisma } from '@prisma/client'
import { arIntaktskonto, harledBehandlingar } from './fortnox-intaktsgrind'
import { iKontoklass, type Momsbehandling, type Roll } from './fortnox-kontomappning'

export interface Radklass {
  roll: Roll
  behandling: Momsbehandling
}

export type Klassning =
  | { ok: true; handelse: string; rader: Map<string, Radklass>; rattelseAv: string | null }
  | { ok: false; kod: 'EVENT_UNSUPPORTED' | 'ORIGIN_NOT_CONFIRMED'; skal: string }

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
    const k = await klassaVerifikat(db, organizationId, orig, databaseNumber, djup + 1)
    if (!k.ok) return k.kod === 'EVENT_UNSUPPORTED' ? ej(`rättelse av: ${k.skal}`) : k
    const anvanda = new Set<string>()
    for (const l of entry.lines) {
      const motsv = orig.lines.find(
        (o) =>
          !anvanda.has(o.id) &&
          o.account.number === l.account.number &&
          ore(o.debit) === ore(l.credit) &&
          ore(o.credit) === ore(l.debit),
      )
      const rk = motsv ? k.rader.get(motsv.id) : undefined
      if (!motsv || !rk) return ej('rättelseraden motsvarar ingen originalrad')
      anvanda.add(motsv.id)
      rader.set(l.id, rk)
    }
    if (anvanda.size !== orig.lines.length) return ej('rättelsen återför inte hela originalet')
    return { ok: true, handelse: `rättelse av ${k.handelse}`, rader, rattelseAv: orig.id }
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
    if (avi.type !== 'RENT') return ej('betalning av depositionsavi via hyresvägen')
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
      select: { id: true, amount: true, origin: true, openingRowId: true },
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
    satt(t.deb, 'DEPOSITIONSSKULD')
    satt(t.kre, 'LIKVID')
    return { ok: true, handelse: 'depositionsåterbetalning', rader, rattelseAv: null }
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
