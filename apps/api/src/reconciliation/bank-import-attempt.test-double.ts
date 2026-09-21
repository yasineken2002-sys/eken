import { Prisma } from '@prisma/client'

/**
 * EN MINNESATTRAPP FÖR `bankImportAttempt`-delegaten (#F034b).
 *
 * ── VARFÖR EN ATTRAPP OCH INTE `{}` ELLER ETT GENOMSLÄPP ────────────────────
 *
 * Flera befintliga specar prövar importvägen mot en HANDBYGGD prisma-attrapp
 * (ocr-provenienen, behandlingshistoriken, färskhetens radgräns). När filnivåns
 * skydd flyttade in i vägen behövde de en `bankImportAttempt` att svara med.
 *
 * Två genvägar fanns, och båda hade varit sämre:
 *
 *   `{ create: jest.fn() }`     Skyddet hade då inte gjort NÅGOT i de proven.
 *                               De mäter andra saker — men ett prov som kör en
 *                               import genom ett bortkopplat skydd mäter en väg
 *                               som inte finns i drift.
 *
 *   en genomsläppande tjänst    Samma sak, fast svårare att upptäcka: anropet
 *                               ser rätt ut och gör ingenting.
 *
 * Attrappen implementerar därför det som FAKTISKT bär skyddet — det unika
 * villkoret `(organizationId, fingerprint)` — och kastar ett riktigt P2002 när
 * det bryts. De befintliga proven kör alltså genom samma grenar som drift.
 *
 * ── VAD DEN INTE ÄR ─────────────────────────────────────────────────────────
 *
 * Den är INTE ett substitut för `bankimport-filidempotens.db.spec.ts`. En
 * minnes-`Map` är serialiserad av JavaScripts event loop och kan inte visa att
 * två APPINSTANSER avgörs rätt. Samtidigheten mäts mot riktig Postgres, med
 * tvingat överlapp; den här filen finns bara för att de ÖVRIGA proven ska
 * kunna köra importvägen utan en databas.
 */

interface Rad {
  id: string
  organizationId: string
  fingerprint: string
  kind: string
  fileName: string
  contentHash: string
  mappingHash: string
  status: string
  attempt: number
  startedAt: Date
  heartbeatAt: Date
  finishedAt: Date | null
  resultJson: unknown
  errorMessage: string | null
}

/**
 * Bygger delegaten. Returnerar även `rader` så ett prov kan påstå något om
 * försöken själva i stället för att bara lita på att de finns.
 */
export function bankImportAttemptAttrapp(): {
  delegat: Record<string, unknown>
  rader: Map<string, Rad>
} {
  const rader = new Map<string, Rad>()
  let löpnummer = 0
  const nyckel = (o: string, f: string) => `${o}::${f}`

  const delegat = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const o = String(data['organizationId'])
      const f = String(data['fingerprint'])
      if (rader.has(nyckel(o, f))) {
        // SAMMA FELFORM SOM POSTGRES. Ett eget feltyp hade gjort att
        // `körEnGång`s P2002-gren aldrig kördes i de här proven.
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test-double',
          meta: { target: ['organizationId', 'fingerprint'] },
        })
      }
      const nu = new Date()
      const rad: Rad = {
        id: `attempt-${(löpnummer += 1)}`,
        organizationId: o,
        fingerprint: f,
        kind: String(data['kind'] ?? ''),
        fileName: String(data['fileName'] ?? ''),
        contentHash: String(data['contentHash'] ?? ''),
        mappingHash: String(data['mappingHash'] ?? ''),
        status: String(data['status'] ?? 'RUNNING'),
        attempt: 1,
        startedAt: nu,
        heartbeatAt: nu,
        finishedAt: null,
        resultJson: null,
        errorMessage: null,
      }
      rader.set(nyckel(o, f), rad)
      return { ...rad }
    },

    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      const w = where['organizationId_fingerprint'] as
        | { organizationId: string; fingerprint: string }
        | undefined
      if (!w) return null
      const rad = rader.get(nyckel(w.organizationId, w.fingerprint))
      return rad ? { ...rad } : null
    },

    update: async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
      for (const rad of rader.values()) {
        if (rad.id !== where.id) continue
        for (const [k, v] of Object.entries(data)) {
          ;(rad as unknown as Record<string, unknown>)[k] = v
        }
        return { ...rad }
      }
      throw new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: 'test-double',
      })
    },

    updateMany: async ({
      data,
      where,
    }: {
      data: Record<string, unknown>
      where: Record<string, unknown>
    }) => {
      let count = 0
      for (const rad of rader.values()) {
        const r = rad as unknown as Record<string, unknown>
        // VILLKORSJÄMFÖRELSEN ÄR HELA ÖVERTAGANDETS MEKANIK. Jämför den
        // slarvigt (t.ex. bara `id`) svarar attrappen `count: 1` där Postgres
        // hade svarat 0, och provet hade sett två vinnare som en.
        let träff = true
        for (const [k, v] of Object.entries(where)) {
          const a = r[k]
          if (a instanceof Date && v instanceof Date) {
            if (a.getTime() !== v.getTime()) träff = false
          } else if (a !== v) {
            träff = false
          }
          if (!träff) break
        }
        if (!träff) continue
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as Record<string, unknown>)) {
            r[k] = Number(r[k] ?? 0) + Number((v as { increment: number }).increment)
          } else {
            r[k] = v
          }
        }
        count += 1
      }
      return { count }
    },

    count: async () => rader.size,
    deleteMany: async () => {
      const n = rader.size
      rader.clear()
      return { count: n }
    },
  }

  return { delegat, rader }
}
