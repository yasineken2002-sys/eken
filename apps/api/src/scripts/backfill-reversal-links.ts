/**
 * BACKFILL AV `JournalEntry.reversalOfEntryId` FÖR HISTORISKA MOTVERIFIKAT.
 *
 * Sedan reverseringssymmetrin rättades sätter `createReversalEntry` kolumnen för
 * ALLA vägar, och `@unique` på den gör att ett verifikat kan reverseras exakt en
 * gång oavsett vilken väg som tar det. Poster som skrevs FÖRE den ändringen
 * saknar länken, och skyddet gäller därför inte dem.
 *
 * ── NAMNRYMDEN FÖRESLÅR, SPEGLINGEN AVGÖR ───────────────────────────────────
 *
 * Att härleda paret ur `sourceId` (`rent-notice-reversal:X` → `rent-notice:X`)
 * är bekvämt och otillräckligt. Mappningen är en uppräkning av åtta former, och
 * en uppräkning har redan visat sig bräcklig en gång i det här arbetet: en
 * felaktig teckenoffset i en mätfråga gjorde att en join aldrig kunde matcha,
 * och svaret hade blivit noll oavsett vad databasen innehöll.
 *
 * Därför är namnrymden bara ett FÖRSLAG. Ett par godkänns enbart om
 * motverifikatets rader är originalets exakta spegel:
 *
 *   • samma konton, inga fler och inga färre
 *   • per konto: originalets debet = reverseringens kredit, och tvärtom
 *   • båda posterna summerar till noll
 *
 * En kandidat som inte speglar avvisas, hur bra `sourceId` än matchar. Det är
 * det som gör mappningen MÄTT i stället för gissad — och det är en kontroll som
 * inte kan bli grön av att någon skrev rätt sträng.
 *
 * ── KÖRNING ─────────────────────────────────────────────────────────────────
 *
 *   pnpm --filter @eken/api backfill:reversal-links              # torrkörning
 *   pnpm --filter @eken/api backfill:reversal-links -- --apply   # skriver
 *
 * Torrkörning är DEFAULT och skriver ingenting. Utdatan bär id:n och
 * verifikationsnummer — aldrig belopp och aldrig motparter, eftersom den
 * hamnar i sessionsloggar och CI-utskrifter.
 *
 * ── IDEMPOTENS ──────────────────────────────────────────────────────────────
 *
 * Poster som redan har `reversalOfEntryId` plockas inte ens upp som kandidater,
 * och skrivningen vägrar dessutom om målet hunnit få en länk under körningen.
 * En andra körning är alltså en no-op, inte ett fel.
 */

import { PrismaClient, Prisma } from '@prisma/client'

/** Ett verifikats rader, i den form spegelkontrollen behöver dem. */
export interface Rader {
  accountId: string
  debit: Prisma.Decimal | null
  credit: Prisma.Decimal | null
}

/**
 * ── HÄRLEDNINGEN: motverifikatets `sourceId` → originalets ───────────────────
 *
 * Returnerar `null` för former vi inte känner igen — och det är rätt utfall:
 * en okänd namnrymd ska rapporteras som ohanterad, aldrig gissas.
 *
 * `entry-reversal:` ingår INTE. Den vägen har alltid satt `reversalOfEntryId`
 * och har därför inga historiska poster att laga; dyker en upp utan länk är det
 * något annat som är fel och ska undersökas, inte backfillas.
 */
export function härledOriginalSourceId(reversalSourceId: string): string | null {
  // `reversal:<sourceId>` — betalningsreverseringen. Prövas FÖRST: varje annan
  // form innehåller också ordet, så en bredare match hade svalt dem.
  if (reversalSourceId.startsWith('reversal:')) {
    return reversalSourceId.slice('reversal:'.length) || null
  }
  const m = /^([a-z][a-z-]*)-reversal:(.+)$/.exec(reversalSourceId)
  if (!m) return null
  const [, prefix, rest] = m
  if (prefix === 'entry') return null

  // ── FAKTURAN ÄR UNDANTAGET, OCH DET ÄR MÄTT ───────────────────────────────
  //
  // Alla andra vägar skriver originalet med sitt namnrymdsprefix
  // (`rent-notice:X`, `misc-charge:X` …). Fakturans accrual bär BARA
  // fakturans id — `reverseJournalEntryForInvoice` slår upp
  // `{ source: 'INVOICE', sourceId: invoiceId }`. Uppmätt i dev: 127 poster med
  // ett sourceId som är ett rent uuid utan prefix.
  //
  // Den här raden fanns INTE i första versionen, och regeln hade då mappat
  // `invoice-reversal:X` till `invoice:X` — en nyckel som inte finns. Felet
  // upptäcktes inte av enhetstestet (jag hade skrivit in samma felaktiga
  // förväntan där) utan av TORRKÖRNINGEN, som rapporterade paret som
  // `original-saknas` i stället för att länka fel. Det är precis vad
  // spegelkontrollen och den här utfallsklassen finns till för: en härledning
  // som är fel ska ge INGEN länk, aldrig en felaktig.
  if (prefix === 'invoice') return rest ?? null

  return `${prefix}:${rest}`
}

