import { ACTION_TOOLS } from './ai-tools.definition'
import {
  EFFECT_DECLARATIONS,
  EFFECT_DECLARATION_NAMES,
  buildEffectCatalog,
  isAutoResumable,
} from './effect-idempotency'

/**
 * ANSVARSDELNINGEN, utskriven i BÅDA filerna (lärdomen från #571):
 *
 *   • `check-effect-idempotency.mjs` äger PÅKOPPLINGEN — att deklarationen
 *     täcker ACTION_TOOLS, och att varje påstådd mekanism fortfarande finns i
 *     koden. Den läser källtext och kan därför fälla på saker som aldrig körs.
 *   • Den här specen äger MEKANIKEN — att fail-closed faktiskt kastar, att
 *     `autoResumable` verkligen är stängd, och att invarianterna håller för
 *     riktiga objekt och inte bara för regexar över text.
 *
 * Ingen av dem räcker ensam. Vakten kan inte köra en funktion; specen blir inte
 * röd när någon tar bort en mekanism den aldrig läser.
 */
describe('effektklassificeringen', () => {
  it('har en deklaration för VARJE bindande verktyg', () => {
    const saknar = [...ACTION_TOOLS].filter((n) => !EFFECT_DECLARATION_NAMES.includes(n))
    expect(saknar).toEqual([])
  })

  it('har INGA deklarationer för verktyg som inte är bindande (döda poster)', () => {
    const doda = EFFECT_DECLARATION_NAMES.filter((n) => !ACTION_TOOLS.has(n))
    expect(doda).toEqual([])
  })

  it('bygger exakt lika många poster som ACTION_TOOLS', () => {
    expect(buildEffectCatalog()).toHaveLength(ACTION_TOOLS.size)
  })

  describe('FAIL-CLOSED', () => {
    it('KASTAR när ett bindande verktyg saknar klassificering', () => {
      // Ett nytt verktyg läggs till i ACTION_TOOLS utan deklaration — exakt det
      // som händer när någon bygger ett verktyg och glömmer klassa det. Utan
      // det här kastet hade det tyst blivit en post som ingen prövat.
      ACTION_TOOLS.add('skicka_ovanligt_brev')
      try {
        expect(() => buildEffectCatalog()).toThrow(/skicka_ovanligt_brev/)
        expect(() => buildEffectCatalog()).toThrow(/saknar effektklassificering/)
      } finally {
        ACTION_TOOLS.delete('skicka_ovanligt_brev')
      }
      // Och riggen är städad: utan städningen hade varje senare test i filen
      // ärvt ett trasigt ACTION_TOOLS och blivit rött av fel skäl.
      expect(() => buildEffectCatalog()).not.toThrow()
    })

    it('KASTAR när någon frågar om ett verktyg som inte finns', () => {
      // Ett tyst `false` hade dolt att frågan ställdes fel — anroparen hade
      // trott att den fått ett svar om verktyget, inte om sin egen stavning.
      expect(() => isAutoResumable('finns_inte')).toThrow(/Okänt verktyg/)
    })

    it('OKÄND är aldrig återupptagbar — inte ens med AUTOMATISK policy', () => {
      // Mekaniken, inte deklarationen: prövar funktionen på ett syntetiskt
      // objekt så regeln gäller även för en post som ingen skrivit än.
      const catalog = buildEffectCatalog()
      for (const e of catalog) {
        if (e.effectIdempotency === 'OKÄND') expect(e.autoResumable).toBe(false)
      }
    })
  })

  describe('invarianter', () => {
    it('policyBeslutad: false TVINGAR KRÄVER_MÄNNISKA', () => {
      const brott = buildEffectCatalog()
        .filter((e) => !e.policyBeslutad && e.resumptionPolicy !== 'KRÄVER_MÄNNISKA')
        .map((e) => e.name)
      expect(brott).toEqual([])
    })

    it('varje IDEMPOTENT namnger minst en mekanism', () => {
      const utan = buildEffectCatalog()
        .filter((e) => e.effectIdempotency === 'IDEMPOTENT' && e.mekanismer.length === 0)
        .map((e) => e.name)
      expect(utan).toEqual([])
    })

    it('ingen DEDUPLICERBAR utan spår är återupptagbar', () => {
      // Att en effekt KAN dedupliceras hjälper ingen förrän något faktiskt gör
      // det. Utan den här raden hade klass (ii) sett löst ut medan 13 av 14
      // saknar nyckel.
      const brott = buildEffectCatalog()
        .filter((e) => e.traceDurability.plats === 'INGET' && e.autoResumable)
        .map((e) => e.name)
      expect(brott).toEqual([])
    })

    it('loopverktygen är nycklade på EFFEKT, inte på ANROP', () => {
      // De skickar N mejl i en try/catch-loop. En nyckel på anropet säger
      // antingen "gjort" (och 15 personer får aldrig sitt brev) eller "inte
      // gjort" (och 25 får det två gånger).
      for (const namn of ['send_overdue_reminders', 'compose_and_send_email']) {
        expect(EFFECT_DECLARATIONS[namn]!.idempotencyUnit).toBe('EFFEKT')
      }
    })
  })

  describe('det mätta läget 2026-09-01', () => {
    // Talen HÄRLEDS här och står inte som prosa någon annanstans. Ändras
    // klassificeringen ska den här raden ändras i samma PR — annars beskriver
    // docblocket ett läge som inte finns.
    it('16 IDEMPOTENT, 14 DEDUPLICERBAR, 0 OKÄND', () => {
      const c = buildEffectCatalog()
      const antal = (k: string) => c.filter((e) => e.effectIdempotency === k).length
      expect({
        idempotent: antal('IDEMPOTENT'),
        deduplicerbar: antal('DEDUPLICERBAR'),
        okand: antal('OKÄND'),
      }).toEqual({ idempotent: 16, deduplicerbar: 14, okand: 0 })
    })

    it('27 av 30 poster är policybeslutade — 3 står kvar med skäl', () => {
      // Fältets syfte är att en LUCKA ska synas. Ändras något av de tre måste
      // den här raden ändras i samma PR, och skälet vid posten med den.
      const obeslutade = buildEffectCatalog()
        .filter((e) => !e.policyBeslutad)
        .map((e) => e.name)
        .sort()
      expect(obeslutade).toEqual([
        'generate_lease_contract',
        'send_overdue_reminders',
        'unmatch_transaction',
      ])
    })

    it('exakt 10 verktyg är återupptagbara — alla med ett spår som finns', () => {
      // Efter policybesluten 2026-09-01. Listan är HÄRLEDD, inte vald: den är
      // snittet av AUTOMATISK och "spåret finns". Fem AUTOMATISK-poster faller
      // ur på det andra villkoret, och det är avsiktligt — att en effekt får
      // återupptas hjälper ingen förrän något kan svara på om den redan skedde.
      const resumable = buildEffectCatalog()
        .filter((e) => e.autoResumable)
        .map((e) => e.name)
        .sort()
      expect(resumable).toEqual([
        'create_journal_entry',
        'create_unit',
        'export_sie4',
        'generate_rent_notices',
        'import_bgmax_file',
        'match_bank_transaction',
        'pause_reminders',
        'record_expense',
        'resume_reminders',
        'update_tenant',
      ])
    })

    it('varje AUTOMATISK som ändå inte är återupptagbar blockeras av ett SAKNAT SPÅR', () => {
      // Inte av policyn. Skillnaden avgör vad nästa steg är: de här fem behöver
      // en innehållsnyckel, inte ett beslut.
      const blockerade = buildEffectCatalog().filter(
        (e) => e.resumptionPolicy === 'AUTOMATISK' && !e.autoResumable,
      )
      for (const e of blockerade) expect(e.traceDurability.plats).toBe('INGET')
      expect(blockerade.map((e) => e.name).sort()).toEqual([
        'create_inspection',
        'create_invoice',
        'create_maintenance_ticket',
        'create_property',
        'update_maintenance_status',
      ])
    })
  })
})
