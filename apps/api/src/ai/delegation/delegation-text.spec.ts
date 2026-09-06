import {
  DELEGATION_VERKTYGSTEXT,
  delegationVerktygstext,
  delegationVillkorstext,
  delegationFrekvenstext,
} from '@eken/shared'

import { delegerbaraVerktyg } from './delegation-scope'

/**
 * KLARTEXTEN TÄCKER EXAKT DE DELEGERBARA VERKTYGEN.
 *
 * ── DEN HÄR SPECEN ÄR KOPPLINGEN, INTE EN FORMALITET ────────────────────────
 *
 * `@eken/shared` känner inte till effektkatalogen och kan därför inte veta
 * vilka verktyg som är delegerbara. Kartan i `delegation-text.ts` är alltså en
 * lista någon skrev — tills den här specen binder den till `delegerbaraVerktyg()`,
 * som HÄRLEDS ur `EFFECT_DECLARATIONS`.
 *
 * ── BÅDA RIKTNINGARNA, OCH VARFÖR DEN ANDRA BEHÖVS ──────────────────────────
 *
 * Framåt: ett nytt delegerbart verktyg utan text hade renderat sitt TEKNISKA
 * namn i en rättighetslista — `update_maintenance_status` där det ska stå
 * "ändra status på ett ärende".
 *
 * Bakåt: en text för något som INTE är delegerbart är en post som ser ut som en
 * rättighet man kan ge. Den riktningen är den som gör provet till en spärr —
 * utan den kan kartan växa fritt och ingen märker att den beskriver verktyg
 * ingen kan delegera. Samma regel som baslinjernas STALE-halva.
 *
 * ── VAD DEN INTE MÄTER ──────────────────────────────────────────────────────
 *
 * Att texterna är BRA svenska, och att de står i att-form. Det ägs av läsning.
 * Här mäts mängden, inte formuleringen.
 */
describe('delegationens klartext', () => {
  const delegerbara = delegerbaraVerktyg()

  it('KANARIEFÅGEL: mängden är inte tom — annars mäter jämförelserna ingenting', () => {
    expect(delegerbara.length).toBeGreaterThan(0)
    expect(Object.keys(DELEGATION_VERKTYGSTEXT).length).toBeGreaterThan(0)
  })

  it('varje DELEGERBART verktyg har en text (framåt)', () => {
    const utan = delegerbara.filter((n) => !DELEGATION_VERKTYGSTEXT[n])
    expect(utan).toEqual([])
  })

  it('ingen text beskriver något som INTE är delegerbart (bakåt)', () => {
    const övriga = Object.keys(DELEGATION_VERKTYGSTEXT).filter((n) => !delegerbara.includes(n))
    expect(övriga).toEqual([])
  })

  it('MEDLEMMAR, inte antal — mängderna är identiska', () => {
    expect(Object.keys(DELEGATION_VERKTYGSTEXT).sort()).toEqual([...delegerbara].sort())
  })

  it('texten är aldrig det tekniska namnet — då hade kartan varit dekoration', () => {
    for (const n of delegerbara) {
      expect(DELEGATION_VERKTYGSTEXT[n]).not.toBe(n)
      expect((DELEGATION_VERKTYGSTEXT[n] ?? '').trim().length).toBeGreaterThan(0)
    }
  })

  it('ett OKÄNT verktyg faller tillbaka på sitt namn, aldrig på tomt', () => {
    expect(delegationVerktygstext('zz_okant_verktyg')).toBe('zz_okant_verktyg')
  })

  describe('villkoret och frekvensen i läsbar form', () => {
    it('null och {} säger BÅDA att avgränsning saknas', () => {
      expect(delegationVillkorstext(null)).toBe('Utan avgränsning — hela organisationen')
      expect(delegationVillkorstext({})).toBe('Utan avgränsning — hela organisationen')
    })

    it('fälten skrivs med svenska etiketter', () => {
      expect(delegationVillkorstext({ maxBelopp: 2000 })).toBe('Högsta belopp: 2000')
    })

    it('ett fält utan etikett skrivs ut oöversatt i stället för att försvinna', () => {
      expect(delegationVillkorstext({ zzOkant: 'x' })).toBe('zzOkant: x')
    })

    it('avsaknad av tak SÄGS, den lämnas inte tom', () => {
      expect(delegationFrekvenstext(null)).toBe('Inget tak')
      expect(delegationFrekvenstext({ maxAntal: 3, periodDagar: 30 })).toBe('Högst 3 per 30 dagar')
    })
  })
})
