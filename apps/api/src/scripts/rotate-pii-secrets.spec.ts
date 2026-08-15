import { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'
import { SigningCryptoService } from '../signing/signing-crypto.service'
import {
  RotationAbort,
  aesKeyFromHex,
  blindIndex,
  classifyForKey,
  classifyForPepper,
  describeVerification,
  encrypt,
  rotatePiiSecrets,
  tryDecrypt,
} from './rotate-pii-secrets'
import type { RotationCounts, RotationResult } from './rotate-pii-secrets'

const KEY_OLD = 'a'.repeat(64)
const KEY_NEW = 'b'.repeat(64)
const PEPPER_OLD = 'gammal-pepper-16tecken'
const PEPPER_NEW = 'ny-pepper-minst-16tecken'
const PN = '19900101-1234'

const kOld = aesKeyFromHex(KEY_OLD, 'k')
const kNew = aesKeyFromHex(KEY_NEW, 'k')

// ─── In-memory-Prisma ────────────────────────────────────────────────────────
// Bara Prisma-lagret fejkas. Krypto-primitiverna körs på riktigt, och paritets-
// testet nedan kör den RIKTIGA SigningCryptoService — en stubbad krypto-tjänst
// hade kunnat vara grön medan formaten divergerat.

interface FakeRow {
  id: string
  personalNumberEnc: string | null
  personalNumberHash: string | null
  signaturePayload?: string | null
  certificate?: string | null
}

function makeDelegate(rows: FakeRow[]) {
  return {
    findMany(args: {
      orderBy: { id: 'asc' }
      take: number
      cursor?: { id: string }
      skip?: number
    }) {
      const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id))
      const start = args.cursor
        ? sorted.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0)
        : 0
      return Promise.resolve(sorted.slice(start, start + args.take).map((r) => ({ ...r })))
    },
    update(args: { where: { id: string }; data: Record<string, string> }) {
      const row = rows.find((r) => r.id === args.where.id)
      if (!row) throw new Error(`ingen rad ${args.where.id}`)
      Object.assign(row, args.data)
      return Promise.resolve(row)
    },
  }
}

