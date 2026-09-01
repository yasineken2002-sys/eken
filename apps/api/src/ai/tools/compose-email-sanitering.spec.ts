/**
 * `compose_and_send_email` SANERAR SIN BRÖDTEXT — och gör det med den DELADE
 * mekanismen, inte med en egen.
 *
 * ── VARFÖR DEN HÄR SPECEN BEHÖVS ────────────────────────────────────────────
 *
 * `base/Custom.tsx` renderar sin `bodyHtml` med `dangerouslySetInnerHTML` och
 * säger i sin egen docblock: *"Måste redan vara säker — sanitiseras inte."*
 * Ansvaret ligger alltså hos anroparen. `MessagesService` tog det; den här
 * vägen gjorde det inte alls, trots att den matar in MODELLFÖRFATTAD text i
 * exakt samma mall.
 *
 * ── VAD DEN MÄTER, OCH VAD DEN INTE KAN SE ──────────────────────────────────
 *
 * Den mäter vad som når `mailService.sendCustomEmail` — alltså den sträng
 * mallen kommer att rendera. Den kan INTE se vad en e-postklient till slut gör
 * med den strängen, och den säger ingenting om mallens eget omslag (#629).
 *
 * Den prövar heller inte `sanitize-html` som bibliotek. Sonderna är valda för
 * att falla på ALLOWLISTANS tre olika mekanismer — otillåten tagg, otillåtet
 * attribut, otillåtet schema — så att ett prov inte kan passera för att bara
 * en av dem råkar fungera.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Logger } from '@nestjs/common'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import { ToolExecutorService } from './tool-executor.service'
import { USER_HTML_OPTS } from '../../mail/user-html'

/** Markör som gör det otvetydigt vilken sträng ett utfall kommer ur. */
const MARKOR = 'sanerings-sond-9f3c1d'

type Utskick = { bodyHtml: string; accentColor?: string; subject: string }

function byggExecutor(invoiceColor: string | null, firstName = 'Eva') {
  const utskick: Utskick[] = []
  const prisma = {
    tenant: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'tenant-1',
          type: 'INDIVIDUAL',
          firstName,
          lastName: 'Ek',
          companyName: null,
          email: 'eva@example.se',
        },
      ]),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Hyresvärd AB', invoiceColor }),
    },
  }
  const mailService = {
    sendCustomEmail: jest.fn(async (opts: Utskick) => {
      utskick.push(opts)
      return 'job-1'
    }),
  }
  const redis = { client: { set: jest.fn().mockResolvedValue('OK'), ttl: jest.fn() } }
  const audit = {
    logToolExecution: jest.fn().mockResolvedValue(undefined),
    beginToolExecution: jest.fn().mockResolvedValue(undefined),
    completeToolExecution: jest.fn().mockResolvedValue(undefined),
  }

  // Object.create och inte konstruktorn: den tar 25 beroenden positionellt, och
  // ett tjugosjätte hade gjort specen röd av fel skäl. Metodkroppen är
  // produktionens.
  const executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
  Object.assign(executor, { prisma, mailService, redis, audit, logger: new Logger('spec') })
  return { executor, utskick }
}

const skicka = async (executor: ToolExecutorService, body: string) =>
  executor.executeTool(
    'compose_and_send_email',
    { tenantIds: ['tenant-1'], subject: 'Ämne', body, emailType: 'GENERAL' },
    'org-1',
    'user-1',
    'OWNER',
    { actionProof: { claimed: true } },
  )

describe('förutsättningar — sonderna måste faktiskt vara otillåtna', () => {
  // Läs tröskeln UR KODEN i stället för att anta den. Står någon av sonderna en
  // dag på allowlistan är provet meningslöst, och då ska DEN HÄR raden falla —
  // inte assertionen längre ned, som hade sett ut som ett saneringsfel.
  it.each(['script', 'img', 'b', 'iframe'])('taggen <%s> står INTE i allowlistan', (tagg) => {
    expect(USER_HTML_OPTS.allowedTags).not.toContain(tagg)
  })

  it('attributet onerror är inte tillåtet på <a>, och javascript: är inte ett tillåtet schema', () => {
    const attr = USER_HTML_OPTS.allowedAttributes
    expect(attr).not.toBe(false)
    expect((attr as Record<string, unknown[]>).a ?? []).not.toContain('onerror')
    expect(USER_HTML_OPTS.allowedSchemes).not.toContain('javascript')
  })
})

