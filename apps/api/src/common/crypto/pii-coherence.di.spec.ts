import { Test } from '@nestjs/testing'
import { ConfigModule } from '@nestjs/config'
import { PersonalNumberModule } from './personal-number.module'
import { PiiCoherenceService } from './pii-coherence.service'
import { PrismaService } from '../prisma/prisma.service'

/**
 * ATT MODULEN GÅR ATT BYGGA — inte att den gör rätt.
 *
 * `pii-coherence.spec.ts` bygger tjänsten med `new PiiCoherenceService(…)` och
 * kringgår därmed DI-containern helt. Det är rätt för att mäta MEKANIKEN, men
 * det gör specen strukturellt blind för påkopplingen: den kan inte se att ett
 * beroende är omöjligt att injicera.
 *
 * Det är inte en farhåga. #580:s första version skrev `import type
 * { ConfigService }`, vilket raderas i runtime — 32 av 32 prov var gröna medan
 * API:t inte startade alls:
 *
 *     Nest can't resolve dependencies of the PiiCoherenceService
 *     (PrismaService, SigningCryptoService, ?, CronErrorSink).
 *
 * Bara E2E såg det, och E2E kör sist och kostar minuter. Det här provet ställer
 * samma fråga på en sekund.
 *
 * VAD DET INTE KAN SE: att kontrollen larmar rätt. Det ägs av
 * pii-coherence.spec.ts. De två är avsiktligt olika frågor — mekaniken och
 * påkopplingen — och ingen av dem duger som den andra.
 */
describe('PersonalNumberModule — påkopplingen', () => {
  it('kan bygga PiiCoherenceService via DI-containern', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PersonalNumberModule,
      ],
    })
      // Prisma ska inte koppla upp sig i ett enhetsprov — bara vara injicerbar.
      .overrideProvider(PrismaService)
      .useValue({})
      .compile()

    expect(moduleRef.get(PiiCoherenceService, { strict: false })).toBeInstanceOf(
      PiiCoherenceService,
    )
    await moduleRef.close()
  })
})
