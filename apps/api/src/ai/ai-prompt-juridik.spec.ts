import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Skyddsnät för avväpningen av farlig/felaktig juridik i AI-prompterna.
 *
 * Bakgrund: produkt-AI:ns systemprompter innehöll juridik skriven som
 * auktoritativa fakta — bl.a. ett DIREKT FEL om besittningsskydd ("inträder
 * efter 2 år för bostäder") samt hårdkodade SFS-nummer/lagrum och exakta
 * skattesiffror presenterade som garanterat korrekta. Projektregeln: AI:n får
 * aldrig skriva SFS-nummer/lagrum (eller exakta belopp) som fakta utan mänsklig
 * verifiering. Den här testen låser fast att de farliga formuleringarna är borta
 * och att besittningsskyddet uttrycks korrekt — utan att kräva RAG.
 *
 * Vi läser KÄLLTEXTEN (inte den importerade modulen) för att slippa dra in
 * hela tjänstens beroendeträd (S3/Puppeteer m.m.) bara för en sträng-assertion.
 */
const OPERATOR_SRC = readFileSync(join(__dirname, 'ai-assistant.service.ts'), 'utf8')
const TENANT_SRC = readFileSync(join(__dirname, 'tenant-ai.service.ts'), 'utf8')
const TENANT_TOOL_SRC = readFileSync(
  join(__dirname, 'tools', 'tenant-tool-executor.service.ts'),
  'utf8',
)

// Isolera själva prompt-literalerna så vi inte råkar matcha kommentarer i koden.
function extractTemplate(src: string, marker: string): string {
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`Hittade inte "${marker}" i källan`)
  const tickStart = src.indexOf('`', start)
  const tickEnd = src.indexOf('`', tickStart + 1)
  return src.slice(tickStart + 1, tickEnd)
}

const SYSTEM_PROMPT = extractTemplate(OPERATOR_SRC, 'export const SYSTEM_PROMPT =')
const TENANT_SYSTEM_PROMPT = extractTemplate(TENANT_SRC, 'export const TENANT_SYSTEM_PROMPT =')

describe('AI-systemprompt — avväpnad juridik', () => {
  describe('Operatör (SYSTEM_PROMPT)', () => {
    it('innehåller INTE det felaktiga "2 år för bostäder"-påståendet', () => {
      expect(SYSTEM_PROMPT).not.toMatch(/inträder efter 2 år för bostäder/i)
      expect(SYSTEM_PROMPT).not.toMatch(/besittningsskyddet inträder efter 2 år/i)
    })

    it('uttrycker besittningsskydd korrekt: förstahand från början, tvåår = andrahand', () => {
      expect(SYSTEM_PROMPT).toMatch(/förstahands?-?bostadshyresgäst/i)
      expect(SYSTEM_PROMPT).toMatch(/från (början|BÖRJAN)/)
      expect(SYSTEM_PROMPT).toMatch(/andrahand/i)
      expect(SYSTEM_PROMPT).toMatch(/två år i följd/i)
    })

    it('citerar inte längre specifika SFS-nummer/lagrum som fakta', () => {
      expect(SYSTEM_PROMPT).not.toContain('ML 3 kap 2 §')
      expect(SYSTEM_PROMPT).not.toContain('Mervärdesskattelagen 9 kap. 1 §')
      expect(SYSTEM_PROMPT).not.toContain('12:20 JB')
      expect(SYSTEM_PROMPT).not.toContain('(1981:739)')
    })

    it('innehåller inte längre föråldrade exakta skattesiffror ur minnet', () => {
      expect(SYSTEM_PROMPT).not.toContain('9 525')
      expect(SYSTEM_PROMPT).not.toContain('1 421')
      expect(SYSTEM_PROMPT).not.toMatch(/ROT-avdrag: 30%/)
      expect(SYSTEM_PROMPT).not.toMatch(/ca 300 kr i ansökningsavgift/)
    })

    it('instruerar att rekommendera jurist och inte citera lagrum/belopp som säkra', () => {
      expect(SYSTEM_PROMPT).toMatch(/jurist/i)
      expect(SYSTEM_PROMPT).toMatch(/ALDRIG ett specifikt lagrum/i)
    })
  })

  describe('Hyresgäst (TENANT_SYSTEM_PROMPT)', () => {
    it('citerar inte längre "Hyreslagen 12 kap. Jordabalken" som auktoritativ fakta', () => {
      expect(TENANT_SYSTEM_PROMPT).not.toContain('strider mot Hyreslagen 12 kap. Jordabalken')
      expect(TENANT_SYSTEM_PROMPT).not.toContain('UPPSÄGNINGSREGLER (Hyreslagen 12 kap. JB)')
    })

    it('rekommenderar jurist/hyresvärd och avråder från att citera lagrum/belopp som säkra', () => {
      expect(TENANT_SYSTEM_PROMPT).toMatch(/jurist|Hyresgästföreningen/i)
      expect(TENANT_SYSTEM_PROMPT).toMatch(/ALDRIG ett specifikt lagrum/i)
    })

    it('hänvisar till hyresgästens eget kontrakt för uppsägningstid', () => {
      expect(TENANT_SYSTEM_PROMPT).toMatch(/get_my_lease/)
    })
  })

  describe('request_termination — verktygs-output (confirm + resultat)', () => {
    it('citerar inte längre "Hyreslagen 12 kap. JB" som fakta i confirm-detaljen', () => {
      expect(TENANT_SRC).not.toContain('godkänna enligt Hyreslagen 12 kap. JB')
      // Behåller funktionen: statusen är fortfarande PRELIMINÄR och kräver hyresvärdens godkännande
      expect(TENANT_SRC).toContain('Preliminär — hyresvärden måste godkänna')
    })

    it('citerar inte längre "Hyreslagen 12 kap. JB" som fakta i resultat-meddelandet', () => {
      expect(TENANT_TOOL_SRC).not.toContain('bekräftat den enligt Hyreslagen 12 kap. JB')
      // Behåller funktionen: begäran är fortfarande PRELIMINÄR tills hyresvärden bekräftar
      expect(TENANT_TOOL_SRC).toContain('Begäran är PRELIMINÄR')
      expect(TENANT_TOOL_SRC).toContain('hyreslagens regler om uppsägning')
    })
  })
})