/** Summan av en posts rader. Ett verifikat som inte summerar till noll speglar ingenting. */
function nettosumma(rader: Rader[]): Prisma.Decimal {
  return rader.reduce<Prisma.Decimal>(
    (s, r) => s.plus(r.debit ?? 0).minus(r.credit ?? 0),
    new Prisma.Decimal(0),
  )
}

/**
 * ÄR `reversering` en exakt spegel av `original`?
 *
 * DET HÄR ÄR ACCEPTANSKRITERIET, inte en extra kontroll ovanpå namnmatchningen.
 * Två poster som råkar dela namnrymd men inte speglar varandra är inte ett par,
 * och att länka dem hade skrivit in en osanning i huvudboken som `@unique`
 * sedan hade cementerat.
 *
 * Jämförelsen sker PER KONTO och aggregerat, så flera rader mot samma konto
 * hanteras. Beloppen jämförs i Decimal — aldrig genom float.
 */
export function speglar(original: Rader[], reversering: Rader[]): boolean {
  if (original.length === 0 || reversering.length === 0) return false
  if (!nettosumma(original).isZero() || !nettosumma(reversering).isZero()) return false

  const per = (rader: Rader[]) => {
    const karta = new Map<string, { debit: Prisma.Decimal; credit: Prisma.Decimal }>()
    for (const r of rader) {
      const post = karta.get(r.accountId) ?? {
        debit: new Prisma.Decimal(0),
        credit: new Prisma.Decimal(0),
      }
      post.debit = post.debit.plus(r.debit ?? 0)
      post.credit = post.credit.plus(r.credit ?? 0)
      karta.set(r.accountId, post)
    }
    return karta
  }

  const o = per(original)
  const v = per(reversering)
  // Samma konton, inga fler och inga färre.
  if (o.size !== v.size) return false
  for (const [konto, ob] of o) {
    const vb = v.get(konto)
    if (!vb) return false
    // Omvänt tecken: originalets debet är reverseringens kredit.
    if (!ob.debit.equals(vb.credit)) return false
    if (!ob.credit.equals(vb.debit)) return false
  }
  // Ett verifikat med bara nollrader speglar formellt allt — avvisa det.
  return [...o.values()].some((b) => !b.debit.isZero() || !b.credit.isZero())
}

export type Utfall = 'speglar' | 'speglar-inte' | 'original-saknas' | 'okand-namnrymd'

export interface Forslag {
  reverseringId: string
  reverseringVer: string
  originalId: string | null
  originalVer: string | null
  utfall: Utfall
}

interface Post {
  id: string
  organizationId: string
  series: string | null
  verNumber: number | null
  source: string
  sourceId: string | null
  reversalOfEntryId: string | null
  lines: Rader[]
}

const ver = (p: { series: string | null; verNumber: number | null }) =>
  p.series != null && p.verNumber != null ? `${p.series}${p.verNumber}` : '(onumrerad)'

/**
 * Bygger förslagen. REN funktion över redan lästa poster, så den kan prövas utan
 * databas — inklusive med par som medvetet inte speglar varandra.
 */
export function byggForslag(poster: Post[]): Forslag[] {
  const perOrg = new Map<string, Map<string, Post>>()
  for (const p of poster) {
    if (!p.sourceId) continue
    const karta = perOrg.get(p.organizationId) ?? new Map<string, Post>()
    karta.set(p.sourceId, p)
    perOrg.set(p.organizationId, karta)
  }

  const ut: Forslag[] = []
  for (const p of poster) {
    if (!p.sourceId) continue
    if (p.reversalOfEntryId) continue // redan länkad — idempotensen
    const nyckel = härledOriginalSourceId(p.sourceId)
    if (nyckel === null) continue // inte ett motverifikat vi hanterar

    const original = perOrg.get(p.organizationId)?.get(nyckel)
    if (!original) {
      ut.push({
        reverseringId: p.id,
        reverseringVer: ver(p),
        originalId: null,
        originalVer: null,
        utfall: 'original-saknas',
      })
      continue
    }
    ut.push({
      reverseringId: p.id,
      reverseringVer: ver(p),
      originalId: original.id,
      originalVer: ver(original),
      utfall: speglar(original.lines, p.lines) ? 'speglar' : 'speglar-inte',
    })
  }
  return ut
}

