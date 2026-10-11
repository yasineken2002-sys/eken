/**
 * KUNDSTART-001 §2 + §11 + §12: entydig koppling av öppningspaketets rader till Evenos
 * hyresgäster och avtal, samt konfliktkontroller. Körs vid validering OCH igen i
 * verkställningens transaktion (inaktuellt snapshot får inte verkställas).
 *
 * Ingen gissning: okänd, tvetydig eller motstridig koppling ger radfel.
 *  - Hyresgäst: OCR-nummer (siffror) eller e-post (exakt, skiftlägesokänsligt).
 *  - Avtal: avtalsnummer, eller fastighet (namn eller gatuadress) + enhetsnummer. Anges
 *    båda måste de peka på samma avtal.
 *  - Avtalet ska tillhöra hyresgästen. TERMINATED/EXPIRED är giltiga (A3), DRAFT inte.
 *  - FORDRAN: perioden ligger före brytdatum och inom avtalets löptid; ingen befintlig
 *    avi för (avtal, period, RENT); inte dubbel i paketet.
 *  - DEPOSITION: mottagen före brytdatum; avtalet har ingen Deposit; inte dubbel i paketet.
 *  - Källrad (sourceId) får inte redan vara verkställd i organisationen (K-B4).
 */
import type { OpeningPackageRow, Prisma } from '@prisma/client'
import { periodForeBrytdatum, brytdatumIso } from './cutover'

export interface Losning {
  rowId: string
  tenantId: string | null
  leaseId: string | null
  propertyId: string | null
  errors: string[]
}

type Rad = Pick<
  OpeningPackageRow,
  | 'id'
  | 'rowNo'
  | 'sourceId'
  | 'kind'
  | 'tenantRef'
  | 'leaseRef'
  | 'propertyRef'
  | 'unitRef'
  | 'periodYear'
  | 'periodMonth'
  | 'dueDate'
  | 'receivedDate'
  | 'errors'
>

const ym = (d: Date) => ({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 })
const fore = (a: { y: number; m: number }, b: { y: number; m: number }) =>
  a.y < b.y || (a.y === b.y && a.m < b.m)

