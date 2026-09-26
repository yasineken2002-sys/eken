/**
 * BILAGANS BYTES — härledningen av vad produkten faktiskt släpper fram.
 *
 * ── FRÅGAN ──────────────────────────────────────────────────────────────────
 *
 * Signaturunderlaget band bilderna via `storageKey`, `filename`, `caption`,
 * `room` och `size`. En granskning påpekade att ingen av dem beskriver
 * objektets INNEHÅLL. Det är sant, och `contentSha256` (v2) rättar det. Men
 * frågan som avgör hur allvarligt det var är en annan: kan någon PRODUKTVÄG
 * byta byten bakom en befintlig nyckel?
 *
 * ── VAD SOM MÄTS VAR ────────────────────────────────────────────────────────
 *
 * Lagringsportens semantik — att `PutObject` mot en befintlig nyckel byter
 * bytes utan att nyckel eller storlek behöver ändras — är MÄTT mot ett
 * syntetiskt objektlager genom skarp `StorageService`. Den mätningen ligger
 * INTE här, och skälet är konkret: ingen spec i det här repot importerar
 * `@aws-sdk/client-s3` på riktigt (`backup.service.spec.ts` mockar den), och
 * SDK:n drar in ett ESM-paket som projektets jest-konfiguration inte kan parsa.
 * Att lägga till `transformIgnorePatterns` för ett enda prov hade varit en
 * ombyggnad av testriggen för hela API:t.
 *
 * Mätningen kördes därför som ett fristående rigg-skript UTANFÖR repot, och
 * dess utdata är alltså inte granskningsbar härifrån. Resultatet, kort: porten
 * har ingen oföränderlighet, varken mot överskrivning eller radering — och det
 * är därför skyddet inte får vila på den.
 *
 * ── VAD SOM LÅSES HÄR ───────────────────────────────────────────────────────
 *
 * Det som avgör om porten spelar roll: att produkten inte exponerar någon väg
 * dit för en besiktningsbild. Det läses ur källan och låses nedan, så att en
 * framtida endpoint som tar emot en nyckel — eller återanvänder en befintlig —
 * blir röd i stället för tyst.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * HÄRLEDNINGEN: produkten exponerar ingen väg till mätningen ovan.
 *
 * Mätningen visar vad porten TILLÅTER. Den säger ingenting om vad produkten
 * SLÄPPER FRAM, och det är den frågan som avgör om bristen är verklig. Den
 * läses därför ur källan, och låses här så att en framtida endpoint som tar
 * emot en nyckel eller återanvänder en befintlig blir röd.
 */
describe('härledning: ingen produktväg kan peka ut en befintlig besiktningsnyckel', () => {
  const src = join(__dirname, '..')
  const läs = (p: string) => readFileSync(join(src, p), 'utf8')
  /** Blankar rad- och blockkommentarer så att prosa inte kan uppfylla en vakt. */
  const utanKommentarer = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // ÄNDRAD MEDVETET (OB5, CLAUDE1 2026-09-26): analysvägen tar nu emot en ÅTERFÖRSÖKSNYCKEL per
  // användarval och återanvänder en redan sparad bilaga för samma val. Vaktens fråga står kvar
  // oförändrad — kan en klient peka ut en BEFINTLIG lagringsnyckel? — och svaret ska fortfarande
  // vara nej:
  //   • varje uppladdad nyckel slutar på en ny server-uuid(), aldrig på klientdata;
  //   • klientens nyckel är ett UUID-validerat SEGMENT under <org>/<besiktning>/, aldrig en hel nyckel;
  //   • återanvändning gäller RADEN — ingen PutObject mot en befintlig nyckel (återanvända filer
  //     hoppas över före uppladdningen).
  // Blir något av detta falskt ska provet bli rött, som förut.
  it('besiktningsnyckeln myntas ur uuid() — aldrig ur klientdata', () => {
    // Blankstegsnormaliserad: formateringen får inte avgöra utfallet.
    const controller = utanKommentarer(läs('inspections/inspections.controller.ts')).replace(
      /\s+/g,
      ' ',
    )
    expect(controller).toContain(
      'const safeName = `${uuid()}.${extensionForDetectedMime(mimeType)}`',
    )
    expect(controller).toContain(
      'const storageKey = nyckel ? `${prefixFor(nyckel)}${safeName}` : `inspections/${orgId}/${safeName}`',
    )
    expect(controller).toContain(
      'const prefixFor = (nyckel: string) => `inspections/${orgId}/${id}/${nyckel}/`',
    )
    expect(controller).toContain('if (!ATERFORSOKSNYCKEL.test(nyckel))')
    // Återanvänd bilaga → ingen uppladdning: `continue` före `uploadFile`.
    expect(controller).toMatch(
      /if \(återanvända\.has\(i\)\) continue[\s\S]*?this\.storage\.uploadFile\(f\.buffer, storageKey, mimeType\)/,
    )
    // Ingen uppladdning till en nyckel läst ur en befintlig rad.
    expect(controller).not.toMatch(/uploadFile\([^)]*befintlig/)
    // Filnamnet klienten skickar används till `filename` (visning), aldrig till nyckeln.
    expect(controller).not.toMatch(/storageKey\s*=\s*`[^`]*\$\{f\.filename\}/)
  })

  it('digesten tas ur den uppladdade bufferten, inte ur en omläsning', () => {
    const controller = läs('inspections/inspections.controller.ts')
    expect(controller).toContain("createHash('sha256').update(f.buffer).digest('hex')")
  })

  it('INGEN DTO i hela API:t tar emot en storageKey', () => {
    // Skulle en endpoint börja ta emot en nyckel vore mätningen ovan en
    // produktväg, och `contentSha256` bara en upptäckt i efterhand.
    const träffar: string[] = []
    const gå = (rel: string) => {
      for (const e of readdirSync(join(src, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`
        if (e.isDirectory()) gå(r)
        else if (e.name.endsWith('.dto.ts') && läs(r).includes('storageKey')) träffar.push(r)
      }
    }
    gå('.')
    expect(träffar).toEqual([])
  })

  it('INGEN produktionskod någonstans raderar en enskild besiktningsbild', () => {
    // Svepet går över HELA api-källan, inte bara inspections-modulen, och
    // täcker `delete`, `deleteMany` och rå SQL mot tabellen. Kommentarer och
    // stränginnehåll blankas först — annars hade en kommentar som NÄMNER
    // `inspectionImage.delete` fällt provet, och en vakt som går att fälla med
    // prosa mäter inte koden.
    const träffar: string[] = []
    const gå = (rel: string) => {
      for (const e of readdirSync(join(src, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`
        if (e.isDirectory()) gå(r)
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
          const kod = utanKommentarer(läs(r))
          if (/inspectionImage\s*\.\s*delete(Many)?\b/.test(kod)) träffar.push(r)
          if (/DELETE\s+FROM\s+"?InspectionImage"?/i.test(kod)) träffar.push(r)
        }
      }
    }
    gå('.')
    expect(träffar).toEqual([])
  })
})