/* ── Körningen ─────────────────────────────────────────────────────────────── */

async function main() {
  const apply = process.argv.includes('--apply')

  // ── ANSLUTNINGEN LÄSES UR MILJÖN, ALDRIG UR KOMMANDORADEN ─────────────────
  //
  // Mot prod går vägen via Railways publika proxy, som ligger i
  // `DATABASE_PUBLIC_URL` (den interna `postgres.railway.internal` är inte
  // nåbar utifrån). Den läses HÄR ur miljön i stället för att skickas som
  // argument: en connection string på kommandoraden hamnar i skalhistorik och i
  // sessionsloggar, och den bär lösenordet. Värdet skrivs aldrig ut.
  const url = process.env['DATABASE_PUBLIC_URL'] ?? process.env['DATABASE_URL']
  if (!url) {
    throw new Error('Varken DATABASE_PUBLIC_URL eller DATABASE_URL är satt')
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } })

  try {
    const poster = (await prisma.journalEntry.findMany({
      select: {
        id: true,
        organizationId: true,
        series: true,
        verNumber: true,
        source: true,
        sourceId: true,
        reversalOfEntryId: true,
        lines: { select: { accountId: true, debit: true, credit: true } },
      },
    })) as unknown as Post[]

    const forslag = byggForslag(poster)
    const godkanda = forslag.filter((f) => f.utfall === 'speglar')

    // ── TYSTNAD FÅR INTE SE UT SOM "INGET ATT GÖRA" ────────────────────────
    //
    // `entry-reversal:` hoppas över av härledningen, på antagandet att den
    // manuella vägen alltid satt länken. Uppmätt i dev stämmer det INTE: tre
    // sådana poster saknar den. De ska därför rapporteras, inte försvinna —
    // men de backfillas inte, eftersom orsaken är okänd och en gissning här
    // vore samma fel som namnrymdsmappningen redan gjort en gång.
    const manuellaUtanLank = poster.filter(
      (p) => p.sourceId?.startsWith('entry-reversal:') && !p.reversalOfEntryId,
    )

    console.warn(`[backfill] verifikat totalt: ${poster.length}`)
    console.warn(`[backfill] motverifikat utan länk: ${forslag.length}`)
    console.warn('')
    console.warn('reversering            original               speglar')
    console.warn('---------------------  ---------------------  -------')
    for (const f of forslag) {
      const v = f.utfall === 'speglar' ? 'JA' : f.utfall === 'speglar-inte' ? 'NEJ' : f.utfall
      console.warn(
        `${f.reverseringVer.padEnd(6)} ${f.reverseringId.slice(0, 14).padEnd(15)}` +
          `${(f.originalVer ?? '-').padEnd(6)} ${(f.originalId ?? '-').slice(0, 14).padEnd(15)}${v}`,
      )
    }
    console.warn('')
    console.warn(
      `[backfill] godkända: ${godkanda.length}` +
        `  avvisade (speglar ej): ${forslag.filter((f) => f.utfall === 'speglar-inte').length}` +
        `  original saknas: ${forslag.filter((f) => f.utfall === 'original-saknas').length}`,
    )

    if (manuellaUtanLank.length > 0) {
      console.warn('')
      console.warn(
        `[backfill] OBS: ${manuellaUtanLank.length} manuell(a) rättelse(r) (entry-reversal:) ` +
          'saknar också länk. De backfillas INTE härifrån — den vägen har alltid satt ' +
          'kolumnen, så en post utan den har en okänd orsak som ska undersökas:',
      )
      for (const p of manuellaUtanLank) console.warn(`  ${ver(p)}  ${p.id}`)
    }

    if (!apply) {
      console.warn('[backfill] TORRKÖRNING — ingenting skrevs. Kör med --apply för att skriva.')
      return
    }
    if (godkanda.length === 0) {
      console.warn('[backfill] inget att skriva.')
      return
    }

    // ALLT ELLER INGET. En halv backfill är svårare att resonera om än ingen.
    const skrivna = await prisma.$transaction(async (tx) => {
      let n = 0
      for (const f of godkanda) {
        // Vägra om målet hunnit få en länk. `updateMany` med villkoret i WHERE
        // gör kontrollen till en del av skrivningen i stället för en läsning
        // före den — annars finns ett fönster emellan.
        const res = await tx.journalEntry.updateMany({
          where: { id: f.reverseringId, reversalOfEntryId: null },
          data: { reversalOfEntryId: f.originalId },
        })
        n += res.count
      }
      return n
    })
    console.warn(`[backfill] skrev ${skrivna} länkar (av ${godkanda.length} godkända).`)
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[backfill] FEL:', e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  })
}
