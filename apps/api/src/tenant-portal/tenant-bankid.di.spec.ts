// `@aws-sdk/client-s3` går inte att ladda i jest (ESM). StorageService dras in
// av tre olika grenar av grafen, så klassen ersätts med en stub FÖRE importerna
// — samma mönster och samma skäl som `tenant-auth.validatesession.spec.ts`.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../contracts/contract-template.service', () => ({
  ContractTemplateService: class {},
}))

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'

import { BankidModule } from '../bankid/bankid.module'
import { PersonalNumberModule } from '../common/crypto/personal-number.module'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { TenantAuthService } from './tenant-auth.service'
import { TenantBankIdService } from './tenant-bankid.service'
import { TenantAuthController } from './tenant-portal.controller'

/**
 * DEN NYA KANTEN I GRAFEN — går den att injicera?
 *
 * ── VAD SOM FAKTISKT PRÖVAS ───────────────────────────────────────────────
 *
 * `TenantPortalModule` importerar numera `BankidModule` för att komma åt
 * `BANKID_PROVIDER`. Två saker kan gå fel på ett sätt som inget annat prov ser:
 *
 *   1. Providern EXPORTERAS INTE. Då är `@Inject(BANKID_PROVIDER)` olösbart —
 *      och `check-module-cycles` ser det inte alls, den läser bara `imports:`.
 *   2. CONTROLLERN får inte sin nya tjänst. En controller kan bara injicera det
 *      som syns i SIN moduls kontext; det är MÄTT och inte antaget (#580 gav
 *      32/32 gröna prov medan API:t inte startade alls).
 *
 * ── VARFÖR EN MINIMAL MODUL OCH INTE HELA TenantPortalModule ──────────────
 *
 * Försöket att bygga hela modulen slutade i `RangeError: Maximum call stack size
 * exceeded` — grafen drar in invoices, avisering och contracts med `forwardRef`,
 * och Nests testcontainer klarar inte den storleken här. Det är en känd gräns i
 * apps/api och inget den här kedjan infört.
 *
 * Modulen nedan innehåller därför EXAKT den nya kanten: `BankidModule` +
 * `PersonalNumberModule` på riktigt, controllern på riktigt, och attrapper för
 * de beroenden som inte har med frågan att göra. `TenantBankIdService` byggs av
 * CONTAINERN, inte för hand — annars mäter provet konstruktorn i stället för
 * påkopplingen.
 *
 * VAD PROVET INTE KAN SE: att HELA portalmodulen går att bygga. Det bevisas av
 * att appen bootar — E2E-jobbet startar den innan en enda spec körs.
 *
 * FLAGGAN ÄR AV, alltså Stub-providern: att modulen går att bygga får inte bero
 * på att BankID är påslaget.
 */
@Module({
  imports: [BankidModule, PersonalNumberModule],
  controllers: [TenantAuthController],
  providers: [
    TenantBankIdService,
    { provide: PrismaService, useValue: {} },
    { provide: TenantAuthService, useValue: {} },
    { provide: StorageService, useValue: {} },
    { provide: ContractTemplateService, useValue: {} },
  ],
})
class MinimalPortalBankIdModule {}

describe('portalens BankID — påkopplingen', () => {
  it('bygger med flaggan AV, och auth-controllern får BankID-tjänsten', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          // JWT_SECRET krävs av AuthModule:s JwtModule-factory (getOrThrow), som
          // kommer in via BankidModule. SIGNING_PII_* speglar en riktig boot.
          load: [
            () => ({
              JWT_SECRET: 'x'.repeat(32),
              SIGNING_PII_KEY: 'a'.repeat(64),
              SIGNING_PII_PEPPER: 'p'.repeat(32),
            }),
          ],
        }),
        MinimalPortalBankIdModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile()

    expect(moduleRef.get(TenantBankIdService, { strict: false })).toBeInstanceOf(
      TenantBankIdService,
    )
    expect(moduleRef.get(TenantAuthController, { strict: false })).toBeInstanceOf(
      TenantAuthController,
    )
    await moduleRef.close()
  })
})
