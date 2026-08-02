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
  renderInventory,
  toInventory,
  staleExceptions,
  unscopedForm1,
} from './object-scope'

const SRC_DIR = join(__dirname, '..', '..')
const SCHEMA = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma')
const GOLDEN_PATH = join(__dirname, 'object-scope.golden.txt')

describe('Objektnivå-scopning (#114-uppföljning)', () => {
  const sites = collectWriteSites(SRC_DIR)
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
    expect(sites.length).toBeGreaterThanOrEqual(50)
    expect(sites.filter((s) => s.form === 1).length).toBeGreaterThanOrEqual(10)
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
    }).toEqual({ A: true, B: true, C: true, D: true })
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
