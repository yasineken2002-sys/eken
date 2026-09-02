import { ACTION_TOOLS } from './ai-tools.definition'
import {
  EFFECT_DECLARATIONS,
  EFFECT_DECLARATION_NAMES,
  buildEffectCatalog,
  isAutoResumable,
  tomEffektlistaÄrTrovärdig,
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

    it('KASTAR när ett verktyg har traceIntegrity: OKÄND', () => {
      // Samma hållning som på klassificeringen: OKÄND betyder "ingen har svarat",
      // och det får inte se ut som ett svar. Provet muterar deklarationen
      // tillfälligt — det är enda sättet att pröva ett värde som inte får finnas
      // i filen.
      const post = EFFECT_DECLARATIONS['export_sie4']!
      const original = post.traceIntegrity
      post.traceIntegrity = 'OKÄND'
      try {
        expect(() => buildEffectCatalog()).toThrow(/traceIntegrity/)
        expect(() => buildEffectCatalog()).toThrow(/export_sie4/)
      } finally {
        post.traceIntegrity = original
      }
      // Riggen städad — annars ärver varje senare test en trasig deklaration.
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

  describe('det mätta läget 2026-09-02', () => {
    // Talen HÄRLEDS här och står inte som prosa någon annanstans. Ändras
    // klassificeringen ska den här raden ändras i samma PR — annars beskriver
    // docblocket ett läge som inte finns.
    //
    // 2026-09-02: 17/13 → 18/12. Raden gjorde exakt sitt jobb — den föll i CI
    // och tvingade fram ett medvetet beslut i stället för en tyst glidning.
    // Ändringen kommer av att TRE deklarationer beskrev koden fel, alla åt
    // samma håll (de påstod mindre skydd än som fanns):
    //
    //   compose_and_send_email    SentMessage-raden från #633, stod på INGET
    //   generate_lease_contract   påstod "Document saknar unikt index" — det
    //                             fanns, och posten styrde en MÄTNING av vad
    //                             som saknade nyckel
    //   send_document_to_tenant   samma index, men besegrat av en uuid-nyckel;
    //                             nyckeln härleds nu ur mottagare + innehåll,
    //                             vilket är det som flyttar posten till
    //                             IDEMPOTENT och gjorde 17 till 18
    //
    // 18/12 → 19/11 samma dag: `create_property` fick
    // `@@unique([organizationId, propertyDesignation])`. Den posten är
    // AUTOMATISK och var en av de fem vars spår var INGET — se raden om
    // återupptagbara nedan, som ändras med den.
    //
    // 19/11 → 20/10: `apply_rent_increase` fick
    // `rent_increase_lease_effective_live_unique`, ett PARTIELLT index. Den är
    // KRÄVER_MÄNNISKA och flyttar därför inte raden om återupptagbara.
    //
    // 20/10 → 22/8: `create_lease` och `create_tenant_and_lease` fick
    // `@@unique([unitId, tenantId, startDate])` — en nyckel, två poster. Båda är
    // KRÄVER_MÄNNISKA och flyttar därför inte raden om återupptagbara.
    //
    // Talen rör sig i takt med att nycklar byggs, och det är meningen. Raden
    // finns för att varje steg ska vara ett beslut — inte för att talet ska
    // vara stilla.
    it('22 IDEMPOTENT, 8 DEDUPLICERBAR, 0 OKÄND', () => {
      const c = buildEffectCatalog()
      const antal = (k: string) => c.filter((e) => e.effectIdempotency === k).length
      expect({
        idempotent: antal('IDEMPOTENT'),
        deduplicerbar: antal('DEDUPLICERBAR'),
        okand: antal('OKÄND'),
      }).toEqual({ idempotent: 22, deduplicerbar: 8, okand: 0 })
    })

    it('30 av 30 poster är policybeslutade — inga luckor kvar', () => {
      // Fältets syfte är att en LUCKA ska synas. Tre poster stod obeslutade en
      // runda (unmatch_transaction, generate_lease_contract och
      // send_overdue_reminders) och är nu avgjorda; skälen står vid posterna.
      //
      // Raden är skriven som en TOM MÄNGD och inte som talet 30 med flit: ett
      // nytt verktyg med policyBeslutad: false fäller den här, medan en
      // längdjämförelse hade blivit grön så fort någon lade till ännu ett.
      const obeslutade = buildEffectCatalog()
        .filter((e) => !e.policyBeslutad)
        .map((e) => e.name)
      expect(obeslutade).toEqual([])
      expect(buildEffectCatalog()).toHaveLength(30)
    })

    it('exakt 11 verktyg är återupptagbara — alla med ett spår som finns', () => {
      // Listan är HÄRLEDD, inte vald: den är snittet av AUTOMATISK och "spåret
      // finns". De AUTOMATISK-poster som faller ur gör det på det andra
      // villkoret, och det är avsiktligt — att en effekt får återupptas hjälper
      // ingen förrän något kan svara på om den redan skedde.
      //
      // 10 → 11 den 2026-09-02: `create_property` fick sitt unika index på
      // (organizationId, propertyDesignation). Den var AUTOMATISK hela tiden och
      // föll bara på att spåret var INGET. Det är precis den skillnaden
      // nyckelarbetet finns för — talet 15 AUTOMATISK var aldrig problemet.
      const resumable = buildEffectCatalog()
        .filter((e) => e.autoResumable)
        .map((e) => e.name)
        .sort()
      expect(resumable).toEqual([
        'create_journal_entry',
        'create_property',
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

    it('traceIntegrity: 2 TRANSAKTIONELL, 21 FÖRE_EFFEKTEN, 7 BÄST_MÖJLIGA', () => {
      // Efter steg 3b. Talen är MÄTTA, inte valda:
      //   • 7 BÄST_MÖJLIGA = klass B, verktygen med en extern effekt utanför
      //     transaktionen. De får #607-mönstret i en egen PR.
      //   • 2 TRANSAKTIONELL = de vägar där HELA effekten redan ryms i EN
      //     transaktion verktyget självt öppnar, och där spåret skrivs inne i
      //     den. Två genuina slår 23 påstådda.
      //   • 21 FÖRE_EFFEKTEN = resten av klass A. Spåret committas före
      //     effekten och stängs efteråt, så det kan aldrig försvinna tyst.
      const c = buildEffectCatalog()
      const antal = (k: string) => c.filter((e) => e.traceIntegrity === k).length
      expect({
        transaktionell: antal('TRANSAKTIONELL'),
        foreEffekten: antal('FÖRE_EFFEKTEN'),
        bastMojliga: antal('BÄST_MÖJLIGA'),
        okand: antal('OKÄND'),
      }).toEqual({ transaktionell: 2, foreEffekten: 21, bastMojliga: 7, okand: 0 })
    })

    it('externalHandle: 3 FÖRE_DISPATCH, 2 I_SVARET, 2 INGET, 23 EJ_TILLÄMPLIG', () => {
      // Mätt på metodnivå. Talen står här så att en ändring blir ett medvetet
      // beslut och inte en glidning.
      const c = buildEffectCatalog()
      const antal = (k: string) => c.filter((e) => e.externalHandle === k).length
      expect({
        föreDispatch: antal('FÖRE_DISPATCH'),
        iSvaret: antal('I_SVARET'),
        inget: antal('INGET'),
        ejTillämplig: antal('EJ_TILLÄMPLIG'),
      }).toEqual({ föreDispatch: 3, iSvaret: 2, inget: 2, ejTillämplig: 23 })
    })

    it('varje verktyg UTAN handtag står KRÄVER_MÄNNISKA', () => {
      // KRAVET som gör märkningen bärande. Ett verktyg där ingen kan svara på
      // "skedde detta?" får aldrig återupptas av en maskin — och `INGET` ska
      // inte kunna läsas som "handtag finns men vi tittade inte".
      //
      // De tre är send_overdue_reminders, compose_and_send_email och
      // send_document_to_tenant. De stod redan så; raden BEKRÄFTAR det och
      // hindrar att någon ändrar det utan att märka.
      const utanHandtag = buildEffectCatalog().filter((e) => e.externalHandle === 'INGET')
      // `send_overdue_reminders` STOD HÄR fram till 2026-09-01. Den skickar nu
      // `ai-overdue-${invoice.id}` — ett handtag som är härlett ur fakturans id
      // och alltså känt före dispatch. Att listan krympte är hela poängen med
      // att den står som namn och inte som ett antal.
      expect(utanHandtag.map((e) => e.name).sort()).toEqual([
        'compose_and_send_email',
        'send_document_to_tenant',
      ])
      for (const e of utanHandtag) {
        expect(e.resumptionPolicy).toBe('KRÄVER_MÄNNISKA')
        expect(e.autoResumable).toBe(false)
      }
    })

    it('EJ_TILLÄMPLIG betyder exakt "ingen extern effekt" — inte "vi vet inte"', () => {
      // Bindningen mellan de två fälten: bara klass A (BÄST_MÖJLIGA saknas där)
      // får sakna handtag av det skälet. Glider de isär betyder EJ_TILLÄMPLIG
      // två saker, och då är märkningen värdelös.
      for (const e of buildEffectCatalog()) {
        const klassB = e.traceIntegrity === 'BÄST_MÖJLIGA'
        expect(e.externalHandle === 'EJ_TILLÄMPLIG').toBe(!klassB)
      }
    })

    it('exakt de två vägar som äger sin egen transaktion är TRANSAKTIONELL', () => {
      // Namnen står här, inte bara talet: TRANSAKTIONELL kräver att spåret
      // skrivs inne i verktygets tx, och det gör bara de här två
      // (`skrivTransaktionelltSpar` i tool-executor.service.ts). Läggs ett
      // tredje till utan den skrivvägen faller rollback-provet i
      // effect-trace-transactional.db.spec.ts.
      const namn = buildEffectCatalog()
        .filter((e) => e.traceIntegrity === 'TRANSAKTIONELL')
        .map((e) => e.name)
        .sort()
      expect(namn).toEqual(['create_journal_entry', 'record_expense'])
    })

    it('en tom effektlista är trovärdig ENDAST där spåret inte kan tappas tyst', () => {
      // Kopplingen som gör fältet bärande i stället för dekorativt:
      // describeEffects läser det här och säger ODEFINIERAT i stället för "inga
      // dataändringar" — men bara för BÄST_MÖJLIGA. Efter steg 3b är 23 av 30
      // trovärdiga, och den ändringen skedde utan att någon rörde
      // describeEffects.
      for (const e of buildEffectCatalog()) {
        expect(tomEffektlistaÄrTrovärdig(e.name)).toBe(e.traceIntegrity !== 'BÄST_MÖJLIGA')
      }
      const trovärdiga = buildEffectCatalog().filter((e) => tomEffektlistaÄrTrovärdig(e.name))
      expect(trovärdiga).toHaveLength(23)
      // Okänt verktyg faller stängt i svarsledet, inte med ett kast.
      expect(tomEffektlistaÄrTrovärdig('finns_inte')).toBe(false)
    })

    it('varje AUTOMATISK som ändå inte är återupptagbar blockeras av ett SAKNAT SPÅR', () => {
      // Inte av policyn. Skillnaden avgör vad nästa steg är: de här behöver en
      // nyckel, inte ett beslut.
      //
      // ⚠️ LÄS LISTAN. `create_property` föll ur den 2026-09-02 när
      // beteckningen blev nyckel. De FYRA som är kvar är exakt de poster där
      // domänen INTE har någon nyckel — två identiska felanmälningar, två
      // identiska serviceavgifter, två likadana besiktningar samma dag, en
      // upprepad kommentar. Sammanfallandet är ingen tillfällighet: en post
      // lämnar den här listan i samma stund som domänen visar sig ha en nyckel,
      // och de som blir kvar är de som behöver något annat än en nyckel.
      const blockerade = buildEffectCatalog().filter(
        (e) => e.resumptionPolicy === 'AUTOMATISK' && !e.autoResumable,
      )
      for (const e of blockerade) expect(e.traceDurability.plats).toBe('INGET')
      expect(blockerade.map((e) => e.name).sort()).toEqual([
        'create_inspection',
        'create_invoice',
        'create_maintenance_ticket',
        'update_maintenance_status',
      ])
    })
  })
})