export async function losRader(
  db: Prisma.TransactionClient,
  organizationId: string,
  cutover: Date,
  rader: Rad[],
): Promise<Losning[]> {
  const ut: Losning[] = []
  const settPeriod = new Map<string, number>()
  const settDeposition = new Map<string, number>()
  const verkstallda = new Set(
    (
      await db.openingExecutedSource.findMany({
        where: { organizationId, sourceId: { in: rader.map((r) => r.sourceId) } },
        select: { sourceId: true },
      })
    ).map((x) => x.sourceId),
  )

  for (const rad of rader) {
    // Tolkningsfel från filen följer med; de kan inte lösas här.
    const errors: string[] = Array.isArray(rad.errors)
      ? (rad.errors as unknown[]).filter(
          (e): e is string => typeof e === 'string' && e.startsWith('fil: '),
        )
      : []
    let tenantId: string | null = null
    let leaseId: string | null = null
    let propertyId: string | null = null

    if (verkstallda.has(rad.sourceId))
      errors.push(
        `Källraden ${rad.sourceId} är redan verkställd i ett tidigare öppningspaket — den kan inte verkställas igen.`,
      )

    // ── Hyresgäst ──
    const ref = rad.tenantRef.trim()
    if (ref) {
      const kandidater = /^\d+$/.test(ref)
        ? await db.tenant.findMany({
            where: { organizationId, ocrNumber: ref },
            select: { id: true, anonymizedAt: true },
          })
        : ref.includes('@')
          ? await db.tenant.findMany({
              where: { organizationId, email: { equals: ref, mode: 'insensitive' } },
              select: { id: true, anonymizedAt: true },
            })
          : null
      if (kandidater === null)
        errors.push(`Hyresgästreferensen "${ref}" är varken OCR eller e-post.`)
      else if (kandidater.length === 0) errors.push(`Okänd hyresgäst "${ref}".`)
      else if (kandidater.length > 1)
        errors.push(`Tvetydig hyresgäst "${ref}" (${kandidater.length} träffar).`)
      else if (kandidater[0]!.anonymizedAt) errors.push(`Hyresgästen "${ref}" är anonymiserad.`)
      else tenantId = kandidater[0]!.id
    }

    // ── Avtal ──
    const leaseSelect = {
      id: true,
      tenantId: true,
      status: true,
      startDate: true,
      endDate: true,
      unitId: true,
      unit: { select: { propertyId: true } },
    } as const
    type L = Prisma.LeaseGetPayload<{ select: typeof leaseSelect }>
    let viaNummer: L | null = null
    if (rad.leaseRef) {
      viaNummer = await db.lease.findFirst({
        where: { organizationId, contractNumber: rad.leaseRef },
        select: leaseSelect,
      })
      if (!viaNummer) errors.push(`Okänt avtalsnummer "${rad.leaseRef}".`)
    }
    let viaEnhet: L[] | null = null
    if (rad.propertyRef || rad.unitRef) {
      if (!rad.propertyRef || !rad.unitRef)
        errors.push('Fastighet och enhet måste anges tillsammans.')
      else {
        const units = await db.unit.findMany({
          where: {
            unitNumber: rad.unitRef,
            property: {
              organizationId,
              OR: [{ name: rad.propertyRef }, { street: rad.propertyRef }],
            },
          },
          select: { id: true },
        })
        if (units.length === 0) errors.push(`Okänd enhet "${rad.propertyRef} / ${rad.unitRef}".`)
        else if (units.length > 1)
          errors.push(
            `Tvetydig enhet "${rad.propertyRef} / ${rad.unitRef}" (${units.length} träffar).`,
          )
        else if (tenantId)
          viaEnhet = await db.lease.findMany({
            where: { organizationId, unitId: units[0]!.id, tenantId },
            select: leaseSelect,
          })
      }
    }
    if (!rad.leaseRef && !(rad.propertyRef && rad.unitRef))
      errors.push('Avtal saknas: ange avtalsnummer eller fastighet + enhet.')

    let lease: L | null = null
    if (viaNummer && viaEnhet !== null) {
      if (!viaEnhet.some((l) => l.id === viaNummer!.id))
        errors.push('Avtalsnummer och fastighet/enhet pekar på olika avtal (motstridig koppling).')
      else lease = viaNummer
    } else if (viaNummer) lease = viaNummer
    else if (viaEnhet !== null) {
      let k = viaEnhet
      if (rad.kind === 'RECEIVABLE' && rad.periodYear && rad.periodMonth) {
        const p = { y: rad.periodYear, m: rad.periodMonth }
        k = k.filter((l) => !fore(p, ym(l.startDate)) && !(l.endDate && fore(ym(l.endDate), p)))
      }
      if (k.length === 0) errors.push('Hyresgästen har inget avtal på enheten som täcker raden.')
      else if (k.length > 1)
        errors.push(`Tvetydigt avtal på enheten (${k.length} avtal) — ange avtalsnummer.`)
      else lease = k[0]!
    }

    if (lease) {
      if (tenantId && lease.tenantId !== tenantId)
        errors.push('Avtalet tillhör en annan hyresgäst (motstridig koppling).')
      else if (lease.status === 'DRAFT')
        errors.push(
          'Avtalet är ett utkast (DRAFT) och kan inte bära historisk skuld eller deposition.',
        )
      else {
        leaseId = lease.id
        propertyId = lease.unit.propertyId
      }
    }

    // ── Typspecifikt ──
    const b = brytdatumIso(cutover)
    if (rad.kind === 'RECEIVABLE' && rad.periodYear && rad.periodMonth) {
      const p = { y: rad.periodYear, m: rad.periodMonth }
      if (!periodForeBrytdatum(cutover, p.y, p.m))
        errors.push(
          `Perioden ${p.y}-${String(p.m).padStart(2, '0')} ligger inte före brytdatum ${b}.`,
        )
      if (lease && leaseId) {
        if (fore(p, ym(lease.startDate)) || (lease.endDate && fore(ym(lease.endDate), p)))
          errors.push('Perioden ligger utanför avtalets löptid.')
        const finns = await db.rentNotice.findFirst({
          where: { leaseId, year: p.y, month: p.m, type: 'RENT' },
          select: { noticeNumber: true },
        })
        if (finns) errors.push(`Avtalet har redan en avi för perioden (${finns.noticeNumber}).`)
        const nyckel = `${leaseId}|${p.y}|${p.m}`
        if (settPeriod.has(nyckel))
          errors.push(`Samma avtal och period förekommer också på rad ${settPeriod.get(nyckel)}.`)
        else settPeriod.set(nyckel, rad.rowNo)
      }
    }
    if (rad.kind === 'DEPOSIT') {
      if (rad.receivedDate && rad.receivedDate >= cutover)
        errors.push(
          `Depositionen är mottagen på eller efter brytdatum ${b} — den hör inte till öppningen.`,
        )
      if (leaseId) {
        const dep = await db.deposit.findUnique({ where: { leaseId }, select: { id: true } })
        if (dep) errors.push('Avtalet har redan en deposition i Eveno.')
        if (settDeposition.has(leaseId))
          errors.push(`Samma avtal har också en deposition på rad ${settDeposition.get(leaseId)}.`)
        else settDeposition.set(leaseId, rad.rowNo)
      }
    }

    ut.push({ rowId: rad.id, tenantId, leaseId, propertyId, errors })
  }
  return ut
}
