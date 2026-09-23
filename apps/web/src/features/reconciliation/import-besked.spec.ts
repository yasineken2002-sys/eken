/**
 * VAD OPERATÖREN FÅR VETA EFTER EN IMPORT (#F034b).
 *
 * ── VARFÖR DET HÄR ÄR ETT EGET PROV ─────────────────────────────────────────
 *
 * Backend kan ha helt rätt och operatören ändå göra fel sak. Två utfall bär
 * hela risken:
 *
 *   DELVIS MISSLYCKAD  visas som "Import klar!" → ingen rättar filen, och de
 *                      rader som inte kunde läsas finns aldrig i bokföringen
 *   IMPORT PÅGÅR       visas som "kontrollera filformatet" → operatören byter
 *                      fil och kör igen, alltså gör en ANDRA import
 *
 * Båda är ett riktigt svar som säger fel sak. Det är den klassen den här filen
 * mäter.
 *
 * ── VARFÖR RENA FUNKTIONER OCH INTE DOM ─────────────────────────────────────
 *
 * Samma val som `psd2.api.ts` gör och av samma skäl: tolkningen ligger i
 * `importbesked` / `tolkaImportPagar`, inte i JSX, så frågan går att ställa
 * utan att rendera. Vad provet DÄRMED INTE ser är att komponenterna faktiskt
 * går genom funktionerna — går någon förbi och läser `result.forsok` direkt i
 * JSX är provet fortfarande grönt. Det bärs av att båda anropsställena
 * (`ReconciliationPage`, `PdfImportPreviewModal`) tar resultatet av funktionen
 * och inte objektet.
 */

import { describe, expect, it } from 'vitest'

import { importbesked, kontobesked, kontoläge, tolkaImportPagar } from './api/reconciliation.api'

describe('importbesked — vad operatören får veta', () => {
  it('KLAR utan uppspelning: normal rubrik, ingen extra text', () => {
    const b = importbesked({
      status: 'KLAR',
      replayed: false,
      forsokNr: 1,
      kordesAt: '2026-03-02T10:00:00.000Z',
    })
    expect(b.ton).toBe('klar')
    expect(b.rubrik).toBe('Import klar!')
    expect(b.text).toBeNull()
  })

  it('DELVIS säger uttryckligen att filen ska rättas — inte "klar"', () => {
    const b = importbesked({
      status: 'DELVIS',
      replayed: false,
      forsokNr: 1,
      kordesAt: '2026-03-02T10:00:00.000Z',
    })
    expect(b.ton).toBe('delvis')
    expect(b.rubrik).not.toContain('klar!')
    expect(b.text).toContain('Rätta filen')
    // Att täckningsdatumet INTE flyttades fram är en del av utfallet och ska
    // stå där — annars ser en pausad kravtrappa ut som en oförklarlig bugg.
    expect(b.text).toContain('flyttades inte fram')
  })

  it('uppspelat svar säger att INGA nya rader skapades, med klockslag', () => {
    const b = importbesked({
      status: 'KLAR',
      replayed: true,
      forsokNr: 2,
      kordesAt: '2026-03-02T09:30:00.000Z',
    })
    expect(b.ton).toBe('uppspelad')
    expect(b.rubrik).toContain('redan importerad')
    expect(b.text).toContain('Inga nya rader')
    // Klockslaget gör skillnad mellan "jag laddade upp fel fil" och "den här
    // filen kördes i morse".
    expect(b.text).toMatch(/2026-03-02/)
  })

  it('DELVIS vinner över replayed — ett partiellt utfall spelas aldrig upp', () => {
    // Backend sätter aldrig den kombinationen (bara SUCCEEDED spelas upp), men
    // om den någonsin uppstår ska UI:t säga det ALLVARLIGARE av de två.
    const b = importbesked({
      status: 'DELVIS',
      replayed: true,
      forsokNr: 3,
      kordesAt: '2026-03-02T09:30:00.000Z',
    })
    expect(b.ton).toBe('delvis')
  })

  it('SAKNAT fält påstår varken uppspelning eller partiellt utfall', () => {
    const b = importbesked(undefined)
    expect(b.ton).toBe('klar')
    expect(b.text).toBeNull()
  })

  it('OGILTIGT klockslag faller tillbaka på text utan tid — aldrig "Invalid Date"', () => {
    const b = importbesked({
      status: 'KLAR',
      replayed: true,
      forsokNr: 2,
      kordesAt: 'inte-ett-datum',
    })
    expect(b.text).not.toContain('Invalid')
    expect(b.text).toContain('tidigare körning')
  })
})

