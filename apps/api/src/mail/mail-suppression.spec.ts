/**
 * STRYPVENTILEN: `Organization.transactionalEmailsDisabled`.
 *
 * ── VARFÖR VENTILEN FINNS ───────────────────────────────────────────────────
 *
 * Tre cron-jobb i `NotificationsService` — morgonrapporten (`0 7 * * 1-5`),
 * veckosammanfattningen (`0 18 * * 0`) och månadsrapporten (`0 8 1 * *`) —
 * väljer organisationer med en `findMany` HELT UTAN `where` och mejlar varje
 * aktiv OWNER/ADMIN/MANAGER/ACCOUNTANT. Det gick alltså inte att stänga av
 * utgående post för EN organisation: varje demo-, test- och internkonto blev en
 * mejlkälla mot påhittade adresser, och studsarna kostar avsändarrykte.
 *
 * De två utgångar som fanns var båda stängda av verkligheten: noll behöriga
 * användare kräver `isActive: false`, vilket `AuthService.login` nekar
 * inloggning på, och `hasMeaningfulData()` faller bara för en organisation utan
 * fastigheter, avtal OCH avier — alltså en tom organisation.
 *
 * ── VAD DEN HÄR FILEN MÄTER ─────────────────────────────────────────────────
 *
 * 1. Att ventilen STÄNGER (inget jobb köas, inget skickas).
 * 2. Att den INTE stänger när den är öppen. En spärr som fäller allt är lika
 *    trasig som en som inte fäller något — den skulle bara upptäckas i drift.
 * 3. Att okänd organisation fäller (fail-closed) medan ett DB-FEL kastar
 *    vidare. Skillnaden är hela poängen: en konfiguration ska vara tyst, ett
 *    infrastrukturfel ska synas som ett fel.
 * 4. KANARIEFÅGELN: att VARJE publik `send*`-metod på `MailService` faktiskt
 *    vidarebefordrar `organizationId` till kön. Typsystemet garanterar att
 *    anroparen skickar in fältet, men inte att metoden skickar det VIDARE — och
 *    ett fält som tappas på vägen ger `undefined` till grinden, som då slår upp
 *    en organisation som inte finns. Kanariefågeln fäller för en NY metod som
 *    glömmer det, inte bara för de metoder som fanns när ventilen byggdes.
 */

import { Resend } from 'resend'
import { MailQueue } from './mail.queue'
import { MailService } from './mail.service'
import { MailWorkerNormal } from './mail.worker'
import type { EnqueueMailOptions, MailJobPayload } from './mail.types'
import type { PrismaService } from '../common/prisma/prisma.service'

const ORG_ÖPPEN = 'org-oppen'
const ORG_STÄNGD = 'org-stangd'

type FejkKö = { add: jest.Mock; name: string }

function fejkKö(name: string): FejkKö {
  return { add: jest.fn().mockResolvedValue({ id: 'job-1' }), name }
}

/**
 * Prisma-stubbe som svarar utifrån org-id. `ORG_ÖPPEN` finns med ventilen
 * öppen, `ORG_STÄNGD` finns med den stängd, allt annat finns inte.
 */
function fejkPrisma(): PrismaService {
  return {
    organization: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === ORG_ÖPPEN) return { transactionalEmailsDisabled: false }
        if (where.id === ORG_STÄNGD) return { transactionalEmailsDisabled: true }
        return null
      }),
    },
  } as unknown as PrismaService
}

function basOpts(organizationId: string): EnqueueMailOptions<'custom'> {
  return {
    template: 'custom',
    organizationId,
    to: 'mottagare@exempel.invalid',
    subject: 'Ämne',
    props: {
      preview: 'Förhandsvisning',
      tenantName: 'Namn',
      organizationName: 'Org',
      whyReceived: 'Därför',
      bodyHtml: '<p>Hej</p>',
    },
  }
}

describe('MailQueue — strypventilen hos producenten', () => {
  it('köar mejlet när ventilen är ÖPPEN', async () => {
    const normal = fejkKö('mail:normal')
    const queue = new MailQueue(
      fejkKö('mail:high') as never,
      normal as never,
      fejkKö('mail:low') as never,
      fejkPrisma(),
    )

    const jobId = await queue.enqueue(basOpts(ORG_ÖPPEN))

    expect(normal.add).toHaveBeenCalledTimes(1)
    expect(jobId).toBe('job-1')
    // Org-id:t ska följa med in i jobbet — annars kan workern inte göra sin
    // andra kontroll.
    const payload = normal.add.mock.calls[0]?.[0] as MailJobPayload
    expect(payload.organizationId).toBe(ORG_ÖPPEN)
  })

  it('köar INGENTING när ventilen är STÄNGD, och returnerar tom sträng', async () => {
    const normal = fejkKö('mail:normal')
    const queue = new MailQueue(
      fejkKö('mail:high') as never,
      normal as never,
      fejkKö('mail:low') as never,
      fejkPrisma(),
    )

    const jobId = await queue.enqueue(basOpts(ORG_STÄNGD))

    expect(normal.add).not.toHaveBeenCalled()
    expect(jobId).toBe('')
  })

  it('fäller på OKÄND organisation — vi kan inte bevisa att ventilen är öppen', async () => {
    const normal = fejkKö('mail:normal')
    const queue = new MailQueue(
      fejkKö('mail:high') as never,
      normal as never,
      fejkKö('mail:low') as never,
      fejkPrisma(),
    )

    const jobId = await queue.enqueue(basOpts('org-som-inte-finns'))

    expect(normal.add).not.toHaveBeenCalled()
    expect(jobId).toBe('')
  })

  it('KASTAR vid DB-fel i stället för att tyst suppressa', async () => {
    const normal = fejkKö('mail:normal')
    const trasigPrisma = {
      organization: {
        findUnique: jest.fn().mockRejectedValue(new Error('connection reset')),
      },
    } as unknown as PrismaService
    const queue = new MailQueue(
      fejkKö('mail:high') as never,
      normal as never,
      fejkKö('mail:low') as never,
      trasigPrisma,
    )

    // Ett infrastrukturfel ska se ut som ett fel. Suppresserade vi tyst här
    // hade en DB-blipp stängt av all post utan att någon fick veta det.
    await expect(queue.enqueue(basOpts(ORG_ÖPPEN))).rejects.toThrow('connection reset')
    expect(normal.add).not.toHaveBeenCalled()
  })
})

