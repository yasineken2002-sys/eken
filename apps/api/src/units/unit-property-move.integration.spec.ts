/**
 * F057 · FLYTTAS ETT OBJEKT NÄR `propertyId` ÄNDRAS I `PATCH /units/:id`?
 *
 * ── Vad fyndet påstod ───────────────────────────────────────────────────────
 *
 * `propertyId` accepteras av det delade schemat (`UpdateUnitSchema` =
 * `CreateUnitSchema.partial()`), av `UpdateUnitDto` (`PartialType`) och därmed
 * av den riktiga `ValidationPipe` — men `units.service.ts` bygger sin
 * `data`-post av åtta andra fält och nämner aldrig `propertyId`. Följden är
 * 200 OK, lyckad-väg i gränssnittet och en rad som står kvar där den stod.
 *
 * ── Varför den här formen på provet ─────────────────────────────────────────
 *
 * Påståendet gäller API:t, så provet går via den RIKTIGA HTTP-gränsen med den
 * RIKTIGA `VALIDATION_PIPE_OPTIONS` — inte genom att anropa tjänsten direkt.
 * Det är samma fälla CLAUDE.md beskriver för #795: 37 gröna prov gick förbi
 * DTO:n och såg därför inte vad kunden träffar. `whitelist` +
 * `forbidNonWhitelisted` är dessutom exakt det som avgör om `propertyId`
 * strippas eller släpps igenom, och det kan bara mätas med den pipen.
 *
 * Lagringen är bärande i själva påståendet ("lyckat svar, oförändrad rad"), så
 * Prisma ersätts av en syntetisk tabell som faktiskt HÅLLER raderna. En
 * `jest.fn()` som bara räknar anrop hade inte kunnat skilja "sparades inte" från
 * "sparades fel".
 *
 * ── Vad provet INTE ser ─────────────────────────────────────────────────────
 *
 * Det mäter rutten, DTO:n, pipen och tjänstens skrivning. Det säger ingenting
 * om Prismas egna spärrar mot en verklig databas — `@@unique([propertyId,
 * unitNumber])` och främmande nycklar finns inte i den syntetiska tabellen.
 * Det är avsiktligt: de spärrarna är en del av VARFÖR en flytt inte är en
 * stödd operation, inte en del av det som mäts här.
 *
 * Inloggningen är inte heller äkta här: `JwtAuthGuard` ersätts och identiteten
 * kommer ur provheaders. Rollgrinden är däremot den riktiga.
 *
 * ── VAD SOM MÄTER RESTEN ────────────────────────────────────────────────────
 *
 * `unit-property-move.db.spec.ts` kör samma rutter mot en RIKTIG `PrismaService`
 * och PostgreSQL, med riktig `JwtStrategy` och signerade tokens, och läser
 * tillbaka raden efter varje anrop. Den här filen behålls därför att den är
 * snabb och isolerar kontraktet; den ersätter inte databasbeviset och påstår
 * inte att göra det.
 */

