// redact-copy-allow: testet innehåller MED FLIT en avskrift av den gamla
// hyresgäst-kopian som jämförelsepunkt, och en assertion som nämner
// `function redactSensitive` i en regex. Båda är beviset, inte defekten.
/**
 * HYRESGÄST-VÄGEN FÅR SAMMA SKYDDSNÄT SOM ÄGAR-VÄGEN (#545).
 *
 * `redactSensitive` fanns i två exemplar. Fältlistorna var identiska, men
 * `Prisma.Decimal`-grenen — tillagd i #168 (main 9f61bf1) — nådde bara
 * ägar-kopian. Hyresgäst-kopian rekurserade in i Decimalens interna
 * `{s,e,d}`-representation i sju månader.
 *
 * DET HÄR ÄR EN BETEENDEFÖRÄNDRING FÖR HYRESGÄST-VÄGEN, inte en no-op. Att den
 * var latent (verktygen konverterar sina belopp för hand vid varje anropsställe)
 * betyder bara att ingen hann falla i hålet — inte att hålet var igenfyllt.
 * Testet nedan mäter skillnaden: samma indata som förr gav decimal.js-internaler
 * ska nu komma ut som ett tal.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import { redactSensitive } from '../../common/redaction/redact-sensitive'

/** Den gamla hyresgäst-kopian, ordagrant — som jämförelsepunkt. */
function gammalTenantRedact<T>(value: T, depth = 0): T {
  const FÄLT = new Set(['personalNumber', 'passwordHash', 'token'])
  if (depth > 12) return value
  if (value === null || value === undefined) return value
  if (Array.isArray(value))
    return value.map((v) => gammalTenantRedact(v, depth + 1)) as unknown as T
  if (typeof value === 'object' && !(value instanceof Date) && !(value instanceof Buffer)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FÄLT.has(k)) continue
      out[k] = gammalTenantRedact(v, depth + 1)
    }
    return out as unknown as T
  }
  return value
}

describe('hyresgäst-vägen: Decimal kommer ut som tal, inte som internaler', () => {
  it('BEVIS PÅ SKILLNADEN: gamla kopian plattade ut Decimalen, den delade gör det inte', () => {
    const indata = { total: new Prisma.Decimal('1500.50') }

    // Så här såg det ut före sammanslagningen — Decimalen rekurserades in i.
    const före = gammalTenantRedact(indata)
    expect(typeof före.total).not.toBe('number')
    expect(JSON.stringify(före)).toMatch(/"s":|"e":|"d":\[/)

    // Och så här ser det ut nu.
    const efter = redactSensitive(indata)
    expect(efter.total).toBe(1500.5)
    expect(typeof efter.total).toBe('number')
    expect(JSON.stringify(efter)).not.toMatch(/"s":|"e":|"d":\[/)
  })

  it('ett Decimal-värde som slinker igenom hyresgäst-executorn normaliseras', async () => {
    // Ett verktygssvar som INTE handkonverterat sitt belopp — precis det fall
    // skyddsnätet finns för. Executorn kör redactSensitive på result.data.
    // Executorn anropas inte i sin helhet (den kräver Prisma, Bull och tre
    // tjänster). Testet nedanför verifierar i stället att den använder just den
    // här funktionen, så paret täcker vägen utan att bygga upp en halv app.
    const resultat = redactSensitive({
      invoiceNumber: 'F-2026-0001',
      subtotal: new Prisma.Decimal('8000'),
      vatTotal: new Prisma.Decimal('2000'),
      lines: [{ description: 'Hyra', amount: new Prisma.Decimal('10000') }],
    })
    expect(resultat.subtotal).toBe(8000)
    expect(resultat.vatTotal).toBe(2000)
    expect(resultat.lines[0]!.amount).toBe(10000)
    expect(JSON.stringify(resultat)).not.toMatch(/"s":|"e":|"d":\[/)
  })

  it('hyresgäst-executorn använder den DELADE funktionen, inte en egen', () => {
    const källa = readFileSync(join(__dirname, 'tenant-tool-executor.service.ts'), 'utf8')
    expect(källa).toContain("from '../../common/redaction/redact-sensitive'")
    expect(källa).not.toMatch(/function redactSensitive/)
    expect(källa).not.toMatch(/SENSITIVE_FIELD_NAMES\s*:\s*ReadonlySet/)
  })

  it('fältmaskeringen är oförändrad för hyresgäst-vägen', () => {
    const out = redactSensitive({
      id: 't1',
      firstName: 'Anna',
      personalNumber: '19900101-1234',
      passwordHash: 'x',
      sessionToken: 'y',
      magicLinkToken: 'z',
      apiKey: 'k',
    }) as Record<string, unknown>
    expect(out.firstName).toBe('Anna')
    for (const fält of [
      'personalNumber',
      'passwordHash',
      'sessionToken',
      'magicLinkToken',
      'apiKey',
    ]) {
      expect(out).not.toHaveProperty(fält)
    }
  })
})
