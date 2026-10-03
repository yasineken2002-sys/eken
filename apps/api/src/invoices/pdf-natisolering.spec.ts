/**
 * G21 (FORTNOX-100, BYGGLEDARE-EFFEKT-015): pdf-renderarens härdning utan riktig Chrome
 * (CI:s testjobb har ingen). Puppeteer är attrapp; provet läser vad PdfService FAKTISKT
 * ber om: startflaggorna och sidans förfrågningshanterare. Samma beteende mot riktig Chrome
 * och lokal sond prövas i prov-manuella/pdf-natisolering.chrome.spec.ts (körs uttryckligen, bevis i
 * 100-lägenhetsriggen).
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('puppeteer', () => ({ __esModule: true, default: { launch: jest.fn() } }))

import puppeteer from 'puppeteer'
import { PdfService } from './pdf.service'

type Hanterare = (req: {
  url(): string
  continue(): Promise<void>
  abort(r?: string): Promise<void>
}) => void

describe('G21: pdf-renderarens nätspärr (utan Chrome)', () => {
  let hanterare: Hanterare | null = null
  let interception = false
  const varningar: string[] = []
  let launchArgs: string[] = []
  let pdf: PdfService

  beforeEach(() => {
    hanterare = null
    interception = false
    varningar.length = 0
    jest.mocked(puppeteer.launch).mockImplementation((async (opts: { args?: string[] }) => {
      launchArgs = opts.args ?? []
      return {
        connected: true,
        on: jest.fn(),
        close: jest.fn(),
        newPage: async () => ({
          setRequestInterception: async (v: boolean) => {
            interception = v
          },
          on: (ev: string, fn: Hanterare) => {
            if (ev === 'request') hanterare = fn
          },
          setContent: async () => undefined,
          pdf: async () => Buffer.from('%PDF-attrapp'),
          close: async () => undefined,
        }),
      }
    }) as never)
    pdf = new PdfService({} as never, {} as never)
    Object.assign(pdf, {
      logger: {
        log: () => undefined,
        warn: (m: string) => varningar.push(m),
        error: () => undefined,
      },
    })
  })

  it('Chrome startas med försvar-på-djupet-flaggorna', async () => {
    await pdf.generateFromHtml('<html></html>')
    expect(launchArgs).toEqual(
      expect.arrayContaining([
        '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost',
        '--disable-quic',
        '--disable-component-update',
      ]),
    )
  })

  it('sidan får request-interception; data: och about:blank släpps, allt annat avbryts och loggas', async () => {
    await pdf.generateFromHtml('<html></html>')
    expect(interception).toBe(true)
    expect(hanterare).not.toBeNull()
    const utfall: string[] = []
    const req = (url: string) => ({
      url: () => url,
      continue: async () => void utfall.push(`continue ${url}`),
      abort: async (r?: string) => void utfall.push(`abort ${url} ${r}`),
    })
    for (const u of [
      'data:image/png;base64,AAAA',
      'about:blank',
      'http://127.0.0.1:9/x.png',
      'https://fonts.example/a.css',
    ])
      hanterare!(req(u))
    expect(utfall).toEqual([
      'continue data:image/png;base64,AAAA',
      'continue about:blank',
      'abort http://127.0.0.1:9/x.png blockedbyclient',
      'abort https://fonts.example/a.css blockedbyclient',
    ])
    expect(varningar.join('\n')).toMatch(/extern resurs blockerad.*127\.0\.0\.1/)
  })
})