import { Module, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { ValidationPipe } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { JwtPayload, UserRole } from '@eken/shared'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { PrismaService } from '../common/prisma/prisma.service'
import { UnitsController } from './units.controller'
import { UnitsService } from './units.service'

// ─── Identiteter ──────────────────────────────────────────────────────────────

const ORG_A = 'a0000000-0000-4000-8000-000000000001'
const ORG_B = 'b0000000-0000-4000-8000-000000000001'

const FASTIGHET_A1 = '11111111-1111-4111-8111-111111111111'
const FASTIGHET_A2 = '22222222-2222-4222-8222-222222222222'
const FASTIGHET_B1 = '33333333-3333-4333-8333-333333333333'

const OBJEKT = '44444444-4444-4444-8444-444444444444'

// ─── Syntetisk tabell ─────────────────────────────────────────────────────────

interface UnitRad {
  id: string
  propertyId: string
  name: string
  unitNumber: string
  type: string
  status: string
  area: number
  floor: number | null
  rooms: number | null
  monthlyRent: number
}

const FASTIGHETER: Record<string, { id: string; name: string; organizationId: string }> = {
  [FASTIGHET_A1]: { id: FASTIGHET_A1, name: 'Ekens Gård 1', organizationId: ORG_A },
  [FASTIGHET_A2]: { id: FASTIGHET_A2, name: 'Ekens Gård 2', organizationId: ORG_A },
  [FASTIGHET_B1]: { id: FASTIGHET_B1, name: 'Annan ägares hus', organizationId: ORG_B },
}

let rader: Record<string, UnitRad>

function nyttObjekt(): UnitRad {
  return {
    id: OBJEKT,
    propertyId: FASTIGHET_A1,
    name: 'Lägenhet 3A',
    unitNumber: '301',
    type: 'APARTMENT',
    status: 'VACANT',
    area: 72,
    floor: 3,
    rooms: 3,
    monthlyRent: 9500,
  }
}

/** Antal skrivningar som NÅTT tabellen — negativkontrollen "ingen deländring". */
let skrivningar = 0

function medFastighet(rad: UnitRad) {
  const p = FASTIGHETER[rad.propertyId]
  return {
    ...rad,
    property: { id: p?.id ?? rad.propertyId, name: p?.name ?? 'okänd' },
    _count: { leases: 0 },
  }
}

const prismaAttrapp = {
  unit: {
    findFirst: jest.fn(
      (args: { where: { id?: string; property?: { organizationId?: string } } }) => {
        const rad = args.where.id ? rader[args.where.id] : undefined
        if (!rad) return Promise.resolve(null)
        const org = args.where.property?.organizationId
        if (org && FASTIGHETER[rad.propertyId]?.organizationId !== org) {
          return Promise.resolve(null)
        }
        return Promise.resolve(medFastighet(rad))
      },
    ),
    update: jest.fn((args: { where: { id: string }; data: Partial<UnitRad> }) => {
      const rad = rader[args.where.id]
      if (!rad) throw new Error('Testfel: raden finns inte')
      skrivningar += 1
      rader[args.where.id] = { ...rad, ...args.data }
      return Promise.resolve(medFastighet(rader[args.where.id]!))
    }),
  },
  property: {
    findFirst: jest.fn((args: { where: { id?: string; organizationId?: string } }) => {
      const p = args.where.id ? FASTIGHETER[args.where.id] : undefined
      if (!p) return Promise.resolve(null)
      if (args.where.organizationId && p.organizationId !== args.where.organizationId) {
        return Promise.resolve(null)
      }
      return Promise.resolve(p)
    }),
  },
}

// ─── Inloggning ───────────────────────────────────────────────────────────────

/**
 * Ersätter `JwtAuthGuard` — provet mäter inte hur en token valideras, utan vad
 * som händer EFTER att någon släppts in. Rollen och organisationen kommer från
 * headers så att samma app kan köra alla tre aktörerna.
 *
 * `RolesGuard` nedan är den RIKTIGA: rollfallet ska mäta produktionens grind.
 *
 * ORDNINGEN ÄR BÄRANDE. `auth.module.ts:34-35` registrerar `JwtAuthGuard` och
 * sedan `RolesGuard` som två globala guards, och Nest kör globala guards före
 * de controller-scopade. Registreras bara `RolesGuard` globalt körs den innan
 * något satt `req.user`, och då svarar VARJE fall 403 — ett prov som ser
 * strängt ut och inte mäter något. Provmodulen speglar därför produktionens
 * ordning i stället för att luta sig mot controllerns `@UseGuards`.
 */
class ProvAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: JwtPayload }>()
    const headers = req.headers as Record<string, string | undefined>
    req.user = {
      sub: 'user-1',
      email: 'provare@example.com',
      organizationId: headers['x-prov-org'] ?? ORG_A,
      role: (headers['x-prov-roll'] ?? 'MANAGER') as UserRole,
    }
    return true
  }
}

