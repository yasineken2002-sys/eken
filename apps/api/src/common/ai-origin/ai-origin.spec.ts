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
 *
 *   C. UPPDRAGSGIVARGRINDEN (G1 steg 2) kräver att en AI-körning inte kan
 *      STARTA utan deklarerad uppdragsgivare. Två mekanismer med olika
 *      räckvidd — typen och kontrollen i körtid — och de prövas var för sig,
 *      eftersom ett prov som bara visar att det FUNGERAR inte skiljer två
 *      mekanismer från en.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import {
  runAsAi,
  resolveActorType,
  currentAiOrigin,
  currentAiPrincipal,
  aiOriginColumns,
  assertUppdragsgivare,
} from './ai-origin.context'
import type { AiPrincipal } from './ai-origin.context'
import { InvoiceEventsService } from '../../invoices/invoice-events.service'
import { RentNoticeEventsService } from '../../avisering/rent-notice-events.service'

/** Uppdragsgivaren de mekaniska proven kör som. Formkraven prövas separat. */
const UPPDRAGSGIVARE: AiPrincipal = { kind: 'USER', id: 'user-1' }

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
    runAsAi('exec-1', UPPDRAGSGIVARE, () => {
      expect(resolveActorType('USER')).toBe('AI')
      expect(resolveActorType('SYSTEM')).toBe('AI')
      expect(aiOriginColumns()).toEqual({ aiToolExecutionId: 'exec-1' })
    })
  })

  it('kontexten läcker inte ut ur runAsAi', () => {
    runAsAi('exec-2', UPPDRAGSGIVARE, () => undefined)
    expect(currentAiOrigin()).toBeUndefined()
    expect(resolveActorType('USER')).toBe('USER')
  })

  it('kontexten överlever await-gränser', async () => {
    await runAsAi('exec-3', UPPDRAGSGIVARE, async () => {
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
    await runAsAi('exec-4', UPPDRAGSGIVARE, () =>
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
    await runAsAi('exec-5', UPPDRAGSGIVARE, () =>
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

describe('C. uppdragsgivargrinden: en AI-körning utan uppdragsgivare startar inte', () => {
  // ── VARFÖR TYPEN OCH KONTROLLEN PRÖVAS VAR FÖR SIG ────────────────────────
  //
  // De har olika räckvidd, och ett prov som bara visar att `runAsAi` fungerar
  // kan inte skilja dem åt. Typen fäller vid BYGGET — den kan därför inte
  // prövas med en assertion, bara med en negativ kontroll som visar att
  // `pnpm typecheck` faller (den står i PR-texten, med utfallet). Kontrollen i
  // körtid fäller det typen inte kan se: ett `as never`, en attrapp, en
  // anropare som kommer utifrån TypeScript.
  //
  // Vad C INTE kan se: att `runAsAi` faktiskt anropas vid AI-gränsen. Det ägs
  // av `check-ai-tool-effects` (vakten läser källtexten) och av
  // beteendevakten B ovan, som kör de riktiga tjänsterna genom kontexten.

  it('KONTROLLEN I KÖRTID: ett kringgånget typkrav fäller ändå', () => {
    // `as never` är exakt vägen förbi typen — och den finns redan på flera
    // ställen i kodbasen där attrapper trängs in i riktiga signaturer.
    expect(() => runAsAi('exec-x', undefined as never, () => 1)).toThrow(/utan uppdragsgivare/)
    expect(() => runAsAi('exec-x', null as never, () => 1)).toThrow(/utan uppdragsgivare/)
  })

  it('ett OKÄNT slag fäller — en etikett är inte samma sak som ett subjekt', () => {
    expect(() => runAsAi('exec-x', { kind: 'SYSTEM', id: 'a' } as never, () => 1)).toThrow(
      /okänt uppdragsgivarslag/,
    )
    expect(() => runAsAi('exec-x', { id: 'a' } as never, () => 1)).toThrow(
      /okänt uppdragsgivarslag/,
    )
  })

  it('ett TOMT id fäller — ett fält som finns men är blankt är inte ifyllt', () => {
    // Den här grenen är skälet till att kontrollen inte bara är en null-check.
    // `{ kind: 'USER', id: '' }` passerar typen utan invändning.
    expect(() => runAsAi('exec-x', { kind: 'USER', id: '' }, () => 1)).toThrow(
      /utan uppdragsgivar-id/,
    )
    expect(() => runAsAi('exec-x', { kind: 'TENANT', id: '   ' }, () => 1)).toThrow(
      /utan uppdragsgivar-id/,
    )
  })

  it('MOTPROV: kontrollen SLÄPPER IGENOM en giltig uppdragsgivare', () => {
    // Utan den här raden är proven ovan lika gröna om `assertUppdragsgivare`
    // kastade på allting — en sond som bara ger utslag mäter lika lite som en
    // som aldrig gör det.
    expect(runAsAi('exec-ok', { kind: 'USER', id: 'user-1' }, () => 'kördes')).toBe('kördes')
    expect(runAsAi('exec-ok', { kind: 'TENANT', id: 'tenant-1' }, () => 'kördes')).toBe('kördes')
    expect(() => assertUppdragsgivare({ kind: 'USER', id: 'user-1' })).not.toThrow()
  })

  it('DEN KASTAR, DEN VARNAR INTE — och fn körs aldrig', () => {
    // Skillnaden mellan en grind och en anteckning. Kördes callbacken ändå
    // vore kontrollen en logg, och skrivningarna hade skett utan känd aktör.
    const kördes = jest.fn()
    expect(() => runAsAi('exec-x', undefined as never, kördes)).toThrow()
    expect(kördes).not.toHaveBeenCalled()
  })

  it('uppdragsgivaren går att LÄSA inne i kontexten, och läcker inte ut', () => {
    // `currentAiPrincipal` är det G1 steg 3 läser när det varaktiga
    // aktörsslaget ska skrivas på domänraden.
    expect(currentAiPrincipal()).toBeUndefined()
    runAsAi('exec-1', { kind: 'TENANT', id: 'tenant-7' }, () => {
      expect(currentAiPrincipal()).toEqual({ kind: 'TENANT', id: 'tenant-7' })
      expect(currentAiOrigin()?.aiToolExecutionId).toBe('exec-1')
    })
    expect(currentAiPrincipal()).toBeUndefined()
  })

  it('DE TVÅ AI-GRÄNSERNA DEKLARERAR OLIKA SLAG — härlett ur källkoden', () => {
    // Ett prov som bara läste ägarvägen hade varit grönt även om
    // hyresgästvägen skrev USER med ett Tenant.id. Formen härleds därför ur
    // källan, inte ur en lista jag skrivit.
    const gränser = allSourceFiles()
      .map((f) => [f, readFileSync(f, 'utf8')] as const)
      .filter(([, kod]) => /\brunAsAi\(/.test(kod))

    // Kanariefågel: hittar svepet ingenting är provet grönt av tomhet.
    expect(gränser.length).toBeGreaterThanOrEqual(2)

    const slag = gränser.flatMap(([, kod]) =>
      [...kod.matchAll(/runAsAi\([^,]+,\s*\{\s*kind:\s*'(\w+)'/g)].map((m) => m[1]),
    )
    expect(new Set(slag)).toEqual(new Set(['USER', 'TENANT']))
  })
})
