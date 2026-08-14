/**
 * EN NY BAR TENANT-LÄSNING I PORTALEN SKA BLI RÖD, INTE TYST.
 *
 * `TenantWithCredentials` gör `stripTenantCredentials` till enda vägen från
 * credential-bärande till publik form. Men Prisma returnerar `Tenant`, inte den
 * brandade typen — typspärren biter alltså bara där läsningen faktiskt BRANDAS.
 * En ny `prisma.tenant.findUnique` i den här mappen skulle vara helt ogrindad,
 * och kompilatorn skulle säga ingenting: den ser en vanlig `Tenant` som får
 * returneras.
 *
 * Det är formen "ett skydd som är BLINT i stället för RÖTT" — samma sak som
 * golden-filens blinda fläck (#434), hinkgränsen (#441) och den divergerade
 * credential-listan (#453). Typen ensam byter bara en kommentar mot något som
 * SER UT att garantera.
 *
 * ── Varför en negativ mönsterkontroll och inte en uppräkning ────────────────
 *
 * Alternativet var ett test som räknar upp de kända läsningarna i
 * `tenant-auth.service.ts` och kräver att var och en går genom funktionen. Det
 * har exakt samma lucka som det bevakar: en NY läsning som ingen lade till i
 * listan blir tyst. Samma skäl som fick #453:s partitionstest att keya på ett
 * MÖNSTER mot schemat i stället för på en lista.
 *
 * Den negativa formen — "en bar `prisma.tenant.find*` får inte förekomma här" —
 * failar på en ny läsning utan att någon uppdaterat någonting.
 *
 * ── Varför gränsen går vid tenant-portal/ ───────────────────────────────────
 *
 * Det är HÄR sessioner byggs och credentials behövs: `passwordHash` för
 * bcrypt-jämförelsen i login, `activationTokenHash`/`passwordResetTokenHash` för
 * tokenuppslagningen. Ingen annan modul har skäl att läsa de kolumnerna, och en
 * bar läsning här är per definition credential-bärande.
 *
 * `Tenant` läses LAGLIGT på ett tiotal ställen utanför mappen — leases (existens-
 * kontroll före avtal), import (dubblettkontroll på e-post), ocr (hämtar
 * ocrNumber), messages (bygger mejlmall). De bär inga credentials ut och ska
 * inte fångas; ett vidgat scope hade druknat i falska positiver och regeln hade
 * luckrats upp tills den slutade betyda något.
 *
 * VIDGA INTE utan att först mäta att den nya mappen faktiskt behöver
 * credential-kolumnerna. SNÄVA INTE till en enskild fil — `tenant-portal.
 * controller.ts` och `tenant-portal.service.ts` har båda credential-bärande
 * läsningar (bcrypt vid kontoradering respektive personnummer i GDPR-exporten),
 * så en fil-avgränsning hade tappat två av nio.
 *
 * ── Om tenants.service.ts, som ligger UTANFÖR ───────────────────────────────
 *
 * Hyresvärds-API:ts `mapTenant` strippar samma lista men behöver inte samma
 * skydd, och skälet är strukturellt: dess läsningar går genom `SAFE_TENANT_SELECT`
 * (`findAll`/`findOne`) eller är existenskontroller vars rad aldrig returneras
 * (`update`/`remove`). Ingen av dem är credential-bärande — kolumnerna kommer
 * aldrig ut ur Postgres. Skyddet där ligger i SELECTEN, som är fail-closed av sig
 * själv, medan portalen är den enda platsen som medvetet läser förbi den.
 * `SAFE_TENANT_SELECT` bevakas separat av #453:s partitionstest.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TenantWithCredentials, PublicTenant } from './tenant-credential-read'

const PORTAL = join(__dirname)

function utanKommentarer(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** Returnerar {...}-blocket som börjar vid index i. */
function block(src: string, i: number): string {
  let d = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++
    else if (src[j] === '}') {
      d--
      if (d === 0) return src.slice(i, j + 1)
    }
  }
  return src.slice(i)
}