@Module({
  controllers: [UnitsController],
  providers: [
    UnitsService,
    { provide: PrismaService, useValue: prismaAttrapp },
    { provide: APP_GUARD, useClass: ProvAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ProvModul {}

// ─── Anrop ────────────────────────────────────────────────────────────────────

let app: NestFastifyApplication

function patcha(
  kropp: Record<string, unknown>,
  aktor: { org?: string; roll?: UserRole } = {},
): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: 'PATCH',
    url: `/units/${OBJEKT}`,
    payload: kropp,
    headers: {
      'x-prov-org': aktor.org ?? ORG_A,
      'x-prov-roll': aktor.roll ?? 'MANAGER',
    },
  })
}

/** Kroppen webbens redigeringsformulär faktiskt skickar (`UnitForm.tsx:88-98`). */
function formularetsKropp(overskrivning: Record<string, unknown> = {}) {
  const rad = nyttObjekt()
  return {
    propertyId: rad.propertyId,
    name: rad.name,
    unitNumber: rad.unitNumber,
    type: rad.type,
    status: rad.status,
    area: rad.area,
    floor: rad.floor,
    rooms: rad.rooms,
    monthlyRent: rad.monthlyRent,
    ...overskrivning,
  }
}

describe('PATCH /units/:id · objektets fastighetstillhörighet (F057)', () => {
  beforeAll(async () => {
    // Controllerns egen `@UseGuards(JwtAuthGuard)` kopplas bort — den riktiga
    // kräver passport-strategin och en signerad token, vilket inte är vad som
    // mäts här. `ProvAuthGuard` ovan gör inloggningen i stället, globalt och
    // före `RolesGuard`.
    const modul = await Test.createTestingModule({ imports: [ProvModul] })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = modul.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    // SAMMA objekt som main.ts:155 — inte en kopia av inställningarna.
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS))
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    rader = { [OBJEKT]: nyttObjekt() }
    skrivningar = 0
    jest.clearAllMocks()
  })

  // ── Det bärande fallet ────────────────────────────────────────────────────

  it('ÄNDRAT propertyId inom samma organisation avvisas — fältet får inte lova en flytt som inte sker', async () => {
    const res = await patcha(formularetsKropp({ propertyId: FASTIGHET_A2 }))

    // Ett lyckat svar betyder "det du bad om är gjort". Att flytta objektet är
    // ingen stödd operation (ingen skrivväg i kodbasen rör `Unit.propertyId`
    // efter create), så det enda ärliga svaret är en avvisning.
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('fastighet')
    // Och raden ska förstås stå kvar — en avvisning som ändå skrev vore värre.
    expect(rader[OBJEKT]!.propertyId).toBe(FASTIGHET_A1)
  })

  it('ett avvisat fastighetsbyte skriver inte heller de övriga fälten', async () => {
    const res = await patcha(
      formularetsKropp({ propertyId: FASTIGHET_A2, name: 'Omdöpt i samma sparning' }),
    )

    expect(res.statusCode).toBe(400)
    expect(rader[OBJEKT]!.name).toBe('Lägenhet 3A')
    expect(skrivningar).toBe(0)
  })

  // ── Det som INTE får gå sönder ────────────────────────────────────────────

  it('OFÖRÄNDRAT propertyId från befintlig klient går igenom och sparar övriga fält', async () => {
    // Webbformuläret skickar ALLTID propertyId, även när användaren bara bytt
    // namn. Rättningen får inte göra en vanlig redigering till ett fel.
    const res = await patcha(formularetsKropp({ name: 'Lägenhet 3A (renoverad)' }))

    expect(res.statusCode).toBe(200)
    expect(rader[OBJEKT]!.name).toBe('Lägenhet 3A (renoverad)')
    expect(rader[OBJEKT]!.propertyId).toBe(FASTIGHET_A1)
  })

  it('PATCH utan propertyId går igenom och låter tillhörigheten stå kvar', async () => {
    const res = await patcha({ name: 'Bara namnet' })

    expect(res.statusCode).toBe(200)
    expect(rader[OBJEKT]!.name).toBe('Bara namnet')
    expect(rader[OBJEKT]!.propertyId).toBe(FASTIGHET_A1)
  })

  // ── Gränser ───────────────────────────────────────────────────────────────

  it('propertyId som pekar på en ANNAN organisations fastighet avvisas och flyttar ingenting', async () => {
    const res = await patcha(formularetsKropp({ propertyId: FASTIGHET_B1 }))

    expect(res.statusCode).toBe(400)
    expect(rader[OBJEKT]!.propertyId).toBe(FASTIGHET_A1)
    expect(skrivningar).toBe(0)
  })

  it('en aktör från en annan organisation når inte objektet alls (404)', async () => {
    const res = await patcha(formularetsKropp({ propertyId: FASTIGHET_A2 }), { org: ORG_B })

    expect(res.statusCode).toBe(404)
    expect(rader[OBJEKT]!.propertyId).toBe(FASTIGHET_A1)
    expect(skrivningar).toBe(0)
  })

  it('en VIEWER stoppas av rollgrinden före både validering och skrivning (403)', async () => {
    const res = await patcha(formularetsKropp({ propertyId: FASTIGHET_A2 }), { roll: 'VIEWER' })

    expect(res.statusCode).toBe(403)
    expect(skrivningar).toBe(0)
  })
})
