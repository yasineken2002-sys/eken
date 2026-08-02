/**
 * #284 — KUNDENS KRYPTERADE PERSONNUMMERKOLUMNER SKA ALDRIG SERIALISERAS.
 *
 * `InvoicesService.findOne` gjorde `include: { customer: true }` utan select, och
 * `GET /invoices/:id` saknar rollgrind (R1: läsning är öppen för alla roller).
 * Följden: varje autentiserad roll fick `customer.personalNumberEnc` och
 * `customer.personalNumberHash` rakt i JSON-svaret.
 *
 * INTE KLARTEXT — men inte heller ingenting. Chiffertexten är AES-256-GCM och
 * oanvändbar utan nyckeln, men `personalNumberHash` är ett BLIND-INDEX: en
 * deterministisk HMAC. Den som har hashen kan verifiera en GISSNING genom att
 * hasha ett misstänkt personnummer och jämföra. Svagare än klartext, starkare än
 * ingenting.
 *
 * Samma fil gjorde redan rätt för hyresgästen med `SAFE_TENANT_SELECT`. Kunden
 * fick aldrig sin motsvarighet — invarianten i customers.service.ts gällde bara
 * `mapCustomer`, inte varje ställe en Customer inkluderas.
 *
 * TESTET LÄSER SELECTEN, INTE ETT SVAR. Ett svarsbaserat test hade behövt en
 * attrapp-Prisma som själv låtsas respektera selecten — alltså bevisat att
 * attrappen är konsekvent med sig själv. Här kontrolleras i stället att
 * konstanten som skickas till Prisma saknar kolumnerna, och att varje
 * anropsställe faktiskt använder den.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SAFE_CUSTOMER_SELECT } from '../customers/customers.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'

const SRC = join(__dirname, '..')

/** Blankar rad- och blockkommentarer men behåller radnumreringen. */
function utanKommentarer(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

function walk(dir: string): string[] {
  const ut: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) ut.push(...walk(p))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) ut.push(p)
  }
  return ut
}

/**
 * Ställen som MEDVETET tar med de krypterade kolumnerna, med skälet.
 *
 * Formen är densamma som CALLER_SCOPED i objektinventariet: ett undantag ska
 * vara ett skrivet påstående någon kan ifrågasätta, inte en tyst frånvaro.
 */
const MEDVETNA_UNDANTAG: Record<string, string> = {
  'collections/collection-export.service.ts':
    'Inkassoexporten dekrypterar gäldenärens personnummer till underlaget — ' +
    'Kronofogden identifierar parten på det. Rollgrindad (COLLECTION_ACTION_ROLES).',
  'collections/rent-collection-export.service.ts':
    'Samma som inkassoexporten ovan, hyresavi-sidan.',
  'contracts/contract-template.service.ts':
    'Hyresavtalet bär hyresgästens personnummer — partsidentifieringen i ett ' +
    'bindande avtal. Dekrypteras vid dokumentbygget.',
  'tenant-portal/tenant-portal.service.ts': 'Hyresgästens EGET personnummer, egen aktörsmodell.',
  'tenant-portal/tenant-auth.service.ts': 'Samma, portalens autentisering.',
  'tenants/tenants.service.ts': 'Tjänsten som äger kolumnen.',
  'customers/customers.service.ts': 'Tjänsten som äger kolumnen.',
}

describe('#284 · kundens krypterade kolumner lämnar aldrig backend', () => {
  it('SAFE_CUSTOMER_SELECT bär varken chiffertext eller blind-index', () => {
    expect(SAFE_CUSTOMER_SELECT).not.toHaveProperty('personalNumberEnc')
    expect(SAFE_CUSTOMER_SELECT).not.toHaveProperty('personalNumberHash')
    expect(SAFE_CUSTOMER_SELECT).not.toHaveProperty('personalNumber')
  })

  it('SAFE_TENANT_SELECT gör det inte heller — samma invariant', () => {
    expect(SAFE_TENANT_SELECT).not.toHaveProperty('personalNumberEnc')
    expect(SAFE_TENANT_SELECT).not.toHaveProperty('personalNumberHash')
  })

  it('selecten är inte tom — den ska bära ALLA icke-känsliga kolumner', () => {
    // Ett tomt select hade passerat testerna ovan och brutit varje konsument.
    expect(Object.keys(SAFE_CUSTOMER_SELECT).length).toBeGreaterThanOrEqual(15)
    expect(SAFE_CUSTOMER_SELECT).toHaveProperty('email')
    expect(SAFE_CUSTOMER_SELECT).toHaveProperty('companyName')
  })

  it('INGET ställe gör `customer: true` eller `tenant: true` utan ett medvetet skäl', () => {
    const öppna: string[] = []
    for (const fil of walk(SRC)) {
      const rel = fil.split('/src/')[1] ?? fil
      if (rel in MEDVETNA_UNDANTAG) continue
      // Kommentarer bort FÖRST — prosa som beskriver det gamla mönstret ska inte
      // räknas som en träff, och en träff ska inte kunna gömmas i en kommentar.
      const src = utanKommentarer(readFileSync(fil, 'utf8'))
      // INGET RADANKARE. Första versionen krävde att nyckeln stod ensam på sin
      // rad, och missade därmed `include: { customer: true, lines: true }` —
      // formatering Prettier gärna producerar för korta objekt. En vakt vars
      // räckvidd beror på radbrytning ser heltäckande ut utan att vara det;
      // säkerhetsgranskningen bevisade luckan med contract-template.service.ts:65.
      for (const m of src.matchAll(/\b(customer|tenant)\s*:\s*true\b/g)) {
        const rad = src.slice(0, m.index).split('\n').length
        öppna.push(`${rel}:${rad} — ${m[1]}: true`)
      }
    }
    expect(öppna).toEqual([])
  })

  it('varje undantag motsvarar ett ställe som FAKTISKT finns', () => {
    // Ett undantag för kod som försvunnit ser ut som en gjord bedömning men
    // täcker ingenting — samma disciplin som staleExceptions i objektinventariet.
    const saknade = Object.keys(MEDVETNA_UNDANTAG).filter((rel) => {
      try {
        return !/personalNumberEnc|customer: true|tenant: true/.test(
          readFileSync(join(SRC, rel), 'utf8'),
        )
      } catch {
        return true
      }
    })
    expect(saknade).toEqual([])
  })
})
