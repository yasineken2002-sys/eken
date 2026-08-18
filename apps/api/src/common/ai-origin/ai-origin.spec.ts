/**
 * VAKTER FÖR AI-URSPRUNGET (#504).
 *
 * Två stycken, med olika uppgift:
 *
 *   A. FORMVAKTEN härleder skrivarna maskinellt ur källkoden och kräver att
 *      INGEN skriver en hårdkodad aktörstyp. En femte skrivare i morgon fastnar
 *      utan att någon behöver lägga till den i en lista — det är hela poängen,
 *      eftersom en lista över fyra namn är precis det som blir fel när det blir
 *      fem. (Se dev_uppraekning_som_argument: en uppräkning krymper tyst.)
 *
 *   B. BETEENDEVAKTEN kör de riktiga chokepoint-tjänsterna i och utanför
 *      AI-kontext och kräver AI respektive USER. Formvakten ensam skulle vara
 *      grön även om `resolveActorType` returnerade fel sak.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { runAsAi, resolveActorType, currentAiOrigin, aiOriginColumns } from './ai-origin.context'
import { InvoiceEventsService } from '../../invoices/invoice-events.service'
import { RentNoticeEventsService } from '../../avisering/rent-notice-events.service'

const SRC = join(__dirname, '..', '..')

/** Alla .ts-filer under src/, utom tester. Ingen filändelselista, inget urval. */
function allSourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return allSourceFiles(full)
    if (!full.endsWith('.ts') || full.endsWith('.spec.ts')) return []
    return [full]
  })
}

/**
 * En hårdkodad aktörstyp i en skrivning. Typannoteringar (`actorType: 'USER' |
 * 'SYSTEM',` i en signatur) är inte skrivningar och matchas inte — de har ett
 * `|` efter sig.
 */
const HARDCODED = /actorType:\s*('(?:USER|SYSTEM|WEBHOOK|AI)'|EventActorType\.\w+)\s*[,)]/

describe('A. formvakten: ingen skriver en hårdkodad aktörstyp', () => {
  const files = allSourceFiles()

  it('svepet hittar faktiskt källfiler', () => {
    // Utan den här raden är allt nedan grönt även om svepet returnerar tomt.
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((f) => f.endsWith('invoice-events.service.ts'))).toBe(true)
  })

  it('svepet ser aktörstyper över huvud taget', () => {
    // Kanariefågel: hittar mönstret inga `actorType:` alls är regexen trasig och
    // vakten mäter ingenting.
    const withActorType = files.filter((f) => readFileSync(f, 'utf8').includes('actorType:'))
    expect(withActorType.length).toBeGreaterThan(5)
  })

  it('varje aktörstyp går via resolveActorType', () => {
    const offenders = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ file, line: line.trim(), nr: i + 1 }))
        .filter(({ line }) => HARDCODED.test(line))
        .map(({ file, line, nr }) => `${file.replace(SRC, 'src')}:${nr}  ${line}`),
    )
    expect(offenders).toEqual([])
  })
})

describe('B. beteendevakten: kontexten avgör aktörstypen', () => {
  function makePrisma(captured: Record<string, unknown>[]) {
    const create = jest.fn(async (args: { data: Record<string, unknown> }) => {
      captured.push(args.data)
      return args.data
    })
    return {
      user: {
        findUnique: jest.fn().mockResolvedValue({ firstName: 'Anna', lastName: 'Svensson' }),
      },
      invoiceEvent: { create },
      rentNoticeEvent: { create },
    }
  }

  it('resolveActorType lämnar tillbaka anroparens typ utanför AI-vägen', () => {
    expect(resolveActorType('USER')).toBe('USER')
    expect(resolveActorType('SYSTEM')).toBe('SYSTEM')
    expect(currentAiOrigin()).toBeUndefined()
    expect(aiOriginColumns()).toEqual({})
  })

  it('resolveActorType ger AI inne i kontexten, oavsett vad anroparen bad om', () => {
    runAsAi('exec-1', () => {
      expect(resolveActorType('USER')).toBe('AI')
      expect(resolveActorType('SYSTEM')).toBe('AI')
      expect(aiOriginColumns()).toEqual({ aiToolExecutionId: 'exec-1' })
    })
  })

  it('kontexten läcker inte ut ur runAsAi', () => {
    runAsAi('exec-2', () => undefined)
    expect(currentAiOrigin()).toBeUndefined()
    expect(resolveActorType('USER')).toBe('USER')
  })

  it('kontexten överlever await-gränser', async () => {
    await runAsAi('exec-3', async () => {
      await new Promise((r) => setTimeout(r, 1))
      expect(resolveActorType('USER')).toBe('AI')
    })
  })

  // ── MÄNNISKOVÄGEN OCH AI-VÄGEN GENOM SAMMA TJÄNST ────────────────────────
  it('InvoiceEventsService: operatör → USER, AI → AI + referens', async () => {
    const human: Record<string, unknown>[] = []
    await new InvoiceEventsService(makePrisma(human) as never).record(
      'inv-1',
      'CREATED' as never,
      'USER',
      'user-1',
    )
    expect(human[0]!['actorType']).toBe('USER')
    expect(human[0]!['actorLabel']).toBe('Anna Svensson')
    expect(human[0]!['aiToolExecutionId']).toBeUndefined()

    const ai: Record<string, unknown>[] = []
    await runAsAi('exec-4', () =>
      new InvoiceEventsService(makePrisma(ai) as never).record(
        'inv-1',
        'CREATED' as never,
        'USER',
        'user-1',
      ),
    )
    expect(ai[0]!['actorType']).toBe('AI')
    expect(ai[0]!['actorLabel']).toBe('AI-assistenten')
    expect(ai[0]!['aiToolExecutionId']).toBe('exec-4')
  })

  it('RentNoticeEventsService: operatör → USER, AI → AI (utan referenskolumn)', async () => {
    const human: Record<string, unknown>[] = []
    await new RentNoticeEventsService(makePrisma(human) as never).record(
      'rn-1',
      'CREATED' as never,
      'USER',
      'user-1',
    )
    expect(human[0]!['actorType']).toBe('USER')

    const ai: Record<string, unknown>[] = []
    await runAsAi('exec-5', () =>
      new RentNoticeEventsService(makePrisma(ai) as never).record(
        'rn-1',
        'CREATED' as never,
        'USER',
        'user-1',
      ),
    )
    expect(ai[0]!['actorType']).toBe('AI')
    // Tabellen saknar kolumnen — den ska INTE dyka upp bara för att kontexten finns.
    expect(ai[0]!['aiToolExecutionId']).toBeUndefined()
  })
})
