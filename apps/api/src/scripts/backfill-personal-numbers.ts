/**
 * Backfill: klartext-personnummer → AES-256-GCM + HMAC-blind-index.
 *
 * Körs av `scripts/migrate-and-start.sh` direkt efter `prisma migrate deploy`
 * och FÖRE appstart, så en deploy aldrig kan lämna klartext liggande medan
 * appen tar trafik.
 *
 * VARFÖR ETT SKRIPT OCH INTE SQL: krypteringen är AES-256-GCM med nyckel ur env.
 * Postgres pgcrypto har ingen GCM, och att skicka nyckeln till databasen hade
 * lagt den i migrationsfilen och i serverloggen.
 *
 * EGENSKAPER
 *  - Idempotent. Tar bara rader där klartexten fortfarande finns. En andra
 *    körning gör ingenting.
 *  - Per rad i en transaktion: skriv chiffertext + blind-index OCH nolla
 *    klartexten i samma UPDATE. Ingen rad kan bli halvmigrerad.
 *  - Verifierar varje rad genom att dekryptera tillbaka och jämföra med
 *    originalet INNAN klartexten nollas. Går det inte att läsa tillbaka
 *    avbryts körningen med den raden orörd.
 *  - Fail-closed: finns rader att migrera men nycklarna saknas → avslutar med
 *    felkod och stoppar deployen. Alternativet vore att tyst lämna klartext.
 *  - Loggar ALDRIG ett personnummer, ett blind-index eller en chiffertext —
 *    bara antal och id:n.
 *
 * Klartext-kolumnen droppas i en uppföljande migration när produktions-
 * backfillen är bekräftad körd (expand → migrate → contract).
 */

import { PrismaClient } from '@prisma/client'
import * as crypto from 'crypto'

type Row = { id: string; personalNumberLegacy: string | null }

/**
 * Den lilla del av Prismas delegate som backfillen använder. Tenant och Customer
 * har strukturellt olika delegate-typer, så en union av dem går inte att anropa
 * (TS2349). Den här vyn beskriver bara de tre operationerna vi faktiskt kör och
 * gör modellerna utbytbara.
 */
interface PnDelegate {
  count(args: { where: { personalNumberLegacy: { not: null } } }): Promise<number>
  findMany(args: {
    where: { personalNumberLegacy: { not: null } }
    select: { id: true; personalNumberLegacy: true }
    take: number
  }): Promise<Row[]>
  update(args: {
    where: { id: string }
    data: {
      personalNumberEnc?: string | null
      personalNumberHash?: string | null
      personalNumberLegacy: null
    }
  }): Promise<unknown>
}

const BATCH = 500

function log(msg: string): void {
  // console.log är bannlyst i projektet; skriptet loggar till stderr.
  console.warn(`[backfill-pn] ${msg}`)
}

/**
 * Samma primitiver som SigningCryptoService. Duplicerade med flit: skriptet
 * körs som en fristående nod-process utan Nest-kontext, och ett DI-bootstrap
 * bara för två funktioner hade dragit in hela AppModule (och därmed köer,
 * cron och R2) i en deploy-kritisk väg. Testet
 * `backfill-personal-numbers.spec.ts` låser att formaten är identiska.
 */
function makeCrypto(keyHex: string, pepper: string) {
  const aesKey = Buffer.from(keyHex, 'hex')
  return {
    encrypt(plaintext: string): string {
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv)
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
    },
    decrypt(enc: string): string {
      const raw = Buffer.from(enc, 'base64')
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, raw.subarray(0, 12))
      decipher.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
    },
    blindIndex(personalNumber: string): string {
      return crypto
        .createHmac('sha256', pepper)
        .update(personalNumber.replace(/\D/g, ''))
        .digest('hex')
    },
  }
}

export async function backfillPersonalNumbers(prisma: PrismaClient, env: NodeJS.ProcessEnv) {
  const models: Array<{ name: string; delegate: PnDelegate }> = [
    { name: 'Tenant', delegate: prisma.tenant as unknown as PnDelegate },
    { name: 'Customer', delegate: prisma.customer as unknown as PnDelegate },
  ]

  // Räkna först — utan rader att migrera behövs ingen nyckel, och en deploy av
  // en tom/ny databas ska inte blockeras.
  let pending = 0
  for (const m of models) {
    pending += await m.delegate.count({ where: { personalNumberLegacy: { not: null } } })
  }
  if (pending === 0) {
    log('inga klartext-personnummer kvar — hoppar över')
    return { migrated: 0, skipped: true }
  }

  const keyHex = env['SIGNING_PII_KEY']
  const pepper = env['SIGNING_PII_PEPPER']
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex) || !pepper || pepper.length < 16) {
    throw new Error(
      `${pending} personnummer ligger i klartext men SIGNING_PII_KEY/SIGNING_PII_PEPPER ` +
        'saknas eller är ogiltiga. Sätt nycklarna och deploya om — backfillen vägrar ' +
        'lämna klartext bakom sig.',
    )
  }
  const c = makeCrypto(keyHex, pepper)

  let migrated = 0
  for (const m of models) {
    // Skyddsräkning mot en oändlig loop. Batchen väljs på "klartext finns
    // kvar", så en rad som av något skäl inte blir tömd skulle plockas upp om
    // och om igen — och eftersom skriptet ligger i deploy-vägen hade det hängt
    // deployen i stället för att fela. Går en runda utan att någon rad blir
    // klar avbryter vi hellre högljutt.
    let lastRemaining = Number.POSITIVE_INFINITY
    for (;;) {
      const rows: Row[] = await m.delegate.findMany({
        where: { personalNumberLegacy: { not: null } },
        select: { id: true, personalNumberLegacy: true },
        take: BATCH,
      })
      if (rows.length === 0) break

      const remaining = await m.delegate.count({ where: { personalNumberLegacy: { not: null } } })
      if (remaining >= lastRemaining) {
        throw new Error(
          `${m.name}: ${remaining} rader har fortfarande klartext efter en hel batch — ` +
            'backfillen gör inga framsteg och avbryts i stället för att loopa.',
        )
      }
      lastRemaining = remaining

      for (const row of rows) {
        const plain = row.personalNumberLegacy
        if (!plain || plain.trim() === '') {
          // Tom sträng: inget att skydda, men den ska inte blockera loopen.
          await m.delegate.update({
            where: { id: row.id },
            data: { personalNumberLegacy: null },
          })
          continue
        }
        const trimmed = plain.trim()
        const enc = c.encrypt(trimmed)

        // Läs tillbaka INNAN klartexten släpps. Går det inte att dekryptera är
        // något fel på nyckeln — då ska raden lämnas orörd, inte tömmas.
        if (c.decrypt(enc) !== trimmed) {
          throw new Error(
            `Verifieringen misslyckades för ${m.name} ${row.id} — chiffertexten gick inte ` +
              'att läsa tillbaka. Ingen rad har tömts. Kontrollera SIGNING_PII_KEY.',
          )
        }

        await m.delegate.update({
          where: { id: row.id },
          data: {
            personalNumberEnc: enc,
            personalNumberHash: c.blindIndex(trimmed),
            personalNumberLegacy: null,
          },
        })
        migrated++
      }
      log(`${m.name}: ${migrated} rader klara…`)
    }
  }

  log(`klart — ${migrated} personnummer krypterade, 0 kvar i klartext`)
  return { migrated, skipped: false }
}

/* istanbul ignore next -- entry point, testas via backfillPersonalNumbers */
async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    await backfillPersonalNumbers(prisma, process.env)
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[backfill-pn] AVBRUTEN:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