interface Läsning {
  fil: string
  rad: number
  skuren: boolean
}

/** Varje `prisma.tenant.find*({...})` i mappen, med om den har select/omit. */
function tenantLäsningar(): Läsning[] {
  const ut: Läsning[] = []
  for (const e of readdirSync(PORTAL, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.ts') || e.name.endsWith('.spec.ts')) continue
    const src = utanKommentarer(readFileSync(join(PORTAL, e.name), 'utf8'))
    const re = /prisma\.tenant\.(findUnique|findFirst|findMany)\(\s*\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const blk = block(src, m.index + m[0].length - 1)
      const toppNycklar = new Set<string>()
      const nre = /(\w+)\s*:/g
      let n: RegExpExecArray | null
      while ((n = nre.exec(blk)) !== null) {
        const före = blk.slice(0, n.index)
        const djup = (före.match(/\{/g) ?? []).length - (före.match(/\}/g) ?? []).length
        if (djup === 1 && n[1] !== undefined) toppNycklar.add(n[1])
      }
      ut.push({
        fil: e.name,
        rad: src.slice(0, m.index).split('\n').length,
        skuren: toppNycklar.has('select') || toppNycklar.has('omit'),
      })
    }
  }
  return ut
}

describe('tenant-portal: credential-bärande läsningar går EN väg', () => {
  it('ingen bar prisma.tenant.find* utanför readTenantWithCredentials', () => {
    const läsningar = tenantLäsningar()

    // Rimlighetsgolv: hittar parsern inga läsningar alls är "inga överträdelser"
    // tomt-mängd-sant. Portalen har flera projicerade läsningar som ska hittas.
    expect(läsningar.length).toBeGreaterThanOrEqual(6)

    const bara = läsningar.filter((l) => !l.skuren).map((l) => `${l.fil}:${l.rad}`)
    expect(bara).toEqual([])
  })

  it('den brandade läsvägen används faktiskt', () => {
    // Motsatt golv: om ingen använder funktionen har konverteringen backats ut
    // och testet ovan skulle vara grönt av fel skäl (inga bara läsningar KVAR
    // för att alla ersatts med projicerade — men credentials behövs ju).
    let träffar = 0
    for (const e of readdirSync(PORTAL, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.ts') || e.name.endsWith('.spec.ts')) continue
      const src = utanKommentarer(readFileSync(join(PORTAL, e.name), 'utf8'))
      träffar += (src.match(/(read|find)(Many)?Tenants?WithCredentials\(/g) ?? []).length
    }
    // Åtta i tenant-auth.service.ts, en i controllern, en i GDPR-exporten.
    expect(träffar).toBeGreaterThanOrEqual(10)
  })
})

describe('TenantWithCredentials — typspärren biter', () => {
  it('går inte att tilldela som PublicTenant utan strippning', () => {
    // TYPNIVÅ-TEST. `@ts-expect-error` är själva assertionen: slutar raden nedan
    // vara ett fel blir direktivet i sin tur ett fel, och typechecken faller.
    //
    // Den här kontrollen finns för att ett första utkast INTE bet. PublicTenant
    // var bara `Omit<T, TenantCredentialKey>`, och den brandade typen var fritt
    // tilldelningsbar dit — ett objekt med FLER egenskaper är strukturellt
    // kompatibelt med en typ som har färre. Typen såg ut att garantera något och
    // garanterade ingenting; en tsc-probe avslöjade det, inte granskning.
    //
    // `?: never` på brandet i PublicTenant är det som stänger hålet, och den här
    // raden är det som håller det stängt.
    const kontroll = (medCreds: TenantWithCredentials): void => {
      // @ts-expect-error credential-bärande tenant får inte passera som publik form
      const läcka: PublicTenant = medCreds
      void läcka
    }
    expect(typeof kontroll).toBe('function')
  })
})
