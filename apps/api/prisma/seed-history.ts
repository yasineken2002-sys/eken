/**
 * CLI-SKAL för historikfixturen — det DESTRUKTIVA och de FASTA id:na bor här.
 *
 * ── VARFÖR UPPDELNINGEN FINNS ───────────────────────────────────────────────
 *
 * Fixturbygget ligger i `src/history/history-fixture.ts` och kan bara SKAPA.
 * Den här filen är det enda stället som RADERAR, och den ligger utanför
 * `src/` — alltså utanför prod-bundlen.
 *
 * Riktningen är avgörande: `prisma/` importerar från `src/`, aldrig tvärtom.
 * En import åt andra hållet flyttade TypeScripts härledda `rootDir` från `src/`
 * till `apps/api/`, sköt hela byggutdatan ett steg ner och gjorde att prod inte
 * startade — med grönt bygge och grön CI. Se docblocket i fixturmodulen.
 *
 * ── MILJÖGRINDEN ────────────────────────────────────────────────────────────
 *
 * `rensa()` raderar en hel organisation. Kördes den mot prod vore det
 * dataförlust, och risken är inte teoretisk: `prisma/` kopieras in i
 * runtime-imagen (Dockerfile), `node_modules` kopieras utan pruning, och
 * `ts-node` finns där. En människa med containeråtkomst kan alltså köra den.
 *
 * Därför två oberoende villkor, båda krävs:
 *
 *   1. `EKEN_SEED_CONFIRM=ja-radera-och-skapa-om` måste vara satt. En
 *      miljövariabel man måste skriva ut är ett medvetet beslut; en flagga man
 *      råkar ärva är det inte.
 *   2. `DATABASE_URL` måste peka på en LOKAL värd. En prod-URL avvisas även om
 *      punkt 1 är uppfylld — det är den som skyddar mot ett ärvt medgivande.
 *
 * Körs med:
 *   cd apps/api && EKEN_SEED_CONFIRM=ja-radera-och-skapa-om pnpm db:seed:history
 */
import { PrismaClient } from '@prisma/client'
import {
  createHistoryFixture,
  FIXTURE_AVI_LUCKA,
  FIXTURE_HORISONT,
  type HistoryFixtureIds,
} from '../src/history/history-fixture'

const modulPrisma = new PrismaClient()

/** Fasta id:n — determinismen för CLI-körningen vilar på dem. */
export const SEED_IDS: HistoryFixtureIds = {
  organizationId: '5eed0000-0000-4000-8000-000000000001',
  userId: '5eed0000-0000-4000-8000-000000000002',
  propertyId: '5eed0000-0000-4000-8000-000000000003',
  unitId: '5eed0000-0000-4000-8000-000000000004',
  tenantId: '5eed0000-0000-4000-8000-000000000005',
  leaseId: '5eed0000-0000-4000-8000-000000000006',
  meterId: '5eed0000-0000-4000-8000-000000000007',
  planId: '5eed0000-0000-4000-8000-000000000008',
}

const MEDGIVANDE = 'ja-radera-och-skapa-om'

/** Värdar som räknas som lokala. Allt annat avvisas. */
const LOKALA_VARDAR = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'db'])

export class SeedRefusedError extends Error {}

/**
 * Grinden. Kastar `SeedRefusedError` om något av villkoren brister.
 *
 * Exporterad så att den går att pröva i BÅDA riktningarna — en grind som bara
 * setts släppa igenom är inte prövad.
 */
export function assertSeedAllowed(env: NodeJS.ProcessEnv): void {
  if (env.EKEN_SEED_CONFIRM !== MEDGIVANDE) {
    throw new SeedRefusedError(
      `VÄGRAR: seeden RADERAR och återskapar organisation ${SEED_IDS.organizationId}. ` +
        `Sätt EKEN_SEED_CONFIRM=${MEDGIVANDE} för att bekräfta att det är avsikten.`,
    )
  }

  const url = env.DATABASE_URL
  if (!url) throw new SeedRefusedError('VÄGRAR: DATABASE_URL är inte satt.')

  let vard: string
  try {
    vard = new URL(url).hostname
  } catch {
    throw new SeedRefusedError('VÄGRAR: DATABASE_URL går inte att tolka som en URL.')
  }
  if (!LOKALA_VARDAR.has(vard)) {
    // Medgivandet i punkt 1 räddar inte den här: en variabel kan ärvas av en
    // container, och då är värden det enda som skiljer dev från prod.
    throw new SeedRefusedError(
      `VÄGRAR: DATABASE_URL pekar på "${vard}", som inte är en lokal värd. ` +
        'Seeden raderar data och får bara köras mot en utvecklingsdatabas.',
    )
  }
}

/** Radera allt seedat, i främmande-nyckel-ordning. Rör bara SEED_IDS. */
async function rensa(prisma: PrismaClient): Promise<void> {
  const org = await prisma.organization.findUnique({ where: { id: SEED_IDS.organizationId } })
  if (!org) return
  const w = { organizationId: SEED_IDS.organizationId }
  await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: w } })
  await prisma.rentNoticeLine.deleteMany({ where: { rentNotice: w } })
  await prisma.rentNotice.deleteMany({ where: w })
  await prisma.consumptionCharge.deleteMany({ where: w })
  await prisma.meterReading.deleteMany({ where: w })
  await prisma.meter.deleteMany({ where: w })
  await prisma.inspectionItem.deleteMany({ where: { inspection: w } })
  await prisma.inspection.deleteMany({ where: w })
  await prisma.maintenanceTicket.deleteMany({ where: w })
  await prisma.maintenancePlan.deleteMany({ where: w })
  await prisma.keyHandover.deleteMany({ where: w })
  await prisma.deposit.deleteMany({ where: w })
  await prisma.lease.deleteMany({ where: w })
  await prisma.tenant.deleteMany({ where: w })
  await prisma.unit.deleteMany({ where: { propertyId: SEED_IDS.propertyId } })
  await prisma.property.deleteMany({ where: w })
  await prisma.user.deleteMany({ where: w })
  await prisma.organization.delete({ where: { id: SEED_IDS.organizationId } })
}

/** Radera-därefter-skapa med fasta id:n. Grindad. */
export async function seedHistory(prisma: PrismaClient = modulPrisma): Promise<void> {
  assertSeedAllowed(process.env)
  await rensa(prisma)
  const { ids, counts } = await createHistoryFixture(prisma, SEED_IDS)

  // Antal, inga personuppgifter.
  console.warn(`Historik-seed klar. Org ${ids.organizationId}, hyresgäst ${ids.tenantId}`)
  console.warn(`  ${JSON.stringify(counts)}`)
  console.warn(
    `  Avsiktliga luckor: avi ${FIXTURE_AVI_LUCKA[0]}-${String(FIXTURE_AVI_LUCKA[1]).padStart(2, '0')} saknas ` +
      `(inom horisonten ${FIXTURE_HORISONT[0]}-${FIXTURE_HORISONT[1]}), besiktning 2025-03 ej utförd, OVK förfallen.`,
  )
  console.warn(
    '  Månader efter horisonten räknas också som luckor — det talet växer med kalendern.',
  )
}

// Kör bara när filen körs SOM SKRIPT.
if (require.main === module) {
  seedHistory()
    .catch((e) => {
      console.error(e instanceof SeedRefusedError ? e.message : e)
      process.exit(1)
    })
    .finally(() => modulPrisma.$disconnect())
}