describe('compose_and_send_email — brödtexten saneras', () => {
  it('otillåten TAGG kastas — och taggens text blir kvar', async () => {
    const { executor, utskick } = byggExecutor('#123456')
    await skicka(executor, `Hej\n<b>${MARKOR}</b>`)

    expect(utskick).toHaveLength(1)
    const html = utskick[0]!.bodyHtml
    expect(html).not.toContain('<b>')
    // Texten ska INTE försvinna — disallowedTagsMode: 'discard' kastar taggen,
    // inte innehållet. Utan den här raden hade en sanerare som raderade allt
    // sett lika grön ut som en korrekt.
    expect(html).toContain(MARKOR)
  })

  it('script kastas HELT — tagg och innehåll', async () => {
    const { executor, utskick } = byggExecutor('#123456')
    await skicka(executor, `Hej\n<script>${MARKOR}</script>`)

    const html = utskick[0]!.bodyHtml
    expect(html).not.toContain('<script')
    // nonTextTags: innehållet ska INTE överleva som text här.
    expect(html).not.toContain(MARKOR)
  })

  it('otillåtet ATTRIBUT på en tillåten tagg kastas', async () => {
    const { executor, utskick } = byggExecutor('#123456')
    await skicka(executor, `<a href="https://example.se" onerror="${MARKOR}">länk</a>`)

    // Bara brödtexten: hälsningen är en egen fråga med ett eget prov ovan.
    const brödtext = utskick[0]!.bodyHtml.split('\n').slice(1).join('\n')
    expect(brödtext).not.toContain('onerror')
    expect(brödtext).not.toContain(MARKOR)
    // …men den tillåtna delen av samma tagg ska överleva, annars mäter provet
    // bara att något kastades.
    expect(brödtext).toContain('href="https://example.se"')
  })

  it('otillåtet SCHEMA i href kastas', async () => {
    const { executor, utskick } = byggExecutor('#123456')
    await skicka(executor, `<a href="javascript:${MARKOR}">klicka</a>`)

    expect(utskick[0]!.bodyHtml).not.toContain('javascript:')
  })

  it('hyresgästnamnet escapas i hälsningen', async () => {
    const { executor, utskick } = byggExecutor('#123456', '<img src=x onerror=alert(1)>Eva')
    await skicka(executor, 'Hej')

    const hälsning = utskick[0]!.bodyHtml.split('\n')[0]!

    // FORMKRAV, INTE SUBSTRÄNGSJAKT. `not.toContain('onerror')` hade fallit på
    // den ESCAPADE texten `&lt;img … onerror=alert(1)&gt;`, som är inert — ett
    // prov som inte skiljer escapat från levande mäter fel sak. Kravet här är
    // att hälsningen inte innehåller NÅGON tagg utöver sitt eget <p>…</p>.
    expect(hälsning).toMatch(/^<p>Hej [^<>]*,<\/p>$/)
    // Och att namnet faktiskt kom med, escapat — annars hade "namnet raderades"
    // också passerat.
    expect(hälsning).toContain('&lt;img')
  })

  it('{namn} substitueras FÖRE saneringen — namnets markup saneras också', async () => {
    // MARKUP-NAMNET MÅSTE SKICKAS IN HÄR. En tidigare version använde default-
    // namnet 'Eva' och var därför TOM: den förblev grön även med saneringen
    // helt borttagen, eftersom det inte fanns någon markup att sanera. Ett för
    // svagt prov ser ut precis som ett fungerande.
    const { executor, utskick } = byggExecutor('#123456', '<img src=x onerror=alert(1)>Eva')
    await skicka(executor, 'Hej {namn}, välkommen.')

    // Brödtexten, inte hälsningen — hälsningen escapas och har ett eget prov.
    const brödtext = utskick[0]!.bodyHtml.split('\n').slice(1).join('\n')
    expect(brödtext).toContain('välkommen')
    // Namnet gick in i bodyn via {namn} och passerade DÄRFÖR saneraren:
    // <img> står inte på allowlistan, så taggen ska vara borta helt — varken
    // levande (`<img`) eller escapad (`&lt;img`), eftersom saneraren kastar
    // taggen i stället för att escapa den.
    expect(brödtext).not.toContain('<img')
    expect(brödtext).not.toContain('&lt;img')
    expect(brödtext).toContain('Eva')
  })
})

describe('compose_and_send_email — accentColor valideras', () => {
  it('en accentColor som inte är en hex-färg faller tillbaka', async () => {
    // Sonden är formad som ett style-attributbrott, inte bara som skräptext.
    const { executor, utskick } = byggExecutor(`red;background:url(javascript:${MARKOR})`)
    await skicka(executor, 'Hej')

    expect(utskick[0]!.accentColor).toBe(DEFAULT_BRAND_COLOR)
    expect(utskick[0]!.accentColor).not.toContain(MARKOR)
  })

  it('en giltig hex-färg släpps igenom oförändrad', async () => {
    // Motprovet: utan det hade en validator som alltid returnerar fallbacken
    // sett lika grön ut.
    const { executor, utskick } = byggExecutor('#AABBCC')
    await skicka(executor, 'Hej')

    expect(utskick[0]!.accentColor).toBe('#AABBCC')
  })

  it('saknad invoiceColor ger fallbacken — inte undefined', async () => {
    const { executor, utskick } = byggExecutor(null)
    await skicka(executor, 'Hej')

    expect(utskick[0]!.accentColor).toBe(DEFAULT_BRAND_COLOR)
  })
})
