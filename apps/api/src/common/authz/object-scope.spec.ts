/**
 * OBJEKTNIVÅ-GRINDEN. Uppföljning på #114.
 *
 * Två mekanismer med olika ambition, av skäl som står i `object-scope.ts`:
 *
 *   INVENTARIET bevisar ingen säkerhet — det gör bara omöjligt att lägga till en
 *   skrivning mot förälder-scopad data utan att någon ser det.
 *
 *   DEN STRUKTURELLA KONTROLLEN uttalar sig bara där svaret är avgörbart:
 *   update/delete på ett id i en funktion utan NÅGOT scopnings-uttryck alls.
 *
 * Uppdatering av inventariet kräver `UPDATE_OBJECT_SCOPE=1`. Ett test som lagade
 * sig självt hade varit värdelöst — poängen är att ändringen ska kosta en
 * medveten handling och hamna i en PR där någon läser den.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  MODEL_SCOPES,
  collectWriteSites,
  modelsWithoutOrgId,
  nestedWritesInSource,
  relationFields,
  renderInventory,
  toInventory,
  staleExceptions,
  unscopedForm1,
} from './object-scope'

const SRC_DIR = join(__dirname, '..', '..')
const SCHEMA = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma')
const GOLDEN_PATH = join(__dirname, 'object-scope.golden.txt')

describe('Objektnivå-scopning (#114-uppföljning)', () => {
  const sites = collectWriteSites(SRC_DIR, SCHEMA)
  const rows = toInventory(sites)

  it('parsern ser fortfarande kodbasen (rimlighetsgolv)', () => {
    // Utan golvet kan en trasig parser "bevisa" att inget ändrats genom att inte
    // hitta något — och ett inventarium som krympt till noll rader hade sett ut
    // som en ren diff. Siffrorna är kodbasens när grinden skrevs, med marginal:
    // de ska fånga att en hel modul slutar parsas, inte att ett anrop tas bort.
    const klassificerade = Object.entries(MODEL_SCOPES).filter(
      ([, v]) => v.scope === 'parent-scoped',
    )
    expect(klassificerade.length).toBeGreaterThanOrEqual(15)
    expect(sites.length).toBeGreaterThanOrEqual(55)
    expect(sites.filter((s) => s.form === 1).length).toBeGreaterThanOrEqual(10)
    // EGET GOLV FÖR DEN NÄSTLADE YTAN. Utan det kan hela den nästlade insamlingen
    // gå sönder — trasig relationskarta, ändrad schemasökväg, felaktig
    // klammermatchning — och grinden faller tillbaka till exakt den blindhet
    // #273 dokumenterade, med ett inventarium som fortfarande ser fullt ut.
    // Ett totalgolv hade inte fångat det: 60 direkta räcker för att passera.
    expect(sites.filter((s) => s.via).length).toBeGreaterThanOrEqual(5)
  })

  it('alla fyra skyddsformerna detekteras fortfarande', () => {
    // Detektorns egen hälsokontroll. Varje form finns i kodbasen i dag, så alla
    // fyra MÅSTE förekomma i utfallet. Slutar en regex matcha — t.ex. om form C
    // smalnas och inte längre ser `this.tjänsten.findOne(id, orgId)` — faller
    // den formens ställen tyst till INGEN, och en heuristik som tappat en form
    // producerar larm på korrekt kod. Då är grinden på väg att bli sådan man
    // lär sig ignorera, vilket är hela skälet till att den byggdes så här.
    const funna = new Set(sites.map((s) => s.protection))
    expect({
      A: funna.has('A'),
      B: funna.has('B'),
      C: funna.has('C'),
      D: funna.has('D'),
      // P bär hela den nästlade ytan: slutar den matcha faller sex av sju
      // nästlade rader till INGEN, och grinden börjar larma på korrekt kod.
      P: funna.has('P'),
    }).toEqual({ A: true, B: true, C: true, D: true, P: true })
  })

  it('inget undantag har blivit inaktuellt', () => {
    // Ett undantag för ett skrivställe som inte finns kvar ser ut som en gjord
    // bedömning men täcker ingenting — och nästa läsare tror att frågan är
    // ställd. Samma disciplin som declared-avvikelserna i behörighetsytan.
    expect(staleExceptions(sites)).toEqual([])
  })

  it('varje modell utan organizationId är klassificerad', () => {
    // Tillkommer en ny sådan modell ska någon svara på om den är förälder-scopad
    // eller inte. Att den frågan aldrig ställdes var förutsättningen för #114.
    const oklassificerade = modelsWithoutOrgId(SCHEMA).filter((m) => !(m in MODEL_SCOPES))
    expect(
      oklassificerade.length === 0
        ? ''
        : `Oklassificerade modeller utan organizationId: ${oklassificerade.join(', ')}.\n` +
            'Lägg till dem i MODEL_SCOPES — antingen som parent-scoped med sin förälder,\n' +
            'eller som out med skälet till att de inte kan bära en objektnivå-IDOR.\n',
    ).toBe('')
  })

  it('ingen klassificering pekar på en modell som inte finns i schemat', () => {
    // En kvarglömd post efter en borttagen modell ser ut som täckning men är
    // tomt utrymme.
    const iSchemat = new Set(modelsWithoutOrgId(SCHEMA))
    const spöken = Object.keys(MODEL_SCOPES).filter((m) => !iSchemat.has(m))
    expect(spöken).toEqual([])
  })

  describe('nästlade skrivningar', () => {
    const rel = relationFields(SCHEMA)

    it('samma fältnamn ger OLIKA modell beroende på förälder', () => {
      // Kärnan i varför kartan måste komma ur schemat. `lines` är tre olika
      // modeller under tre olika föräldrar. En parser som gissade ur fältnamnet
      // hade satt fel modell på raden — vilket är både ett falsklarm (rad mot en
      // modell som inte skrivs) och en miss (den som skrivs syns inte).
      const träff = (förälder: string) => rel.get(förälder)?.get('lines')?.model
      expect({
        Invoice: träff('Invoice'),
        JournalEntry: träff('JournalEntry'),
        RentNotice: träff('RentNotice'),
      }).toEqual({
        Invoice: 'InvoiceLine',
        JournalEntry: 'JournalEntryLine',
        RentNotice: 'RentNoticeLine',
      })
    })

    it('hittar skrivningen och namnger rätt modell', () => {
      const funna = nestedWritesInSource(
        `
  async skapa(organizationId: string) {
    await this.prisma.journalEntry.create({
      data: { organizationId, lines: { create: rader } },
    })
  }
`,
        rel,
      )
      expect(funna.map((s) => `${s.model}.${s.op} ${s.protection} via ${s.via}`)).toEqual([
        'JournalEntryLine.create P via JournalEntry.lines',
      ])
    })

    it('nyttolast byggd i en variabel räknas också', () => {
      // invoices.service.ts:421 har den här formen. Missas den ser inventariet
      // komplett ut medan den enda nästlade skrivningen under en update saknas.
      const funna = nestedWritesInSource(
        `
  async uppdatera(id: string, organizationId: string) {
    const data: Prisma.InvoiceUpdateInput = {}
    data.lines = { createMany: { data: rader } }
    await this.prisma.invoice.update({ where: { id, organizationId }, data })
  }
`,
        rel,
      )
      expect(funna.map((s) => `${s.model}.${s.op}`)).toEqual(['InvoiceLine.createMany'])
    })

    it('FILTER och SKALÄRER ger inga rader', () => {
      // Den andra riktningen, och den som avgör om grinden är värd något: en
      // vakt som larmar på `where: { lines: { some } }` eller på `{ set: … }`
      // mot ett skalärfält lär man sig att ignorera.
      const funna = nestedWritesInSource(
        `
  async läs(organizationId: string) {
    await this.prisma.invoice.update({
      where: { id, organizationId, lines: { some: { total: { gt: 0 } } } },
      data: { reference: { set: 'X' }, notes: 'oförändrad' },
      include: { lines: true },
    })
  }
`,
        rel,
      )
      expect(funna).toEqual([])
    })

    it('set/disconnect räknas bara mot LISTRELATIONER', () => {
      // Mot en enkelrelation sätter de FK:n på raden man redan skriver — alltså
      // föräldern. En rad mot barnet hade då varit direkt felaktig.
      const enkel = nestedWritesInSource(
        `
  async koppla() {
    await this.prisma.invoice.update({ where: { id }, data: { lease: { disconnect: true } } })
  }
`,
        rel,
      )
      expect(enkel).toEqual([])

      const lista = nestedWritesInSource(
        `
  async koppla() {
    await this.prisma.invoice.update({ where: { id }, data: { lines: { set: [] } } })
  }
`,
        rel,
      )
      expect(lista.map((s) => `${s.model}.${s.op}`)).toEqual(['InvoiceLine.set'])
    })

    it('oskyddad nästlad skrivning saknar skyddsform', () => {
      // #273:s hypotetiska fall, nu ett verkligt testfall: förälderns where bär
      // bara ett id från klienten, och ingen av formerna A–D syns i funktionen.
      const funna = nestedWritesInSource(
        `
  async ersätt(dto: ErsättDto) {
    await this.prisma.invoice.update({
      where: { id: dto.invoiceId },
      data: { lines: { deleteMany: {}, create: dto.lines } },
    })
  }
`,
        rel,
      )
      expect(funna.map((s) => `${s.model}.${s.op} form ${s.form} ${s.protection}`)).toEqual([
        'InvoiceLine.deleteMany form 1 INGEN',
        'InvoiceLine.create form 2 INGEN',
      ])
      // …och form 1-raden fälls av den strukturella kontrollen.
      const öppna = unscopedForm1(funna.map((s) => ({ ...s, file: 'fixtur.ts' })))
      expect(öppna.map((s) => `${s.model}.${s.op}`)).toEqual(['InvoiceLine.deleteMany'])
    })

    it('ordet organizationId i en STRÄNG eller KOMMENTAR är inget skydd', () => {
      // Säkerhetsgranskningens HIGH på den här PR:en. Första versionen avgjorde
      // skyddsform P med en textsökning över spannet, och då räckte en decoy för
      // att en helt oskyddad skrivning skulle märkas "P förälder org-bunden".
      //
      // Det är inte ett falsklarm utan dess MOTSATS: raden såg granskad ut i
      // golden-filen, och den strukturella kontrollen slutade fälla den. Just
      // den kommentaren — "TODO: verifiera organizationId" — är dessutom den en
      // utvecklare skriver när scopningen SAKNAS.
      const medDecoy = (fält: string) => `
  async ersätt(dto: ErsättDto) {
    await this.prisma.invoice.update({
      where: { id: dto.invoiceId }, ${fält}
      data: { lines: { deleteMany: {}, create: dto.lines } },
    })
  }
`
      for (const decoy of [
        `// TODO: verifiera organizationId när multi-tenant landar`,
        `notes: 'ändrat av admin, organizationId-migrering pågår',`,
      ]) {
        const funna = nestedWritesInSource(medDecoy(decoy), rel)
        expect(funna.map((s) => s.protection)).toEqual(['INGEN', 'INGEN'])
        const öppna = unscopedForm1(funna.map((s) => ({ ...s, file: 'fixtur.ts' })))
        expect(öppna.map((s) => s.op)).toEqual(['deleteMany'])
      }
    })

    it('verktygets egna filer inventeras inte', () => {
      // Utan uteslutningen inventerar dokumentationen sig själv — det hände i
      // #273, där ett exempel i en kommentar blev en rad i form 2.
      expect(sites.filter((s) => s.file.includes('common/authz/object-scope'))).toEqual([])
    })
  })

  describe('den strukturella kontrollen', () => {
    it('ingen update/delete på id saknar scopning helt', () => {
      // Avgörbart utan dataflödesanalys: syns INGEN av de fyra formerna någonstans
      // i funktionen är det inte en tolkningsfråga. Det är #114:s exakta form.
      const öppna = unscopedForm1(sites)
      expect(
        öppna.length === 0
          ? ''
          : 'SKRIVNING MOT FÖRÄLDER-SCOPAD DATA UTAN SYNLIG SCOPNING:\n\n' +
              öppna
                .map((s) => {
                  const scope = MODEL_SCOPES[s.model]
                  const parent = scope?.scope === 'parent-scoped' ? scope.parent : '(okänd)'
                  if (s.via) {
                    return (
                      `  ${s.file}:${s.line}\n` +
                      `    ${s.model}.${s.op}() — NÄSTLAD skrivning via ${s.via}.\n` +
                      `    Den träffar de rader föräldern pekar ut, men förälderns anrop\n` +
                      `    binder ingen organisation (varken where eller data nämner\n` +
                      `    organizationId), och ingen av formerna A–D syns i funktionen.\n`
                    )
                  }
                  return (
                    `  ${s.file}:${s.line}\n` +
                    `    ${s.model}.${s.op}() — ${s.model} saknar eget organizationId och\n` +
                    `    kan bara scopas via ${parent}. Ingen av formerna A–D syns i funktionen.\n`
                  )
                })
                .join('\n') +
              '\nVerifiera att raden tillhör anroparens organisation INNAN den skrivs:\n' +
              '  findFirst({ where: { id, <förälder>: { organizationId } } })  → NotFound annars\n\n' +
              'Är den redan scopad på ett sätt heuristiken inte ser (id:t härlett ur en\n' +
              'org-scopad läsning, kontrollen i en anropande metod)? Då är raden inte fel —\n' +
              'men den är omöjlig att granska på plats. Gör scopningen synlig i funktionen.\n',
      ).toBe('')
    })
  })

  it('inventariet matchar koden', () => {
    const generated = renderInventory(rows)

    if (process.env['UPDATE_OBJECT_SCOPE'] === '1') {
      writeFileSync(GOLDEN_PATH, generated, 'utf8')
      console.warn(`[authz] objektinventariet uppdaterat: ${GOLDEN_PATH}`)
      return
    }

    expect(existsSync(GOLDEN_PATH)).toBe(true)
    const golden = readFileSync(GOLDEN_PATH, 'utf8')
    if (golden === generated) return

    const g = golden.split('\n')
    const n = generated.split('\n')
    const diffs: string[] = []
    for (let i = 0; i < Math.max(g.length, n.length); i++) {
      if (g[i] !== n[i]) {
        diffs.push(`  rad ${i + 1}:`)
        diffs.push(`    inventariet: ${g[i] ?? '(saknas)'}`)
        diffs.push(`    koden:       ${n[i] ?? '(saknas)'}`)
      }
      if (diffs.length > 60) {
        diffs.push('  … (fler rader skiljer)')
        break
      }
    }

    throw new Error(
      'SKRIVYTAN MOT FÖRÄLDER-SCOPAD DATA HAR ÄNDRATS.\n\n' +
        `${diffs.join('\n')}\n\n` +
        'Är ändringen avsedd? Kör då:\n' +
        '    pnpm --filter @eken/api authz:objects\n' +
        'och säg i PR:en HUR den nya skrivningen scopas till anroparens organisation.\n\n' +
        'Kom ihåg att skyddsformen i filen är DETEKTERAD, inte verifierad. Att en rad\n' +
        'säger "A kedje-query" betyder att mönstret syns i funktionen — inte att just\n' +
        'det id:t är kontrollerat.\n',
    )
  })
})