function makePrisma(opts: {
  tenants?: FakeRow[]
  customers?: FakeRow[]
  evidence?: FakeRow[]
  inFlightSigning?: number
}) {
  const tenants = opts.tenants ?? []
  const customers = opts.customers ?? []
  const evidence = opts.evidence ?? []
  return {
    prisma: {
      tenant: makeDelegate(tenants),
      customer: makeDelegate(customers),
      signatureEvidence: makeDelegate(evidence),
      signingRequest: { count: () => Promise.resolve(opts.inFlightSigning ?? 0) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    tenants,
    customers,
    evidence,
  }
}

/** En orörd rad: krypterad med gamla nyckeln, hashad med gamla peppern. */
function oroerdRad(id: string, pn = PN): FakeRow {
  return {
    id,
    personalNumberEnc: encrypt(kOld, pn),
    personalNumberHash: blindIndex(PEPPER_OLD, pn),
  }
}

const pepperEnv = {
  SIGNING_PII_KEY: KEY_OLD,
  SIGNING_PII_PEPPER_OLD: PEPPER_OLD,
  SIGNING_PII_PEPPER_NEW: PEPPER_NEW,
} as NodeJS.ProcessEnv

const keyEnv = {
  SIGNING_PII_KEY_OLD: KEY_OLD,
  SIGNING_PII_KEY_NEW: KEY_NEW,
} as NodeJS.ProcessEnv

// ─────────────────────────────────────────────────────────────────────────────

describe('paritet med SigningCryptoService', () => {
  // Primitiverna är duplicerade (skriptet kör utan Nest-kontext). Det här testet
  // är det som gör dupliceringen försvarbar: divergerar formaten blir det rött.
  const svc = new SigningCryptoService({
    get: (k: string) => (k === 'SIGNING_PII_KEY' ? KEY_OLD : PEPPER_OLD),
  } as unknown as ConfigService)

  it('blind-index är identiskt med tjänstens', () => {
    expect(blindIndex(PEPPER_OLD, PN)).toBe(svc.blindIndex(PN))
    expect(blindIndex(PEPPER_OLD, '199001011234')).toBe(svc.blindIndex('19900101-1234'))
  })

  it('envelope-formatet är utbytbart åt båda håll', () => {
    expect(svc.decrypt(encrypt(kOld, PN))).toBe(PN)
    expect(tryDecrypt(kOld, svc.encrypt(PN))).toBe(PN)
  })
})

describe('klassificeraren — tre utfall, ingen fallback', () => {
  const ctx = { key: kOld, oldPepper: PEPPER_OLD, newPepper: PEPPER_NEW }

  it('orörd rad → ATT_ROTERA med ny hash', () => {
    const r = classifyForPepper(oroerdRad('t1'), ctx, 't1')
    expect(r.verdict).toBe('ATT_ROTERA')
    expect(r.newHash).toBe(blindIndex(PEPPER_NEW, PN))
  })

  it('KANARIEFÅGEL: redan roterad rad MÅSTE ge REDAN_ROTERAD', () => {
    // Utan den här skulle en trasig klassificerare som alltid svarar ATT_ROTERA
    // passera varje test ovan lika grönt — och tyst skriva om rader som redan
    // var klara.
    const rad: FakeRow = {
      id: 't2',
      personalNumberEnc: encrypt(kOld, PN),
      personalNumberHash: blindIndex(PEPPER_NEW, PN),
    }
    expect(classifyForPepper(rad, ctx, 't2').verdict).toBe('REDAN_ROTERAD')

    const trasig = (): string => 'ATT_ROTERA'
    expect(trasig()).not.toBe(classifyForPepper(rad, ctx, 't2').verdict)
  })

  it('tredje pepper → AVBRYT, inte "anta orörd"', () => {
    const rad: FakeRow = {
      id: 't3',
      personalNumberEnc: encrypt(kOld, PN),
      personalNumberHash: blindIndex('en-helt-annan-pepper16', PN),
    }
    const r = classifyForPepper(rad, ctx, 't3')
    expect(r.verdict).toBe('AVBRYT')
    expect(r.reason).toMatch(/varken gammal eller ny pepper/)
  })

  it('enc och hash ur par → AVBRYT', () => {
    const r = classifyForPepper(
      { id: 't4', personalNumberEnc: encrypt(kOld, PN), personalNumberHash: null },
      ctx,
      't4',
    )
    expect(r.verdict).toBe('AVBRYT')
    expect(r.reason).toMatch(/inte i par/)
  })

  it('utan personnummer → HOPPA_OVER', () => {
    expect(
      classifyForPepper({ id: 't5', personalNumberEnc: null, personalNumberHash: null }, ctx, 't5')
        .verdict,
    ).toBe('HOPPA_OVER')
  })

  it('fel nyckel vid peppar-rotation → AVBRYT med rätt skäl', () => {
    const r = classifyForPepper(oroerdRad('t6'), { ...ctx, key: kNew }, 't6')
    expect(r.verdict).toBe('AVBRYT')
    expect(r.reason).toMatch(/NYCKELN är oförändrad/)
  })
})

describe('nyckel-läget', () => {
  const ctx = { oldKey: kOld, newKey: kNew }
  const kolumner = ['personalNumberEnc', 'signaturePayload', 'certificate']

  it('roterar ALLA fem AES-kolumner, inte bara personnumret', () => {
    const rad: FakeRow = {
      id: 'e1',
      personalNumberEnc: encrypt(kOld, PN),
      personalNumberHash: blindIndex(PEPPER_OLD, PN),
      signaturePayload: encrypt(kOld, 'rå-signatur'),
      certificate: encrypt(kOld, 'cert-pem'),
    }
    const r = classifyForKey(rad, ctx, kolumner, 'e1')
    expect(r.verdict).toBe('ATT_ROTERA')
    expect(Object.keys(r.data!).sort()).toEqual([
      'certificate',
      'personalNumberEnc',
      'signaturePayload',
    ])
    // BEVARANDEBEVIS: klartexten är identisk efter transformationen.
    expect(tryDecrypt(kNew, r.data!['personalNumberEnc']!)).toBe(PN)
    expect(tryDecrypt(kNew, r.data!['signaturePayload']!)).toBe('rå-signatur')
    expect(tryDecrypt(kNew, r.data!['certificate']!)).toBe('cert-pem')
  })

  it('KANARIEFÅGEL: rad redan krypterad med nya nyckeln → REDAN_ROTERAD', () => {
    const rad: FakeRow = { id: 'e2', personalNumberEnc: encrypt(kNew, PN), personalNumberHash: 'x' }
    expect(classifyForKey(rad, ctx, ['personalNumberEnc'], 'e2').verdict).toBe('REDAN_ROTERAD')
  })

  it('tredje nyckel → AVBRYT', () => {
    const rad: FakeRow = {
      id: 'e3',
      personalNumberEnc: encrypt(aesKeyFromHex('c'.repeat(64), 'k'), PN),
      personalNumberHash: 'x',
    }
    const r = classifyForKey(rad, ctx, ['personalNumberEnc'], 'e3')
    expect(r.verdict).toBe('AVBRYT')
    expect(r.reason).toMatch(/tredje nyckel|korrupt/)
  })

  it('kolumner med olika nycklar → AVBRYT (skriver inte över inkonsekvent tillstånd)', () => {
    const rad: FakeRow = {
      id: 'e4',
      personalNumberEnc: encrypt(kNew, PN),
      personalNumberHash: 'x',
      signaturePayload: encrypt(kOld, 'rå'),
    }
    const r = classifyForKey(rad, ctx, kolumner, 'e4')
    expect(r.verdict).toBe('AVBRYT')
    expect(r.reason).toMatch(/OLIKA nycklar/)
  })
})

describe('körningen', () => {
  it('peppar-rotation skriver hash och lämnar chiffertexten ORÖRD', async () => {
    const { prisma, tenants } = makePrisma({
      tenants: [oroerdRad('t1'), oroerdRad('t2', '19850505-5678')],
    })
    const encFore = tenants.map((t) => t.personalNumberEnc)

    const res = await rotatePiiSecrets(prisma, { mode: 'pepper', dryRun: false, env: pepperEnv })

    expect(res.total).toEqual({ scanned: 2, rotated: 2, alreadyRotated: 0, skipped: 0 })
    expect(tenants[0]!.personalNumberHash).toBe(blindIndex(PEPPER_NEW, PN))
    expect(tenants.map((t) => t.personalNumberEnc)).toEqual(encFore)
  })

  it('nyckel-rotation skriver chiffertext och lämnar hashen ORÖRD', async () => {
    const { prisma, tenants } = makePrisma({ tenants: [oroerdRad('t1')] })
    const hashFore = tenants[0]!.personalNumberHash

    await rotatePiiSecrets(prisma, { mode: 'key', dryRun: false, env: keyEnv })

    expect(tenants[0]!.personalNumberHash).toBe(hashFore)
    expect(tryDecrypt(kNew, tenants[0]!.personalNumberEnc!)).toBe(PN)
  })

  it('är idempotent — en andra körning roterar noll', async () => {
    const { prisma } = makePrisma({ tenants: [oroerdRad('t1'), oroerdRad('t2')] })
    await rotatePiiSecrets(prisma, { mode: 'pepper', dryRun: false, env: pepperEnv })
    const andra = await rotatePiiSecrets(prisma, { mode: 'pepper', dryRun: false, env: pepperEnv })
    expect(andra.total.rotated).toBe(0)
    expect(andra.total.alreadyRotated).toBe(2)
  })

  it('--dry-run skriver INGENTING men räknar rätt', async () => {
    const { prisma, tenants } = makePrisma({ tenants: [oroerdRad('t1')] })
    const fore = { ...tenants[0]! }
    const res = await rotatePiiSecrets(prisma, { mode: 'pepper', dryRun: true, env: pepperEnv })
    expect(res.total.rotated).toBe(1)
    expect(tenants[0]).toEqual(fore)
  })

  it('en oklassificerbar rad avbryter HELA körningen, inte bara raden', async () => {
    const trasig: FakeRow = {
      id: 'b',
      personalNumberEnc: encrypt(kOld, PN),
      personalNumberHash: blindIndex('tredje-pepper-16tecken', PN),
    }
    // 'a' före 'b' i id-ordning, 'c' efter — så vi kan se att 'c' aldrig rörs.
    const { prisma, tenants } = makePrisma({
      tenants: [oroerdRad('a'), trasig, oroerdRad('c')],
    })
    const cFore = tenants[2]!.personalNumberHash

    await expect(
      rotatePiiSecrets(prisma, { mode: 'pepper', dryRun: false, env: pepperEnv }),
    ).rejects.toThrow(RotationAbort)

    expect(tenants[2]!.personalNumberHash).toBe(cFore) // 'c' orörd
  })

  it('räknarna speglar vad som HANN skrivas när körningen avbryts', async () => {
    // Granskningsfynd: avbrottsspåret rapporterade tidigare noll roterade rader
    // medan de föregående redan var committade — spåret påstod då motsatsen till
    // vad som hänt. `progress` är referensen som gör siffrorna sanna vid kast.
    const trasig: FakeRow = {
      id: 'b',
      personalNumberEnc: encrypt(kOld, PN),
      personalNumberHash: blindIndex('tredje-pepper-16tecken', PN),
    }
    const { prisma } = makePrisma({ tenants: [oroerdRad('a'), trasig, oroerdRad('c')] })
    const progress = {
      perTable: {} as Record<string, RotationCounts>,
      total: { scanned: 0, rotated: 0, alreadyRotated: 0, skipped: 0 } as RotationCounts,
    }

    await expect(
      rotatePiiSecrets(prisma, { mode: 'pepper', dryRun: false, env: pepperEnv, progress }),
    ).rejects.toThrow(RotationAbort)

    // 'a' hann skrivas, 'b' fällde, 'c' nåddes aldrig.
    expect(progress.total.rotated).toBe(1)
    expect(progress.total.scanned).toBe(2)
    expect(progress.perTable['Tenant']!.rotated).toBe(1)
  })

  it('avbrottet bär en kategori utan rad-id (spårtabellen är global)', async () => {
    const trasig: FakeRow = {
      id: 'b',
      personalNumberEnc: encrypt(kOld, PN),
      personalNumberHash: blindIndex('tredje-pepper-16tecken', PN),
    }
    const { prisma } = makePrisma({ tenants: [trasig] })
    let err: unknown
    try {
      await rotatePiiSecrets(prisma, { mode: 'pepper', dryRun: false, env: pepperEnv })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(RotationAbort)
    if (!(err instanceof RotationAbort)) throw new Error('oåtkomligt')
    expect(err.category).toBe('TREDJE_PEPPER')
    // Meddelandet pekar ut raden (operatören behöver det)…
    expect(err.message).toContain('b')
    // …men kategorin, som är det som persisteras, gör det inte.
    expect(err.category).not.toContain('b')
  })

  it('vägrar peppar-rotera medan en signeringsbegäran är i luften', async () => {
    const { prisma } = makePrisma({ tenants: [oroerdRad('t1')], inFlightSigning: 1 })
    await expect(
      rotatePiiSecrets(prisma, { mode: 'pepper', dryRun: false, env: pepperEnv }),
    ).rejects.toThrow(/i luften/)
  })

  it('nyckel-rotation berörs INTE av pågående signering (hasharna rörs inte)', async () => {
    const { prisma } = makePrisma({ tenants: [oroerdRad('t1')], inFlightSigning: 3 })
    await expect(
      rotatePiiSecrets(prisma, { mode: 'key', dryRun: false, env: keyEnv }),
    ).resolves.toBeDefined()
  })

  it('går igenom alla tre tabellerna', async () => {
    const { prisma } = makePrisma({
      tenants: [oroerdRad('t1')],
      customers: [oroerdRad('c1')],
      evidence: [oroerdRad('e1')],
    })
    const res = await rotatePiiSecrets(prisma, { mode: 'pepper', dryRun: false, env: pepperEnv })
    expect(Object.keys(res.perTable).sort()).toEqual(['Customer', 'SignatureEvidence', 'Tenant'])
    expect(res.total.rotated).toBe(3)
  })

  it('paginerar förbi en full batch', async () => {
    const manga = Array.from({ length: 1201 }, (_, i) =>
      oroerdRad(`t${String(i).padStart(5, '0')}`),
    )
    const { prisma } = makePrisma({ tenants: manga })
    const res = await rotatePiiSecrets(prisma, { mode: 'pepper', dryRun: false, env: pepperEnv })
    expect(res.total.scanned).toBe(1201)
    expect(res.total.rotated).toBe(1201)
  })
})

describe('miljövalidering', () => {
  it('vägrar när gammal och ny pepper är identiska', async () => {
    const { prisma } = makePrisma({})
    await expect(
      rotatePiiSecrets(prisma, {
        mode: 'pepper',
        dryRun: true,
        env: { ...pepperEnv, SIGNING_PII_PEPPER_NEW: PEPPER_OLD } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/identiska/)
  })

  it('vägrar när gammal och ny nyckel är identiska', async () => {
    const { prisma } = makePrisma({})
    await expect(
      rotatePiiSecrets(prisma, {
        mode: 'key',
        dryRun: true,
        env: { SIGNING_PII_KEY_OLD: KEY_OLD, SIGNING_PII_KEY_NEW: KEY_OLD } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/identiska/)
  })

  it('vägrar en nyckel som inte är 64 hex', async () => {
    const { prisma } = makePrisma({})
    await expect(
      rotatePiiSecrets(prisma, {
        mode: 'key',
        dryRun: true,
        env: { SIGNING_PII_KEY_OLD: KEY_OLD, SIGNING_PII_KEY_NEW: 'för-kort' } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/64 hex-tecken/)
  })
})

describe('describeVerification — tom mängd är inte OK', () => {
  const bas = (o: Partial<RotationResult['total']>): RotationResult => ({
    mode: 'pepper',
    dryRun: true,
    perTable: {},
    total: { scanned: 0, rotated: 0, alreadyRotated: 0, skipped: 0, ...o },
  })

  it('noll kontrollerbara rader ger KAN EJ VERIFIERAS, aldrig OK', () => {
    expect(describeVerification(bas({}))).toMatch(/KAN EJ VERIFIERAS/)
    // Även när tabellerna har rader, men ingen bär personnummer.
    expect(describeVerification(bas({ scanned: 40, skipped: 40 }))).toMatch(/KAN EJ VERIFIERAS/)
  })

  it('allt roterat ger OK', () => {
    expect(describeVerification(bas({ scanned: 3, alreadyRotated: 3 }))).toMatch(/^OK/)
  })

  it('halvvägs ger OFULLSTÄNDIG', () => {
    expect(describeVerification(bas({ scanned: 3, rotated: 1, alreadyRotated: 2 }))).toMatch(
      /^OFULLSTÄNDIG/,
    )
  })
})

describe('AES-GCM-diskriminatorn (grunden för idempotensen)', () => {
  it('fel nyckel returnerar null i stället för skräp', () => {
    expect(tryDecrypt(kNew, encrypt(kOld, PN))).toBeNull()
  })

  it('rätt nyckel ger klartexten tillbaka (annars mäter testet ovan inget)', () => {
    expect(tryDecrypt(kOld, encrypt(kOld, PN))).toBe(PN)
  })

  it('chiffertexten är icke-deterministisk — rotationsstatus går inte att se på enc ensam', () => {
    expect(encrypt(kOld, PN)).not.toBe(encrypt(kOld, PN))
  })

  it('slumpade nycklar beter sig som de fasta testnycklarna', () => {
    const a = crypto.randomBytes(32)
    const b = crypto.randomBytes(32)
    expect(tryDecrypt(b, encrypt(a, PN))).toBeNull()
    expect(tryDecrypt(a, encrypt(a, PN))).toBe(PN)
  })
})
