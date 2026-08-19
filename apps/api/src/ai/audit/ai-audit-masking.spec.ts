/**
 * VAKT (#508): ALLT SOM SKRIVS TILL AiToolExecution MÅSTE PASSERA MASKERINGEN.
 *
 * ── VARFÖR DEN HÄR TABELLEN FÅR SKÄRPAS NÄR ANDRA INTE FICK ────────────────
 *
 * `AiMessage` och `AiMemory` matas tillbaka in i modellen — historiken replayas
 * och minnet går in i systemprompten — så maskering vid SKRIVNING där är ett
 * irreversibelt arbetsminnesbortfall. Det var skälet till att #494 beslut 3a
 * och 3b avslogs, och det står fast. `AiToolExecution` skrivs och gallras;
 * ingenting läser tillbaka den till modellen eller till någon vy. Breddningen
 * kostar därför ingen funktion.
 *
 * ── MÄTNINGEN SOM STYRDE VAD SOM MASKERAS ──────────────────────────────────
 *
 * Prod 2026-08-19, 11 rader / 190 strängar:
 *
 *   6 e-postadresser   toolResult[].tenant.email + toolResult[].sentTo
 *   6 namnvärden       toolResult[].tenant.firstName / .lastName
 *   0 personnummer, 0 organisationsnummer, 0 telefonnummer, 0 gatuadresser
 *
 * Och det som INTE ska maskeras, funnet i samma mätning:
 *
 *   6 `name`-värden    lease.unit.name, lease.unit.property.name — en
 *                      lägenhetsbeteckning och ett fastighetsnamn, inte
 *                      personuppgifter, och det som gör spåret läsbart
 *   3 contractNumber   matchar av en slump ett postnummermönster
 *
 * Testerna nedan hävdar BÅDA riktningarna. En maskering som bara maskerar mer
 * är inte bevisat rätt — den kan ha ätit revisionsspåret.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { maskSensitivePatterns, sanitizeForAudit } from './ai-audit.service'

const SRC = join(__dirname, '..', '..')
const AUDIT_FIL = join('ai', 'audit', 'ai-audit.service.ts')

/** Skrivoperationer mot tabellen. Läsning och gallring är inte skrivning. */
const SKRIVNING = /\baiToolExecution\s*\.\s*(create|createMany|update|updateMany|upsert)\s*\(/g

function tsFiles(dir: string): string[] {
  const ut: string[] = []
  for (const namn of readdirSync(dir)) {
    const full = join(dir, namn)
    if (statSync(full).isDirectory()) {
      if (namn === 'generated' || namn === 'node_modules') continue
      ut.push(...tsFiles(full))
    } else if (namn.endsWith('.ts') && !namn.endsWith('.spec.ts')) {
      ut.push(full)
    }
  }
  return ut
}

export function skrivvagar(källa: string): string[] {
  return [...källa.matchAll(SKRIVNING)].map((m) => m[1]!)
}

describe('vakt: skrivvägen till AiToolExecution', () => {
  const filer = tsFiles(SRC)

  it('endast ai-audit.service.ts skriver till tabellen', () => {
    const träffar: string[] = []
    for (const fil of filer) {
      if (fil.endsWith(AUDIT_FIL)) continue
      for (const op of skrivvagar(readFileSync(fil, 'utf8'))) {
        träffar.push(`${fil.replace(SRC, 'src')} → aiToolExecution.${op}()`)
      }
    }
    expect(träffar).toEqual([])
  })

  it('audit-tjänstens skrivning föregås av sanitizeForAudit på BÅDA fälten', () => {
    const källa = readFileSync(join(SRC, AUDIT_FIL), 'utf8')
    const create = källa.indexOf('aiToolExecution.create(')
    expect(create).toBeGreaterThan(0)
    const före = källa.slice(0, create)
    expect(före).toMatch(/sanitizeForAudit\(args\.toolInput\)/)
    expect(före).toMatch(/sanitizeForAudit\(args\.toolResult\)/)
  })

  it('KANARIEFÅGEL: skanningen fäller en ny skrivväg', () => {
    // Utan det här kan reguljäruttrycket sluta matcha och vakten bli grön för
    // att den inte mäter något.
    expect(skrivvagar('await this.prisma.aiToolExecution.create({ data })')).toEqual(['create'])
    expect(skrivvagar('tx.aiToolExecution.updateMany({ where })')).toEqual(['updateMany'])
    // Läsning och gallring är INTE skrivning och ska inte fällas.
    expect(skrivvagar('this.prisma.aiToolExecution.findMany({})')).toEqual([])
    expect(skrivvagar('this.prisma.aiToolExecution.deleteMany({})')).toEqual([])
  })
})

describe('vakt: maskeringen fångar det prod-mätningen hittade', () => {
  it('KANARIEFÅGEL: en känslig sträng MÅSTE maskeras (bryts hjälparen blir detta rött)', () => {
    // Delad hjälpare → mata in något som måste ge utslag, och kräv utslaget.
    expect(maskSensitivePatterns('19800101-1234')).not.toContain('19800101')
    expect(maskSensitivePatterns('anna@exempel.se')).not.toContain('anna@exempel.se')
  })

  it('e-post maskeras oavsett fältnamn — mönster, inte fältlista', () => {
    // Mätningen fann adresser i BÅDE `tenant.email` och `sentTo`.
    const ut = sanitizeForAudit({
      tenant: { email: 'anna@exempel.se' },
      sentTo: 'bo@exempel.se',
      fritext: 'skickat till cecilia@exempel.se',
    }) as Record<string, unknown>
    expect(JSON.stringify(ut)).not.toMatch(/@exempel\.se/)
  })

  it('namn maskeras på fältnamn (ingen form att matcha på)', () => {
    const ut = sanitizeForAudit({ tenant: { firstName: 'Anna', lastName: 'Andersson' } })
    expect(JSON.stringify(ut)).not.toContain('Anna')
    expect(JSON.stringify(ut)).not.toContain('Andersson')
  })

  it('mobilnummer i de skrivsätt människor använder maskeras', () => {
    for (const nr of ['070-123 45 67', '070-1234567', '+46701234567', '0701234567']) {
      expect(maskSensitivePatterns(`ring ${nr}`)).not.toContain(nr)
    }
  })

  it('BEVARAT: lägenhets- och fastighetsnamn rörs inte — spåret ska gå att läsa', () => {
    const ut = sanitizeForAudit({
      lease: { unit: { name: 'Lägenhet 1201', property: { name: 'Ekhagen 3' } } },
    })
    expect(JSON.stringify(ut)).toContain('Lägenhet 1201')
    expect(JSON.stringify(ut)).toContain('Ekhagen 3')
  })

  it('BEVARAT: avtals-, fakturanummer och belopp rörs inte', () => {
    const ut = sanitizeForAudit({
      lease: { contractNumber: '123 45' },
      invoiceNumber: 'F-2026-0042',
      belopp: '10 000,50 kr',
    })
    expect(JSON.stringify(ut)).toContain('123 45')
    expect(JSON.stringify(ut)).toContain('F-2026-0042')
    expect(JSON.stringify(ut)).toContain('10 000,50 kr')
  })

  it('null i ett maskerat fält förblir null — "fanns inte" ≠ "fanns men dolt"', () => {
    const ut = sanitizeForAudit({ tenant: { email: null, phone: '' } }) as {
      tenant: { email: unknown; phone: unknown }
    }
    expect(ut.tenant.email).toBeNull()
    expect(ut.tenant.phone).toBe('')
  })
})
