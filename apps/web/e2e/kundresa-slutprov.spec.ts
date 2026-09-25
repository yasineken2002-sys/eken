import { test, expect } from '@playwright/test'
import { registerOrg, sqlValue, type RegisteredOrg } from './helpers/seed'

/**
 * DEN SAMMANHÄNGANDE KUNDRESAN — EN organisation, EN hyresvärdssession,
 * EN objektkedja, alla kundhandlingar i formulär.
 *
 * ── VARFÖR DEN HÄR SPECEN FINNS ─────────────────────────────────────────────
 *
 * Granskningen av nattens kundflöde (K-2) fällde en lucka som varken
 * `create-base-data`, `avi-paid-flow` eller `bankkonto-import` kunde täcka
 * ensam: de tre gör var sin bit av resan, men mot VARSIN seedad organisation.
 * SKARVEN mellan bitarna hade aldrig körts i en vy. En rigg som skapar mitten
 * över HTTP och sedan navigerar dit bevisar inte att kunden kan komma dit.
 *
 * Kedjan nedan är därför obruten och gör varje led genom UI:t:
 *
 *   logga in → Ny fastighet → Nytt objekt → Nytt kontrakt (skapa & aktivera)
 *   → Generera avier → betalningsmålsgrinden → Inställningar: bankgiro
 *   → två bankkonton → uttryckligt kontoval → importera kontoutdrag
 *   → Auto-matcha → avin Betald → bjud in RÄTT hyresgäst
 *
 * ── VAD SOM SEEDAS, OCH INGET MER ───────────────────────────────────────────
 *
 * `registerOrg` — organisation + ägare. Det är allt. Ingen fastighet, inget
 * objekt, ingen hyresgäst, inget kontrakt, ingen avi, inget bankkonto.
 * BAS-kontoplanen skapas av registreringen själv, alltså samma väg som för en
 * riktig kund.
 *
 * ── TVÅ SAKER SOM INTE KAN PROVAS HÄR, OCH VARFÖR ───────────────────────────
 *
 * 1. ATT SKICKA avin. `processNoticeSendJob` renderar PDF med Puppeteer, och
 *    puppeteer står inte i `.npmrc`:s `approved-builds` — postinstall körs
 *    aldrig, så Chrome finns inte. Samma skäl som gör `avi-pdf-50x` utlyft ur
 *    CI. Grinden som utskicket vilar på provas i stället som ett UI-faktum:
 *    knappen är `disabled` utan giltigt bankgiro och `enabled` med (steg 6/7).
 *    Utskicket självt bevisas i den isolerade riggen, inte här.
 * 2. PORTALAKTIVERING VIA LÄNK. Länken finns bara i mejlet, och mejlet kräver
 *    en lokal fångare som CI inte har. `portal-tenant-flow.spec.ts` täcker
 *    portalens egen väg med sitt eget seed-mönster.
 *
 * Ingetdera är ett `skip`: stegen är inte med i den här specen alls, och skälet
 * står här i stället för att gömmas i ett villkor.
 *
 * ── VARFÖR DB-FRÅGOR OCH INTE BARA UI ──────────────────────────────────────
 *
 * Ett grönt importsvar säger inte vilket konto raden hör till
 * (`RECONCILIATION_TRANSACTION_FIELDS` projicerar bort `bankAccountId`), och en
 * synlig "Betald"-badge säger inte att verifikatet fick rätt konton. Effekten
 * läses därför ur lagringen, med `ON_ERROR_STOP=1` — ett kolumnfel FÄLLER
 * provet i stället för att ge en tom sträng som ser ut som ett svar.
 */

const VYER = [
  { namn: 'desktop 1280x900', width: 1280, height: 900 },
  { namn: 'mobil 390x844', width: 390, height: 844 },
] as const

/** Bostadshyra → ingen moms → avins totalbelopp = månadshyran. */
const MANADSHYRA = 9500

