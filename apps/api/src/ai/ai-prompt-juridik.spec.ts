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
      // #382 PR4: spärren måste följa med när numren byter lag. De gamla raderna
      // ovan skyddar inte mot att någon skriver in 2023:200:s lagrum i stället —
      // och en spärr som bara känner den upphävda lagen är ingen spärr.
      expect(SYSTEM_PROMPT).not.toContain('10 kap. 35 §')
      expect(SYSTEM_PROMPT).not.toContain('12 kap. 5 §')
      expect(SYSTEM_PROMPT).not.toContain('13 kap. 6 §')
      expect(SYSTEM_PROMPT).not.toContain('17 kap. 24 §')
      expect(SYSTEM_PROMPT).not.toContain('(2023:200)')
      // #392/#396: samma sak igen, för de lagrum som blev människoverifierade när
      // F-skatt-påståendet och uppsägningstiden rättades. Underlaget är belagt och
      // står i kodkommentarer (invoice-pdf.template.ts resp. noten ovanför
      // SYSTEM_PROMPT) — men det får inte vandra in i prompten.
      expect(SYSTEM_PROMPT).not.toContain('2011:1244') // skatteförfarandelagen
      expect(SYSTEM_PROMPT).not.toContain('2011:1261') // skatteförfarandeförordningen
      expect(SYSTEM_PROMPT).not.toContain('2012:978') // uthyrning av egen bostad
      expect(SYSTEM_PROMPT).not.toContain('10 kap. 12 §')
      expect(SYSTEM_PROMPT).not.toContain('12 kap. 4 §')
      // #382-restposterna: de lagrum som ersatte 1 kap 1 § och 3 kap 3 § 6 när de
      // sista gamla ML-numren rättades. Formtestet nedan fångar dem redan — det
      // här är dokumentationen av vilka nummer som faktiskt rörts.
      expect(SYSTEM_PROMPT).not.toContain('2 kap. 12 §')
      expect(SYSTEM_PROMPT).not.toContain('16 kap. 23 §')
      expect(SYSTEM_PROMPT).not.toContain('10 kap. 36 §')
    })

    // Uppräkningarna ovan dokumenterar VILKA fel som begåtts, men de kan bara
    // fånga nummer någon redan hunnit skriva fel. Den här testen är den
    // egentliga spärren: den förbjuder FORMEN, inte enskilda siffror, så nya
    // paragrafnummer fångas utan att någon först måste lägga till dem här.
    it('innehåller inga paragraf- eller SFS-nummer alls — utom ALDRIG-regelns exempel', () => {
      const paragraphCitations = SYSTEM_PROMPT.match(/\d+\s*kap\.?\s*\d+\s*[a-z]?\s*§/gi) ?? []
      // Exakt EN träff är tillåten: exemplet i ALDRIG-regeln, som visar modellen
      // hur ett förbjudet citat ser ut. Allt utöver det är ett nytt påstående.
      expect(paragraphCitations).toEqual(['12 kap 20 §'])
      expect(SYSTEM_PROMPT).toMatch(/t\.ex\. "12 kap 20 § JB"/)
      // SFS-nummer har ingen legitim plats i prompten över huvud taget.
      expect(SYSTEM_PROMPT.match(/\(\d{4}:\d+\)/g)).toBeNull()
    })

    it('påstår inte längre den felaktiga uppsägningstiden för bostad', () => {
      // Fel i SAK (#396): bostadens uppsägningstid är tre månader för BÅDA
      // parter; 3–9-spannet blandade in lokalens nio månader.
      expect(SYSTEM_PROMPT).not.toMatch(/3-9 månader/)
      expect(SYSTEM_PROMPT).not.toMatch(/3–9 månader/)
      expect(SYSTEM_PROMPT).not.toMatch(/månader från hyresvärd/)
      // ...och säger i stället det belagda, i klartext.
      expect(SYSTEM_PROMPT).toMatch(/samma tid för båda parter/i)
      expect(SYSTEM_PROMPT).toMatch(/LOKAL har nio månader/)
      // Hyresgästens tvingande tremånadersrätt och privatuthyrningens egna tider.
      expect(SYSTEM_PROMPT).toMatch(/binder därför i praktiken bara hyresvärden/i)
      expect(SYSTEM_PROMPT).toMatch(/privatuthyrning/i)
      expect(SYSTEM_PROMPT).toMatch(/tenancyRegime/)
      // Och ber användaren kontrollera regelverk + avtal i stället för att lita
      // på en generell siffra.
      expect(SYSTEM_PROMPT).toMatch(/Kontrollera ALLTID vilket regelverk/)
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

    // Hyresgästprompten är helt fri från paragrafcitat — inget "så här får du
    // INTE skriva"-exempel behövs där. Lås det, så gäller formspärren båda
    // prompterna och inte bara operatörens (#392/#396).
    it('innehåller inga paragraf- eller SFS-nummer alls', () => {
      expect(TENANT_SYSTEM_PROMPT.match(/\d+\s*kap\.?\s*\d+\s*[a-z]?\s*§/gi)).toBeNull()
      expect(TENANT_SYSTEM_PROMPT.match(/\(\d{4}:\d+\)/g)).toBeNull()
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