describe('tolkaImportPagar — 409 skiljs från allt annat', () => {
  const svar = (status: number, data: unknown) => ({ response: { status, data } })

  it('409 med IMPORT_PAGAR tolkas, och bär starttiden', () => {
    const p = tolkaImportPagar(
      svar(409, {
        code: 'IMPORT_PAGAR',
        message: 'Samma fil importeras redan just nu.',
        startadAt: '2026-03-02T10:00:00.000Z',
        forsokNr: 1,
      }),
    )
    expect(p?.code).toBe('IMPORT_PAGAR')
    expect(p?.startadAt).toBe('2026-03-02T10:00:00.000Z')
  })

  it('409 inpackat i { data } (TransformInterceptor) tolkas likadant', () => {
    const p = tolkaImportPagar(
      svar(409, { data: { code: 'IMPORT_PAGAR', startadAt: '2026-03-02T10:00:00.000Z' } }),
    )
    expect(p?.code).toBe('IMPORT_PAGAR')
  })

  it('NEGATIVKONTROLL: 409 med en ANNAN kod tolkas INTE som pågående import', () => {
    // 409 används av fler vägar. Att svälja alla hade gjort ett helt annat
    // konfliktfel till ett lugnande "vänta lite".
    expect(tolkaImportPagar(svar(409, { code: 'NAGOT_ANNAT' }))).toBeNull()
  })

  it('NEGATIVKONTROLL: 500 tolkas INTE som pågående import', () => {
    expect(tolkaImportPagar(svar(500, { code: 'IMPORT_PAGAR' }))).toBeNull()
  })

  it('NEGATIVKONTROLL: nätverksfel utan response tolkas INTE som pågående import', () => {
    // Ett avbrott mitt i uppladdningen ska synas som ett fel, inte som en
    // pågående körning operatören ska vänta på.
    expect(tolkaImportPagar(new Error('Network Error'))).toBeNull()
    expect(tolkaImportPagar(undefined)).toBeNull()
  })
})

describe('kontoläget — #F034c', () => {
  const aktivt = { id: 'k1', name: 'Företagskonto', accountNumber: '1234', isActive: true }
  const avvecklat = { id: 'k2', name: 'Gammalt', accountNumber: null, isActive: false }

  it('inga konton alls → "inga-konton", och beskedet säger LÄGG UPP', () => {
    expect(kontoläge([], null)).toBe('inga-konton')
    expect(kontobesked('inga-konton')).toContain('Lägg upp')
  })

  it('bara AVVECKLADE konton räknas som inga konton', () => {
    // Ett avvecklat konto går inte att välja. Att räkna det som valbart hade
    // gett operatören en lista där inget val fungerar.
    expect(kontoläge([avvecklat], null)).toBe('inga-konton')
  })

  it('konton finns men inget valt → "valj", och beskedet säger VÄLJ', () => {
    expect(kontoläge([aktivt], null)).toBe('valj')
    expect(kontobesked('valj')).toContain('Välj')
    // DE TVÅ BESKEDEN MÅSTE SKILJA SIG. "Lägg upp ett konto" och "välj ett
    // konto" leder till olika åtgärder, och samma text åt båda hade skickat
    // operatören fel.
    expect(kontobesked('valj')).not.toBe(kontobesked('inga-konton'))
  })

  it('valt konto som INTE finns i listan räknas som ovalt', () => {
    // Ett id som blivit kvar i state efter att kontot avvecklats eller raderats
    // ska inte se ut som ett giltigt val.
    expect(kontoläge([aktivt], 'k-borta')).toBe('valj')
    expect(kontoläge([avvecklat], 'k2')).toBe('inga-konton')
  })

  it('giltigt val → "valt", och då finns inget besked att visa', () => {
    expect(kontoläge([aktivt], 'k1')).toBe('valt')
    expect(kontobesked('valt')).toBeNull()
  })

  it('odefinierad lista (hämtningen pågår) behandlas som inga konton', () => {
    // Fail-closed: under laddning ska knappen inte gå att trycka.
    expect(kontoläge(undefined, null)).toBe('inga-konton')
  })
})
