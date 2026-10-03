/**
 * G21 (FORTNOX-100, BYGGLEDARE-EFFEKT-015): pdf-renderarens härdning prövad med RIKTIG Chrome
 * och en LOKAL, kontrollerad sond — inga externa anrop. Mäter:
 *   1. en självbärande mall (data:-bild) renderas som förut (positiv kontroll),
 *   2. en sida som försöker hämta från en literal IP-adress (127.0.0.1, sondens port) får
 *      INGEN förfrågan fram — sidnivåns spärr — och blockeringen loggas,
 *   3. Chrome startas med försvar-på-djupet-flaggorna.

 * KÖRS MED RIKTIG CHROME och ligger därför UTANFÖR src/ (jest:s rootDir): CI:s testjobb har
 * ingen Chrome, och vakterna (as never, pdf-mallar) granskar src/. Typkollas via
 * tsconfig.typecheck.json. Kör uttryckligen från apps/api:
 *   PUPPETEER_CACHE_DIR=… npx jest --rootDir . prov-manuella/pdf-natisolering.chrome.spec.ts
 * Samma logik prövas utan Chrome i pdf-natisolering.spec.ts (körs i CI).
 * Provet påstår INTE full nätisolering av Chromes egen bakgrundstrafik; den mäts separat
 * med socketsond i 100-lägenhetsriggen (bevis/provmiljo-003).
 */
jest.mock('../src/storage/storage.service', () => ({ StorageService: class {} }))

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PdfService } from '../src/invoices/pdf.service'

jest.setTimeout(60_000)

describe('G21: pdf-renderaren ringer inte ut', () => {
  let pdf: PdfService
  let sond: Server
  let port = 0
  let träffar = 0
  const varningar: string[] = []

  beforeAll(async () => {
    sond = createServer((_req, res) => {
      träffar++
      res.end('x')
    })
    await new Promise<void>((r) => sond.listen(0, '127.0.0.1', () => r()))
    port = (sond.address() as AddressInfo).port
    pdf = new PdfService({} as never, {} as never)
    Object.assign(pdf, {
      logger: {
        log: () => undefined,
        warn: (m: string) => varningar.push(m),
        error: () => undefined,
      },
    })
  })

  afterAll(async () => {
    await pdf.onModuleDestroy()
    await new Promise<void>((r) => sond.close(() => r()))
  })

  it('självbärande mall med data:-bild renderas (positiv kontroll)', async () => {
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    const buf = await pdf.generateFromHtml(
      `<html><body><h1>Avi</h1><img src="${png}"></body></html>`,
    )
    expect(buf.subarray(0, 4).toString()).toBe('%PDF')
    expect(varningar).toEqual([])
  })

  it('hämtning från literal IP (lokal sond) når aldrig fram och loggas', async () => {
    const buf = await pdf.generateFromHtml(
      `<html><body><img src="http://127.0.0.1:${port}/logo.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/s.css"></body></html>`,
    )
    expect(buf.subarray(0, 4).toString()).toBe('%PDF')
    expect(träffar).toBe(0)
    expect(varningar.join('\n')).toMatch(/extern resurs blockerad.*127\.0\.0\.1/)
  })

  it('Chrome startas med försvar-på-djupet-flaggorna', async () => {
    const browser = (pdf as unknown as { browser: { process(): { spawnargs: string[] } | null } })
      .browser
    const args = browser.process()?.spawnargs ?? []
    expect(args).toEqual(
      expect.arrayContaining([
        '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost',
        '--disable-quic',
        '--disable-component-update',
      ]),
    )
  })
})