function idag(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Kontraktet startar den FÖRSTA i föregående månad. Två mätta skäl, inget av
 * dem en stilfråga:
 *
 *  1. FULL HYRA. Med formulärets default (dagens datum) blir aviseringen
 *     PRORATAD — uppmätt 1 900,00 av 9 500,00 den 25:e. Ett provbelopp som
 *     ändras med dagen i månaden går inte att asserta.
 *  2. EN PENDING-AVI ATT BETALA. Aktiveringen skapar initialavin för
 *     startmånaden OCH försöker skicka den; utan bankgiro fastnar den i FAILED
 *     (K2:s betalningsmålsgrind). `matchTransaction` slår upp avin på
 *     `status in (SENT, PENDING, OVERDUE)` — FAILED är INTE med, så en
 *     FAILED-avi kan inte matchas. Med start i förra månaden hamnar
 *     initialavin där, och månadens egen "Generera avier" skapar en PENDING-avi
 *     för innevarande månad, som är den resan betalar.
 */
function forstaIForraManaden(): string {
  const d = new Date()
  const f = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-01`
}

/**
 * Bank-CSV i det generiska formatet. `Referens` är den kolumn `REF_KEYS`
 * plockar upp som `rawOcr`, och OCR:et är det som låter automatchningen hitta
 * avin — därför läses det UR VYN och skrivs in här, i stället för att gissas.
 *
 * Radidentiteten är (konto, datum, beskrivning, belopp, referens)
 * — `filIdentitet` i `bank-import-identity.ts`. En rad som ska vara en DUBBLETT
 * måste alltså upprepa alla fem, och en rad som ska vara NY får skilja sig i
 * minst en av dem.
 */
function csvFil(namn: string, rader: Array<{ beskrivning: string; belopp: number; ocr: string }>) {
  const text = [
    'Datum;Beskrivning;Belopp;Referens',
    ...rader.map((r) => `${idag()};${r.beskrivning};${r.belopp},00;${r.ocr}`),
  ].join('\n')
  return { name: namn, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') }
}

/** En rad ur lagringen. Tom sträng är ett SVAR (ingen rad), inte ett fel — ett
 *  fel kastar redan i `sqlValue` tack vare ON_ERROR_STOP. */
function db(sql: string): string {
  return sqlValue(sql)
}

/**
 * `--disable-dev-shm-usage` — MÄTT, inte kopierat från en guide.
 *
 * Resan är lång och håller mycket i en flik. Desktop-vyn (1280×900) dog med
 * `locator.click: Target crashed` medan mobilvyn (390×844) passerade i samma
 * körning; skillnaden är hur mycket renderaren håller i delat minne.
 * `df -h /dev/shm` i den här miljön: **64 MB**. Chromium lägger sina
 * delade buffertar där som standard och kraschar när utrymmet tar slut.
 * Flaggan flyttar dem till /tmp.
 *
 * Det är en EGENSKAP HOS KÖRMILJÖN, inte hos appen eller provet, och den
 * gäller containrar i allmänhet — därför står flaggan här och inte i en
 * lokal workaround.
 */
test.use({ launchOptions: { args: ['--disable-dev-shm-usage'] } })

test.describe('kundresan i en session', () => {
  for (const vy of VYER) {
    test(`${vy.namn}: hela kundresan med mätt effekt per steg`, async ({ page, playwright }) => {
      // Resan är lång och rör en Bull-kö (kontraktsaktivering) — den behöver
      // mer än standardtimeouten, och det ska stå här och inte gissas.
      test.setTimeout(300_000)

      // ── SEED (inte en browserhandling) ──────────────────────────────────
      const request = await playwright.request.newContext()
      const org: RegisteredOrg = await registerOrg(request)
      await request.dispose()

      const st = String(Date.now())
      const FASTIGHET = `Slutprov Storgatan ${st}`
      const OBJEKT = `Lgh ${st.slice(-4)}`
      const OBJEKTNUMMER = st.slice(-4)
      const HYRESGAST_FORNAMN = 'Kundresa'
      const HYRESGAST_EFTERNAMN = `Provsson ${st.slice(-4)}`
      const HYRESGAST_EPOST = `e2e.kundresa+${st}@eveno.test`
      const KONTO_AVSETT = `Foretagskonto ${st}`
      const KONTO_ANNAT = `Klientmedel ${st}`
      const KONTONUMMER = '5492-1234567'
      const BANKGIRO = '5050-1055'

      await page.setViewportSize({ width: vy.width, height: vy.height })

      // ── 1. BROWSERHANDLING: logga in ────────────────────────────────────
      await page.goto('/login')
      await page.getByLabel('E-postadress').fill(org.email)
      await page.locator('input[autocomplete="current-password"]').fill(org.password)
      await page.getByRole('button', { name: 'Logga in', exact: true }).click()
      await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })

      const orgId = db(
        `SELECT o.id FROM "Organization" o
           JOIN "User" u ON u."organizationId" = o.id
          WHERE u.email = '${org.email}'`,
      )
      expect(orgId).toMatch(/^[0-9a-f-]{36}$/)

      // ── 2. BROWSERHANDLING: Ny fastighet ────────────────────────────────
      await page.goto('/properties')
      await page.getByRole('button', { name: 'Ny fastighet' }).first().click()
      await expect(page.getByRole('heading', { name: 'Ny fastighet' })).toBeVisible()
      await page.getByLabel('Fastighetsnamn').fill(FASTIGHET)
      await page.getByLabel('Fastighetsbeteckning').fill(`Slutprov ${st.slice(-4)}:1`)
      await page.getByLabel('Typ').selectOption('RESIDENTIAL')
      await page.getByLabel('Gatuadress').fill('Provgatan 1')
      await page.getByLabel('Postnummer').fill('111 22')
      await page.getByLabel('Stad').fill('Stockholm')
      await page.getByLabel('Total yta (m²)').fill('500')
      await page.locator('form').getByRole('button', { name: 'Skapa fastighet' }).click()
      await expect(page.getByRole('heading', { name: 'Ny fastighet' })).toBeHidden()
      await expect(page.getByText(FASTIGHET).first()).toBeVisible({ timeout: 15_000 })

      const propertyId = db(
        `SELECT id FROM "Property" WHERE name = '${FASTIGHET}' AND "organizationId" = '${orgId}'`,
      )
      expect(propertyId).toMatch(/^[0-9a-f-]{36}$/)

      // ── 3. BROWSERHANDLING: Nytt objekt ─────────────────────────────────
      await page.goto('/units')
      await page.getByRole('button', { name: 'Nytt objekt' }).first().click()
      await expect(page.getByRole('heading', { name: 'Nytt objekt' })).toBeVisible()
      await page.getByLabel('Fastighet').selectOption({ label: FASTIGHET })
      await page.getByLabel('Enhetsnamn').fill(OBJEKT)
      await page.getByLabel('Enhetsnummer').fill(OBJEKTNUMMER)
      await page.getByLabel('Typ').selectOption('APARTMENT')
      await page.getByLabel('Status').selectOption('VACANT')
      await page.getByLabel('Area (m²)').fill('68')
      await page.getByLabel('Månadshyra (kr)').fill(String(MANADSHYRA))
      await page.locator('form').getByRole('button', { name: 'Skapa objekt' }).click()
      await expect(page.getByRole('heading', { name: 'Nytt objekt' })).toBeHidden()
      await expect(page.getByText(OBJEKT).first()).toBeVisible({ timeout: 15_000 })

      // Objektet hör till FASTIGHETEN i kedjan — inte bara "ett objekt finns".
      // `Unit` bär INGEN `organizationId` (kolumnerna lästa ur schemat, inte
      // gissade — det var just den gissningen som fällde första körningen).
      // Org-tillhörigheten går via fastigheten, som är rätt väg i modellen.
      expect(
        db(`SELECT u."propertyId" FROM "Unit" u
              JOIN "Property" p ON p.id = u."propertyId"
             WHERE u."unitNumber" = '${OBJEKTNUMMER}' AND p."organizationId" = '${orgId}'`),
      ).toBe(propertyId)

      // ── 4. BROWSERHANDLING: Nytt kontrakt → skapa & aktivera ────────────
      await page.goto('/leases')
      await page.getByRole('button', { name: 'Nytt kontrakt' }).first().click()
      await expect(page.getByRole('heading', { name: 'Nytt hyresavtal' })).toBeVisible()
      const formular = page.locator('form')
      await formular.locator('select').nth(0).selectOption({ label: FASTIGHET })
      const objektValjare = formular.locator('select').nth(1)
      await expect(objektValjare.locator('option', { hasText: OBJEKT })).toHaveCount(1, {
        timeout: 15_000,
      })
      await objektValjare.selectOption({ label: `${OBJEKT} (${OBJEKTNUMMER})` })
      await page.getByLabel('Förnamn').fill(HYRESGAST_FORNAMN)
      await page.getByLabel('Efternamn').fill(HYRESGAST_EFTERNAMN)
      await page.getByLabel('E-post').fill(HYRESGAST_EPOST)
      // Startdatum sätts UTTRYCKLIGT — se kommentaren vid forstaIForraManaden().
      await page.getByLabel('Startdatum').fill(forstaIForraManaden())
      await page.getByRole('button', { name: /Skapa & aktivera direkt/ }).click()
      await expect(page.getByRole('heading', { name: 'Nytt hyresavtal' })).toBeHidden({
        timeout: 20_000,
      })
      const avtalsrad = page
        .getByRole('row')
        .filter({ hasText: `${HYRESGAST_FORNAMN} ${HYRESGAST_EFTERNAMN}` })
      await expect(avtalsrad).toBeVisible({ timeout: 20_000 })
      await expect(avtalsrad.getByText('Aktivt', { exact: true })).toBeVisible()

      const tenantId = db(
        `SELECT id FROM "Tenant" WHERE email = '${HYRESGAST_EPOST}' AND "organizationId" = '${orgId}'`,
      )
      expect(tenantId).toMatch(/^[0-9a-f-]{36}$/)
      const leaseId = db(
        `SELECT id FROM "Lease" WHERE "tenantId" = '${tenantId}' AND "organizationId" = '${orgId}'`,
      )
      expect(db(`SELECT status FROM "Lease" WHERE id = '${leaseId}'`)).toBe('ACTIVE')

      // ── 5a. AKTIVERINGENS EGEN AVI — och varför den är FAILED ───────────
      //
      // Lease-aktiveringen köar `create-initial-notices`. Avin gäller
      // STARTMÅNADEN (förra månaden) och fastnar i FAILED därför att utskicket
      // möter K2:s betalningsmålsgrind utan bankgiro. Det är inte ett fel — det
      // är grinden — och `sendError` säger det ordagrant.
      const foregaende = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)
      await expect
        .poll(
          () =>
            db(`SELECT count(*) FROM "RentNotice"
                  WHERE "leaseId" = '${leaseId}' AND month = ${foregaende.getMonth() + 1}`),
          { timeout: 90_000, message: 'aktiveringens initialavi skapades aldrig' },
        )
        .toBe('1')
      const initialAvi = db(
        `SELECT id FROM "RentNotice"
          WHERE "leaseId" = '${leaseId}' AND month = ${foregaende.getMonth() + 1}`,
      )
      // Full hyra, ingen proration — det är vad startdatumet den 1:a köper oss.
      expect(db(`SELECT "totalAmount" FROM "RentNotice" WHERE id = '${initialAvi}'`)).toBe(
        `${MANADSHYRA}.00`,
      )
      await expect
        .poll(() => db(`SELECT status FROM "RentNotice" WHERE id = '${initialAvi}'`), {
          timeout: 60_000,
          message: 'initialavin nådde aldrig FAILED (utskicksförsöket kördes inte)',
        })
        .toBe('FAILED')
      expect(db(`SELECT "sendError" FROM "RentNotice" WHERE id = '${initialAvi}'`)).toContain(
        'Bankgiro saknas',
      )

      // ── 6. BROWSERHANDLING: betalningsmålsgrinden, UTAN bankgiro ────────
      //
      // Grinden mäts på DEN HÄR avin och inte på månadens, av ett mätt skäl:
      // skicka-knappen renderas bara för PENDING/FAILED, och en avi vars
      // förfallodag passerat flippas till OVERDUE av `checkAndMarkOverdue`. En
      // grindassertion på månadens avi hade alltså varit ett kapplöpning mot en
      // cron. FAILED är däremot stabilt: det sattes av grinden själv.
      await page.goto('/avisering')
      await expect(page.getByRole('heading', { name: 'Hyresavier' })).toBeVisible()
      await page
        .locator('select')
        .first()
        .selectOption(String(foregaende.getMonth() + 1))
      await page.locator('select').nth(1).selectOption(String(foregaende.getFullYear()))
      const initialRad = page.getByRole('row').filter({ hasText: HYRESGAST_EFTERNAMN })
      await expect(initialRad).toBeVisible({ timeout: 20_000 })
      await expect(initialRad.getByTitle(/bankgiro saknas eller är ogiltigt/)).toBeVisible()
      await expect(initialRad.getByTitle(/bankgiro saknas eller är ogiltigt/)).toBeDisabled()

      // ── 7. BROWSERHANDLING: Inställningar → Bankgiro → Spara ────────────
      await page.goto('/settings')
      await page.getByLabel('Bankgiro').fill(BANKGIRO)
      await page
        .locator('form')
        .filter({ has: page.getByLabel('Bankgiro') })
        .getByRole('button', { name: 'Spara', exact: true })
        .click()
      await expect(page.getByText('Sparat!')).toBeVisible({ timeout: 15_000 })
      expect(db(`SELECT bankgiro FROM "Organization" WHERE id = '${orgId}'`)).toBe(BANKGIRO)

      // SAMMA avi, SAMMA knapp — nu ÖPPEN. Grinden mäts i BÅDA riktningarna;
      // en spärr som bara prövas i ett läge kan inte skilja "spärrad" från
      // "alltid spärrad".
      await page.goto('/avisering')
      await page
        .locator('select')
        .first()
        .selectOption(String(foregaende.getMonth() + 1))
      await page.locator('select').nth(1).selectOption(String(foregaende.getFullYear()))
      const initialRad2 = page.getByRole('row').filter({ hasText: HYRESGAST_EFTERNAMN })
      await expect(initialRad2.getByTitle('Skicka om avi')).toBeEnabled({ timeout: 20_000 })

      // ── 7b. BROWSERHANDLING: Generera avier för innevarande månad ───────
      const nu = new Date()
      await page
        .locator('select')
        .first()
        .selectOption(String(nu.getMonth() + 1))
      await page.locator('select').nth(1).selectOption(String(nu.getFullYear()))
      await page.getByRole('button', { name: 'Generera avier' }).first().click()
      await expect(page.getByRole('heading', { name: 'Generera hyresavier' })).toBeVisible()
      // Förhandsvisningen ska säga EXAKT en ny avi. Bekräfta-knappen är spärrad
      // tills förhandsvisningen är klar och talet > 0 (GenerateModal), så ett
      // klick utan den här assertionen kunde vara ett klick på fel läge.
      await expect(page.getByText('1 nya avier att skapa')).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: 'Generera avier' }).last().click()

      const avirad = page.getByRole('row').filter({ hasText: HYRESGAST_EFTERNAMN })
      await expect(avirad).toBeVisible({ timeout: 30_000 })

      const noticeId = db(
        `SELECT id FROM "RentNotice"
          WHERE "leaseId" = '${leaseId}' AND month = ${nu.getMonth() + 1} AND year = ${nu.getFullYear()}`,
      )
      expect(noticeId).toMatch(/^[0-9a-f-]{36}$/)
      expect(noticeId).not.toBe(initialAvi)
      expect(db(`SELECT "totalAmount" FROM "RentNotice" WHERE id = '${noticeId}'`)).toBe(
        `${MANADSHYRA}.00`,
      )
      // STATUSEN ÄR EN MÄNGD, OCH DET ÄR MÄTT: hyran för innevarande månad
      // förfaller i slutet av FÖREGÅENDE månad (uppmätt: september-avin förföll
      // 2026-08-31), så förfallodagen har alltid passerat. Om `checkAndMarkOverdue`
      // har hunnit köra är avin OVERDUE, annars PENDING. BÅDA är matchbara
      // (`matchTransaction` slår upp SENT|PENDING|OVERDUE) och skillnaden är en
      // cron-tidpunkt, inte en produktegenskap det här provet handlar om.
      // Att låsa den till ett av värdena hade gjort provet flakigt av ett skäl
      // som inte har med kundresan att göra.
      const avistatus = db(`SELECT status FROM "RentNotice" WHERE id = '${noticeId}'`)
      expect(['PENDING', 'OVERDUE']).toContain(avistatus)

      // OCR:et LÄSES UR VYN — det hyresvärden ser och det som ska stå på
      // inbetalningen. Att hämta det ur databasen hade varit att prova sig själv.
      const ocr = (
        await avirad
          .getByText(/^\d{11}$/)
          .first()
          .innerText()
      ).trim()
      expect(ocr).toMatch(/^\d{11}$/)
      expect(db(`SELECT "ocrNumber" FROM "RentNotice" WHERE id = '${noticeId}'`)).toBe(ocr)

      // ── 8. BROWSERHANDLING: två bankkonton i UI ─────────────────────────
      await page.goto('/reconciliation')
      const kontokort = page.getByTestId('bank-accounts-card')
      await expect(kontokort).toBeVisible({ timeout: 15_000 })
      await page.getByTestId('lagg-till-bankkonto').click()
      await page.getByLabel('Namn på kontot').fill(KONTO_AVSETT)
      await page.getByLabel('Kontonummer (valfritt)').fill(KONTONUMMER)
      await page.getByRole('button', { name: 'Spara konto' }).click()
      await expect(kontokort).toContainText(KONTO_AVSETT, { timeout: 15_000 })

      await page.getByTestId('lagg-till-bankkonto').click()
      await page.getByLabel('Namn på kontot').fill(KONTO_ANNAT)
      await page.getByRole('button', { name: 'Spara konto' }).click()
      await expect(kontokort).toContainText('2 aktiva konton', { timeout: 15_000 })

      const kontoAvsettId = db(
        `SELECT id FROM "BankAccount" WHERE name = '${KONTO_AVSETT}' AND "organizationId" = '${orgId}'`,
      )
      expect(kontoAvsettId).toMatch(/^[0-9a-f-]{36}$/)

      // ── 9. BROWSERHANDLING: flerkontoläget gissar inte ──────────────────
      await page.reload()
      await page.getByRole('button', { name: 'Importera kontoutdrag' }).first().click()
      await expect(page.getByRole('heading', { name: 'Importera kontoutdrag' })).toBeVisible()
      const valjare = page.locator('#bankkonto')
      await expect(valjare).toHaveValue('')
      await expect(page.getByTestId('import-kontobesked')).toContainText(
        'Välj vilket bankkonto importen gäller',
      )

      const RAD_HYRA = `Hyra ${HYRESGAST_EFTERNAMN}`
      const importknapp = page.getByRole('button', { name: 'Importera', exact: true })
      await page
        .locator('input[type="file"]')
        .setInputFiles(
          csvFil('kundresa-hyra.csv', [{ beskrivning: RAD_HYRA, belopp: MANADSHYRA, ocr }]),
        )
      // Fil vald men inget konto: spärrad. Systemet får inte välja åt operatören.
      await expect(importknapp).toBeDisabled()

      // ── 10. BROWSERHANDLING: uttryckligt kontoval ───────────────────────
      await valjare.selectOption({ label: `${KONTO_AVSETT} (${KONTONUMMER})` })
      await expect(valjare.locator('option:checked')).toHaveText(`${KONTO_AVSETT} (${KONTONUMMER})`)
      await expect(importknapp).toBeEnabled()

      // ── 11. BROWSERHANDLING: importera, och matchningen sker I importen ──
      //
      // MÄTT, OCH DET ÄNDRADE PROVET: importen automatchar INLINE när OCR:et
      // löser ut. Resultatpanelen redovisar det, och `Auto-matcha`-knappen är
      // därefter korrekt SPÄRRAD (`disabled={unmatchedCount === 0}`) — det finns
      // inget kvar att matcha. Provet klickade först på den knappen och
      // timeoutade i 300 s mot ett läge som var rätt. Assertionen ligger nu där
      // utfallet faktiskt syns.
      await importknapp.click()
      await expect(page.getByText('1 transaktioner importerade')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('1 automatiskt matchade via OCR')).toBeVisible()
      await expect(page.getByText('0 väntar på matchning')).toBeVisible()
      await page.getByRole('button', { name: 'Stäng', exact: true }).last().click()
      await expect(page.getByText(RAD_HYRA).first()).toBeVisible({ timeout: 15_000 })

      // KONTOVALET FICK INTE TYST BYTAS. Avstämningsvyn projicerar bort
      // `bankAccountId`, så frågan ställs mot lagringen.
      const radensKonto = db(
        `SELECT COALESCE(ba.name, '(inget konto)') FROM "BankTransaction" bt
           LEFT JOIN "BankAccount" ba ON ba.id = bt."bankAccountId"
          WHERE bt.description = '${RAD_HYRA}' AND bt."organizationId" = '${orgId}'`,
      )
      expect(radensKonto).toBe(KONTO_AVSETT)
      expect(
        db(`SELECT count(*) FROM "BankTransaction" bt JOIN "BankAccount" ba
              ON ba.id = bt."bankAccountId" WHERE ba.name = '${KONTO_ANNAT}'`),
      ).toBe('0')

      // ── 12. INGET VÄNTAR: Auto-matcha är spärrad, och det är ett svar ────
      // Knappen är `disabled` när `stats.unmatched === 0`. Att den är spärrad
      // efter importen är alltså beviset för att inget lämnades ohanterat — inte
      // ett hinder. En knapp som vore ENABLED här hade betytt att matchningen
      // uteblev.
      await expect(page.getByRole('button', { name: 'Auto-matcha' })).toBeDisabled()

      const txId = db(
        `SELECT id FROM "BankTransaction" WHERE description = '${RAD_HYRA}'
           AND "organizationId" = '${orgId}'`,
      )
      expect(db(`SELECT status FROM "BankTransaction" WHERE id = '${txId}'`)).toBe('MATCHED')
      expect(db(`SELECT "matchedRentNoticeId" FROM "BankTransaction" WHERE id = '${txId}'`)).toBe(
        noticeId,
      )

      // ── 13. BROWSERHANDLING: avin visas som Betald ──────────────────────
      await page.goto('/avisering')
      await page
        .locator('select')
        .first()
        .selectOption(String(nu.getMonth() + 1))
      await page.locator('select').nth(1).selectOption(String(nu.getFullYear()))
      const betaldRad = page.getByRole('row').filter({ hasText: HYRESGAST_EFTERNAMN })
      await expect(betaldRad.getByText('Betald', { exact: true })).toBeVisible({ timeout: 20_000 })

      expect(db(`SELECT status FROM "RentNotice" WHERE id = '${noticeId}'`)).toBe('PAID')
      expect(db(`SELECT "paidAmount" FROM "RentNotice" WHERE id = '${noticeId}'`)).toBe(
        `${MANADSHYRA}.00`,
      )
      // Allokeringen hör till DEN HÄR avin och kommer från bankavstämningen.
      expect(
        db(`SELECT source FROM "RentNoticePayment" WHERE "rentNoticeId" = '${noticeId}'`),
      ).toBe('BANK_RECONCILIATION')
      expect(
        db(`SELECT amount FROM "RentNoticePayment" WHERE "rentNoticeId" = '${noticeId}'`),
      ).toBe(`${MANADSHYRA}.00`)

      // ── K-1: VERIFIKATEN SOM HÖR TILL DEN HÄR RESAN ─────────────────────
      //
      // Granskningen (K-1) hade bara `antal` och global `sum(debit)|sum(credit)`.
      // Här läses posterna, deras org, deras relation och deras konton.
      //
      // KONTRAKTET ÄR LÄST I KODEN, INTE GISSAT — och det motsäger den
      // föreslagna assertionen. `accounting.service.ts`:
      //
      //   createJournalEntryForRentNotice         source 'INVOICE'
      //                                          sourceId `rent-notice:<noticeId>`
      //   createJournalEntryForRentNoticePayment  source 'PAYMENT'
      //                                          sourceId `rent-notice-bank-payment:<allokeringId>`
      //
      // BÅDA är PREFIXADE, och betalningens pekar på ALLOKERINGEN
      // (`RentNoticePayment.id`) — inte på avin. Granskaren föreslog
      // "betalningsverifikatets sourceId är avins id"; det är fel på två sätt.
      // Uppmätt i riggen:
      //   PAYMENT sourceId  rent-notice-bank-payment:118f6788-…
      //   RentNoticePayment.id                      118f6788-…
      // Ingen bokföringsregel ändras för att passa förslaget — provet beskriver
      // det verkliga kontraktet, och relationen till avin bärs av allokeringen.
      const aviVerifikat = db(
        `SELECT id FROM "JournalEntry"
          WHERE "organizationId" = '${orgId}' AND source = 'INVOICE'
            AND "sourceId" = 'rent-notice:${noticeId}'`,
      )
      expect(aviVerifikat).toMatch(/^[0-9a-f-]{36}$/)

      const allokeringId = db(
        `SELECT id FROM "RentNoticePayment" WHERE "rentNoticeId" = '${noticeId}'`,
      )
      expect(allokeringId).toMatch(/^[0-9a-f-]{36}$/)
      const betalVerifikat = db(
        `SELECT id FROM "JournalEntry"
          WHERE "organizationId" = '${orgId}' AND source = 'PAYMENT'
            AND "sourceId" = 'rent-notice-bank-payment:${allokeringId}'`,
      )
      expect(betalVerifikat).toMatch(/^[0-9a-f-]{36}$/)

      // Allokeringen är knuten till DEN banktransaktion resan importerade.
      expect(
        db(`SELECT "bankTransactionId" FROM "RentNoticePayment" WHERE id = '${allokeringId}'`),
      ).toBe(txId)

      // EXAKT tre verifikat i den här organisationen, och talet är härlett ur
      // resan och inte valt: TVÅ intäktsverifikat (aktiveringens initialavi för
      // förra månaden + månadens genererade avi — verifikatet skapas vid
      // AVISERING, oavsett om utskicket lyckades) och ETT betalningsverifikat.
      expect(db(`SELECT count(*) FROM "JournalEntry" WHERE "organizationId" = '${orgId}'`)).toBe(
        '3',
      )
      expect(
        db(`SELECT count(*) FROM "JournalEntry"
              WHERE "organizationId" = '${orgId}' AND source = 'INVOICE'`),
      ).toBe('2')
      expect(
        db(`SELECT count(*) FROM "JournalEntry"
              WHERE "organizationId" = '${orgId}' AND source = 'PAYMENT'`),
      ).toBe('1')
      // Och initialavin har sitt EGET verifikat — de två blandas inte ihop.
      const initialVerifikat = db(
        `SELECT id FROM "JournalEntry"
          WHERE "organizationId" = '${orgId}' AND source = 'INVOICE'
            AND "sourceId" = 'rent-notice:${initialAvi}'`,
      )
      expect(initialVerifikat).toMatch(/^[0-9a-f-]{36}$/)
      expect(initialVerifikat).not.toBe(aviVerifikat)
      // …och varje RAD hör till ett av dem, alltså till rätt org.
      expect(
        db(`SELECT count(*) FROM "JournalEntryLine" jel
              JOIN "JournalEntry" je ON je.id = jel."journalEntryId"
             WHERE je."organizationId" <> '${orgId}'
               AND jel."journalEntryId" IN ('${aviVerifikat}', '${betalVerifikat}')`),
      ).toBe('0')

      // KONTONA OCH BELOPPEN PER HÄNDELSE, via Account.number — inte en global
      // balans. `debit`/`credit` är Decimal och renderas med två decimaler.
      const rader = (verifikatId: string) =>
        db(
          `SELECT string_agg(
                    a.number || ':' ||
                    CASE WHEN COALESCE(jel.debit, 0) <> 0
                         THEN 'D' || jel.debit::text ELSE 'K' || jel.credit::text END,
                    ' ' ORDER BY a.number)
             FROM "JournalEntryLine" jel
             JOIN "Account" a ON a.id = jel."accountId"
            WHERE jel."journalEntryId" = '${verifikatId}'`,
        )
      // Bostad (APARTMENT) → intäktskonto 3911 (REVENUE_ACCOUNT_BY_UNIT_TYPE),
      // ingen moms. Fordran 1510 debiteras vid avisering.
      expect(rader(aviVerifikat)).toBe(`1510:D${MANADSHYRA}.00 3911:K${MANADSHYRA}.00`)
      // Inbetalning: likvid 1930 debiteras, fordran 1510 krediteras.
      expect(rader(betalVerifikat)).toBe(`1510:K${MANADSHYRA}.00 1930:D${MANADSHYRA}.00`)

      // Serie och verifikationsnummer: samma serie, aviseringen före betalningen.
      const serie = db(`SELECT series FROM "JournalEntry" WHERE id = '${aviVerifikat}'`)
      expect(serie).not.toBe('')
      expect(db(`SELECT series FROM "JournalEntry" WHERE id = '${betalVerifikat}'`)).toBe(serie)
      const nrAvi = Number(
        db(`SELECT "verNumber" FROM "JournalEntry" WHERE id = '${aviVerifikat}'`),
      )
      const nrBet = Number(
        db(`SELECT "verNumber" FROM "JournalEntry" WHERE id = '${betalVerifikat}'`),
      )
      expect(nrAvi).toBeGreaterThan(0)
      expect(nrBet).toBeGreaterThan(nrAvi)

      // ── K-3: RADNIVÅNS DEDUP, SKILD FRÅN FILNIVÅNS ARRENDE ──────────────
      //
      // Nattens riktning 1 ("samma fil igen") fälldes av `BankImportAttempt`:s
      // arrende — `replayed: true`, andra anropet gjorde INGET arbete. Det mäter
      // filnivån, inte radidentiteten.
      //
      // Här importeras en FAKTISKT NY fil (andra bytes ⇒ annat fingeravtryck) med
      // (a) en rad identisk med den redan importerade — samma konto, datum,
      //     beskrivning, belopp och referens, alltså hela `filIdentitet`-nyckeln
      // (b) en NY legitim rad.
      //
      // Mekanismen som bär utfallet är fält-dedupen i `filIdentitet`
      // (bankAccountId + date + description + amount + reference), speglad i
      // kolumnen `identityKey`. Den är INTE `externalId`: det fältet sätts bara
      // av PSD2-API-vägen (`reconciliation.service.ts:498`), aldrig av filvägen.
      const RAD_NY = `Extra inbetalning ${st.slice(-4)}`
      const antalFore = db(
        `SELECT count(*) FROM "BankTransaction" WHERE "organizationId" = '${orgId}'`,
      )
      const allokeringarFore = db(
        `SELECT count(*) FROM "RentNoticePayment" WHERE "rentNoticeId" = '${noticeId}'`,
      )

      await page.goto('/reconciliation')
      await page.getByRole('button', { name: 'Importera kontoutdrag' }).first().click()
      await expect(page.getByRole('heading', { name: 'Importera kontoutdrag' })).toBeVisible()
      const valjare2 = page.locator('#bankkonto')
      await valjare2.selectOption({ label: `${KONTO_AVSETT} (${KONTONUMMER})` })
      await page.locator('input[type="file"]').setInputFiles(
        csvFil('kundresa-dedup.csv', [
          { beskrivning: RAD_HYRA, belopp: MANADSHYRA, ocr },
          { beskrivning: RAD_NY, belopp: 250, ocr: '' },
        ]),
      )
      await page.getByRole('button', { name: 'Importera', exact: true }).click()

      // ANDRA ANROPET GJORDE ARBETE: en ny rad in, en dubblett bort. Hade filens
      // arrende svarat i stället hade ingenting hänt alls.
      await expect(page.getByText('1 transaktioner importerade')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('1 dubbletter hoppades över')).toBeVisible()
      await page.getByRole('button', { name: 'Stäng', exact: true }).last().click()

      // Den gamla raden dubblerades INTE …
      expect(
        db(`SELECT count(*) FROM "BankTransaction"
              WHERE "organizationId" = '${orgId}' AND description = '${RAD_HYRA}'`),
      ).toBe('1')
      // … och den legitima nya raden tappades INTE.
      expect(
        db(`SELECT count(*) FROM "BankTransaction"
              WHERE "organizationId" = '${orgId}' AND description = '${RAD_NY}'`),
      ).toBe('1')
      expect(
        Number(db(`SELECT count(*) FROM "BankTransaction" WHERE "organizationId" = '${orgId}'`)),
      ).toBe(Number(antalFore) + 1)

      // Betalningen dubblerades inte heller: allokering, avi och verifikat orörda.
      expect(
        db(`SELECT count(*) FROM "RentNoticePayment" WHERE "rentNoticeId" = '${noticeId}'`),
      ).toBe(allokeringarFore)
      expect(db(`SELECT "paidAmount" FROM "RentNotice" WHERE id = '${noticeId}'`)).toBe(
        `${MANADSHYRA}.00`,
      )
      expect(db(`SELECT count(*) FROM "JournalEntry" WHERE "organizationId" = '${orgId}'`)).toBe(
        '3',
      )

      // VILKEN MEKANISM SOM BAR UTFALLET, mätt i raden: identityKey är satt,
      // externalId är NULL. Filvägen sätter aldrig externalId.
      expect(
        db(`SELECT CASE WHEN "identityKey" IS NULL THEN 'NULL' ELSE 'SATT' END
              FROM "BankTransaction" WHERE description = '${RAD_HYRA}'
                AND "organizationId" = '${orgId}'`),
      ).toBe('SATT')
      expect(
        db(`SELECT CASE WHEN "externalId" IS NULL THEN 'NULL' ELSE 'SATT' END
              FROM "BankTransaction" WHERE description = '${RAD_HYRA}'
                AND "organizationId" = '${orgId}'`),
      ).toBe('NULL')

      // ── 14. BROWSERHANDLING: bjud in RÄTT hyresgäst ─────────────────────
      await page.goto('/tenants')
      await page.getByRole('button', { name: 'Bjud in till portalen' }).first().click()
      await expect(page.getByRole('heading', { name: 'Bjud in till portalen' })).toBeVisible()
      // Listan hämtas asynkront (useInviteStatus) — vänta in den, annars filtreras
      // ett tomt läge.
      await expect(page.getByRole('dialog').getByText('Laddar…')).toBeHidden({ timeout: 20_000 })
      // MODALENS lista är <label>-rader, INTE en tabell. `getByRole('row')` träffade
      // därför hyresgästtabellen BAKOM modalen, vars rad saknar kryssruta —
      // uppmätt som `locator.check: Test timeout` i 300 s. Sökningen scopas till
      // dialogen och till dess label, vilket är det element kryssrutan bor i.
      const dialog = page.getByRole('dialog')
      const hyresgastrad = dialog
        .locator('label')
        .filter({ hasText: `${HYRESGAST_FORNAMN} ${HYRESGAST_EFTERNAMN}` })
      await expect(hyresgastrad).toBeVisible({ timeout: 15_000 })
      const kryssruta = hyresgastrad.locator('input[type="checkbox"]')
      // En ej valbar rad (aktiverad hyresgäst eller saknad mejl) har kryssrutan
      // `disabled`. Att den är valbar är i sig ett påstående om urvalet.
      await expect(kryssruta).toBeEnabled()
      await kryssruta.check()
      await page.getByRole('button', { name: /Bjud in valda \(1\)/ }).click()
      await expect(page.getByText(/1 inbjudna/)).toBeVisible({ timeout: 20_000 })

      expect(
        db(`SELECT CASE WHEN "invitedAt" IS NULL THEN 'NULL' ELSE 'SATT' END
              FROM "Tenant" WHERE id = '${tenantId}'`),
      ).toBe('SATT')
      expect(db(`SELECT "inviteCount" FROM "Tenant" WHERE id = '${tenantId}'`)).toBe('1')
    })
  }
})