describe('MailWorker — sistahandsskyddet hos konsumenten', () => {
  function byggWorker(prisma: PrismaService): {
    worker: MailWorkerNormal
    send: jest.Mock
  } {
    const renderer = {
      render: jest.fn().mockResolvedValue({ html: '<p>x</p>', text: 'x' }),
    }
    const config = { get: jest.fn().mockReturnValue(undefined) }
    const worker = new MailWorkerNormal(renderer as never, prisma, config as never)
    const send = jest.fn().mockResolvedValue({ data: { id: 'resend-1' }, error: null })
    ;(worker as unknown as { resend: Resend }).resend = {
      emails: { send },
    } as unknown as Resend
    return { worker, send }
  }

  function fejkJobb(organizationId: string): Parameters<MailWorkerNormal['handle']>[0] {
    return {
      id: 'job-1',
      attemptsMade: 0,
      queue: { name: 'mail:normal' },
      opts: { attempts: 5 },
      data: {
        template: 'custom',
        props: {},
        to: 'mottagare@exempel.invalid',
        organizationId,
        subject: 'Ämne',
      },
    } as unknown as Parameters<MailWorkerNormal['handle']>[0]
  }

  it('skickar när ventilen är ÖPPEN', async () => {
    const { worker, send } = byggWorker(fejkPrisma())
    await worker.handle(fejkJobb(ORG_ÖPPEN))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('skickar INTE när ventilen hunnit stängas medan jobbet låg i kön', async () => {
    const { worker, send } = byggWorker(fejkPrisma())
    // Kastar inte: ett kast hade gett fem Bull-retries och en FailedEmail-rad
    // för något som är en konfiguration, inte ett fel.
    await expect(worker.handle(fejkJobb(ORG_STÄNGD))).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('KANARIEFÅGEL — varje send*-metod bär org-id vidare till kön', () => {
  const KANARIE_ORG = 'org-kanariefagel'

  /**
   * Ett opts-objekt som svarar på vilken egenskap som helst med ett värde av
   * rätt SORT. Poängen är att kanariefågeln inte ska behöva veta vilka fält
   * varje mall råkar läsa — då hade den blivit en uppräkning som tystnar
   * exakt när någon lägger till en metod med nya fält.
   */
  function fejkOpts(): Record<string, unknown> {
    return new Proxy(
      {},
      {
        get(_mål, egenskap: string | symbol) {
          if (typeof egenskap !== 'string') return undefined
          // `await` sonderar efter .then — utan detta tolkas proxyn som en promise.
          if (egenskap === 'then') return undefined
          if (egenskap === 'organizationId') return KANARIE_ORG
          if (egenskap === 'to') return 'mottagare@exempel.invalid'
          if (/pdf|buffer/i.test(egenskap)) return Buffer.from('%PDF-1.4')
          if (/amount|total|rent|fee|percent|day|count|hour|balance|number$/i.test(egenskap)) {
            return 1
          }
          return `värde-${egenskap}`
        },
        has() {
          return true
        },
      },
    ) as Record<string, unknown>
  }

  it('vidarebefordrar organizationId från VARJE publik send*-metod', async () => {
    const enqueue = jest.fn().mockResolvedValue('job-1')
    const service = new MailService({ enqueue } as unknown as MailQueue)

    const metoder = Object.getOwnPropertyNames(MailService.prototype).filter(
      (namn) =>
        namn.startsWith('send') &&
        typeof (service as unknown as Record<string, unknown>)[namn] === 'function',
    )

    // Kanariefågelns egen kanariefågel: hittar reflektionen inga metoder är
    // testet grönt utan att ha mätt något alls. Talet är ett GOLV, inte en
    // uppräkning — nya metoder ska inte tvinga fram en redigering här, bara
    // ett borttaget lager ska.
    expect(metoder.length).toBeGreaterThanOrEqual(15)

    for (const namn of metoder) {
      enqueue.mockClear()
      const metod = (service as unknown as Record<string, (o: unknown) => Promise<string>>)[namn]
      await metod!.call(service, fejkOpts())

      expect(enqueue).toHaveBeenCalledTimes(1)
      const skickat = enqueue.mock.calls[0]?.[0] as EnqueueMailOptions
      expect({ metod: namn, organizationId: skickat.organizationId }).toEqual({
        metod: namn,
        organizationId: KANARIE_ORG,
      })
    }
  })
})
