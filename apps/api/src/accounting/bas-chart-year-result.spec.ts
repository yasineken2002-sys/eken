/**
 * ÅRETS RESULTAT-KONTOT MÅSTE FINNAS I DEN PLAN DET PEKAR PÅ (#704 PR 2).
 *
 * `YEAR_RESULT_ACCOUNT_BY_FORM` är en handskriven mappning bolagsform → konto-
 * nummer. Den kan inte härledas ur planen: HB/KB:s konto heter "Årets resultat,
 * delägare 1", så en exakt namnmatchning missar dem och en prefixmatchning gör
 * bokföringslogiken beroende av en kontotext.
 *
 * En handskriven mappning bredvid en lista den ska beskriva är precis den sorts
 * par som glider isär tyst: numret finns kvar i konstanten, kontot försvinner
 * ur planen, och årsstängningen faller först i drift — för just den bolagsform
 * ingen testade.
 *
 * ── VAD PROVEN KRÄVER, OCH VARFÖR TRE OCH INTE ETT ────────────────────────
 *
 *  1. Numret FINNS i bolagsformens plan. Fångar att ett konto tas bort.
 *  2. Kontot är EQUITY. Fångar att numret pekar om till något annat — ett
 *     resultat får inte balanseras mot ett kostnadskonto.
 *  3. Namnet börjar på "Årets resultat". Fångar att numret återanvänds för
 *     något annat inom eget kapital (2098 "Vinst eller förlust föregående år"
 *     ligger en siffra bort i AB-planen).
 *
 * OMFÅNGSKANARIE: mappningen måste täcka VARJE bolagsform i enumet, härlett ur
 * `CompanyForm` och inte ur mappningens egna nycklar — annars är provet grönt
 * för en form som aldrig prövas, och det är exakt luckan mappningen finns för.
 */
import { CompanyForm } from '@prisma/client'
import {
  YEAR_RESULT_ACCOUNT_BY_FORM,
  basChartFor,
  isResultAccountNumber,
  RESULT_ACCOUNT_MAX,
  RESULT_ACCOUNT_MIN,
} from './bas-chart'

const FORMER = Object.values(CompanyForm)

describe('#704 PR 2 · årets resultat-kontot per bolagsform', () => {
  it('OMFÅNG: mappningen täcker varje CompanyForm i enumet', () => {
    expect(FORMER.length).toBeGreaterThan(1)
    for (const form of FORMER) {
      expect(YEAR_RESULT_ACCOUNT_BY_FORM[form]).toBeDefined()
    }
    // Åt andra hållet också: ingen nyckel som inte är en bolagsform.
    expect(Object.keys(YEAR_RESULT_ACCOUNT_BY_FORM).sort()).toEqual([...FORMER].sort())
  })

  it.each(FORMER)('%s: kontot finns, är EQUITY och heter "Årets resultat…"', (form) => {
    const number = YEAR_RESULT_ACCOUNT_BY_FORM[form]
    const konto = basChartFor(form).find((a) => a.number === number)

    expect(konto).toBeDefined()
    expect(konto?.type).toBe('EQUITY')
    expect(konto?.name).toMatch(/^Årets resultat/)
  })

  it('kontot ligger UTANFÖR resultatkontomängden — annars nollar det sig självt', () => {
    // Det är inte en formalitet: låg motkontot i 3000–8999 hade nollställningen
    // tagit med det i mängden och plug-posten hade gått mot sig själv.
    for (const form of FORMER) {
      expect(isResultAccountNumber(YEAR_RESULT_ACCOUNT_BY_FORM[form])).toBe(false)
    }
  })

  it('resultatkontomängdens gränser är BAS klass 3–8', () => {
    expect([RESULT_ACCOUNT_MIN, RESULT_ACCOUNT_MAX]).toEqual([3000, 8999])
    expect(isResultAccountNumber(2999)).toBe(false)
    expect(isResultAccountNumber(3000)).toBe(true)
    expect(isResultAccountNumber(8999)).toBe(true)
    expect(isResultAccountNumber(9000)).toBe(false)
  })

  it('#716: de två oeniga kontona ligger i mängden, oavsett vilken partition man frågar', () => {
    // 8131/8313 har type=REVENUE men nummerklass 4–8. Poängen med den
    // nummerbaserade mängden är att de ingår ÄNDÅ — det är riktningen, inte
    // medlemskapet, som partitionerna är oeniga om.
    expect(isResultAccountNumber(8131)).toBe(true)
    expect(isResultAccountNumber(8313)).toBe(true)
    const ab = basChartFor('AB')
    expect(ab.find((a) => a.number === 8131)?.type).toBe('REVENUE')
    expect(ab.find((a) => a.number === 8313)?.type).toBe('REVENUE')
  })
})
