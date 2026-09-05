/**
 * HJÄRTSLAG PER LÅST CRON-JOBB (#710).
 *
 * ── VAD SOM SAKNADES ────────────────────────────────────────────────────────
 *
 * Återupptagningsmotorn har en tystnadssignal i `/v1/health`: har den inte
 * skrivit på 2 h 15 min syns det som ett tal någon kan läsa. De ÖVRIGA nio
 * låsta jobben hade ingenting. Ett hängt lås — eller ett jobb som slutat
 * schemaläggas — var osynligt tills någon saknade dess utfall, vilket för ett
 * månadsjobb är nästa månad.
 *
 * ── VARFÖR EN TABELL OCH INTE EN REDIS-NYCKEL ───────────────────────────────
 *
 * `/v1/health` läser i dag Prisma och rör ALDRIG Redis (mätt: noll träffar på
 * redis i health.controller.ts och health.module.ts). Ett hjärtslag i Redis
 * hade lagt till ett nytt beroende — och därmed en ny felkälla — i exakt den
 * endpoint Railway pollar med `restartPolicyType = "ON_FAILURE"`. En läsning
 * som kan fallera på ett sätt endpointen inte redan kan fallera på är fel plats
 * att spara pengar på.
 *
 * Tabellen är dessutom rätt form för frågan: ett hjärtslag är EN rad per
 * nyckel som skrivs över, inte en logg. `@id` på nyckeln gör upsert till den
 * naturliga operationen.
 *
 * ── MÄNGDEN ÄR STRUKTURELL, INTE EN LISTA ───────────────────────────────────
 *
 * Hjärtslaget skrivs av `LockService.runIfUnlocked`, och dess anropare är exakt
 * de jobb ack-filen klassar som A (låsta) — elva sedan skuggsvepet (etapp 6).
 * Mängden uppstår
 * alltså av konstruktion. Kartan nedan behövs ändå, eftersom tröskeln kräver
 * jobbets SCHEMA, och det står i en dekorator i källan.
 *
 * Att kartan stämmer med verkligheten är inget man litar på: `cron-heartbeat.spec.ts`
 * härleder A-mängden ur cron-classification.ack.json OCH `@Cron`-uttrycken ur
 * källfilerna, och kräver att den här kartan är identisk med båda. Läggs ett
 * elfte A-jobb till blir specen röd tills kartan följer med.
 */

/**
 * Låst cron-jobb → dess `@Cron`-uttryck.
 *
 * Uttrycken är avskrifter av källan. Specen bevisar avskriften.
 */
export const LASTA_CRON_JOBB: Readonly<Record<string, string>> = {
  'cron:ai-assignment-expiry': '* * * * *',
  'cron:ai-resumption-freshness': '*/15 * * * *',
  'cron:ai-resumption-shadow': '* * * * *',
  'cron:ai-shadow-sweep': '*/15 * * * *',
  'cron:ai-usage-warnings': '0 9 * * *',
  'cron:daily-backup': '0 3 * * *',
  'cron:leases-lifecycle': '0 6 * * *',
  'cron:monthly-report': '0 8 1 * *',
  'cron:morning-insights': '0 7 * * 1-5',
  'cron:tenant-activation-reminders': '0 9 * * *',
  'cron:weekly-summary': '0 18 * * 0',
} as const

/**
 * Hur många gånger det MAXIMALA intervallet som får passera innan ett jobb
 * räknas som tyst.
 *
 * ── DET HÄR ÄR ETT BESLUT, INTE EN HÄRLEDNING UR RESUMPTION ─────────────────
 *
 * Uppdraget angav 2,25 med motiveringen "samma faktor som 8100 s är av 3600 s
 * för resumption". Den premissen håller inte, och båda halvorna är mätta:
 *
 *   ATERUPPTAGNING_TYSTNAD_MAX_MS = 2 h + 15 min = 8100 s
 *   dess kadens (KADENS)          = '*​/15 * * * *' = 900 s, inte 3600 s
 *   8100 / 900                    = 9, inte 2,25
 *
 * Och viktigare: resumption-freshness.service.ts säger uttryckligen att talet
 * "är skrivet som en literal och får INTE räknas fram" — två gränser som ska
 * kunna ändras var för sig får inte vara en gräns. Basen där är dessutom det
 * GARANTERADE skrivintervallet (hjärtslaget, 1 h), inte kadensen.
 *
 * ── VARFÖR EN HÄRLEDNING ÄNDÅ ÄR RÄTT HÄR ───────────────────────────────────
 *
 * Skillnaden är vad talet kopplas till. Förbjudet är att binda en gräns till en
 * ANNAN oberoende policyknapp. Här binds tröskeln till jobbets EGET schema —
 * alltså till precis det den mäter. Ändrar någon ett jobb från dagligen till
 * varje timme SKA dess tystnadströskel följa med; en literal per jobb hade
 * tvärtom blivit fel i tysthet.
 *
 * 2,25 betyder: EN missad körning tolereras, TVÅ gör det inte, plus en fjärdedel
 * marginal för deploy och omstart. Samma resonemang som BACKUP_MAX_AGE_DAYS
 * ("en missad natt tolereras, inte två") och som resumptions 2 h + 15 min.
 */
export const TYSTNAD_FAKTOR = 2.25

/**
 * Maximalt intervall mellan två körningar, i sekunder.
 *
 * ── VARFÖR MAX OCH INTE MEDEL ───────────────────────────────────────────────
 *
 * `0 7 * * 1-5` kör vardagar. Medelintervallet är ~1,4 dygn, men gapet fredag→
 * måndag är TRE dygn. En tröskel satt efter medelvärdet hade larmat varje
 * helg — ett falsklarm som återkommer varje vecka lär läsaren att ignorera
 * fältet, vilket är värre än inget fält.
 *
 * ── FAIL-CLOSED PÅ OKÄNDA FORMER ────────────────────────────────────────────
 *
 * Bara de uttrycksformer som FAKTISKT används stöds. Allt annat KASTAR i
 * stället för att gissa: ett tyst felaktigt intervall ger en tröskel som
 * antingen larmar jämt eller aldrig, och båda ser ut som att fältet fungerar.
 *
 * Formerna som stöds, och exakt varför var och en finns:
 *
 *   `* * * * *`      varje minut          ai-assignment-expiry, ai-resumption-shadow
 *   `*​/N * * * *`    var N:e minut        ai-resumption-freshness (N=15)
 *   `M H * * *`      dagligen             ai-usage-warnings, daily-backup, leases-lifecycle,
 *                                         tenant-activation-reminders
 *   `M H * * D`      en veckodag          weekly-summary (söndag)
 *   `M H * * A-B`    veckodagsintervall   morning-insights (mån–fre)
 *   `M H D * *`      en dag i månaden     monthly-report (den 1:a)
 */
export function maxIntervallSek(uttryck: string): number {
  const delar = uttryck.trim().split(/\s+/)
  if (delar.length !== 5) {
    throw new Error(
      `[cron-heartbeat] "${uttryck}" har ${delar.length} fält, inte 5. ` +
        'Formen stöds inte — se listan i maxIntervallSek.',
    )
  }
  const [min, tim, dom, mon, dow] = delar as [string, string, string, string, string]

  if (mon !== '*') {
    throw new Error(`[cron-heartbeat] månadsfältet "${mon}" stöds inte (bara "*").`)
  }

  // Varje minut, eller var N:e minut.
  if (tim === '*' && dom === '*' && dow === '*') {
    if (min === '*') return 60
    const varje = /^\*\/(\d+)$/.exec(min)
    if (varje) return Number(varje[1]) * 60
    throw new Error(`[cron-heartbeat] minutfältet "${min}" stöds inte i timvis form.`)
  }

  // Härifrån krävs fasta minut- och timvärden.
  if (!/^\d+$/.test(min) || !/^\d+$/.test(tim)) {
    throw new Error(`[cron-heartbeat] "${uttryck}" kräver fasta minut- och timfält.`)
  }
  const DYGN = 86_400

  // En bestämd dag i månaden.
  if (dom !== '*') {
    if (!/^\d+$/.test(dom)) throw new Error(`[cron-heartbeat] dagfältet "${dom}" stöds inte.`)
    if (dow !== '*') {
      throw new Error(`[cron-heartbeat] "${uttryck}" sätter både dag-i-månad och veckodag.`)
    }
    // Längsta månaden. Februari→mars är kortare; taket är det som gäller.
    return 31 * DYGN
  }

  // Dagligen.
  if (dow === '*') return DYGN

  // En enskild veckodag.
  if (/^\d+$/.test(dow)) return 7 * DYGN

  // Veckodagsintervall: största gapet mellan två på varandra följande dagar,
  // räknat CIRKULÄRT över veckan. För 1-5 är det fre→mån = 3 dygn.
  const intervall = /^(\d+)-(\d+)$/.exec(dow)
  if (intervall) {
    const från = Number(intervall[1])
    const till = Number(intervall[2])
    if (från > till) throw new Error(`[cron-heartbeat] veckodagsintervall "${dow}" är bakvänt.`)
    const dagar: number[] = []
    for (let d = från; d <= till; d++) dagar.push(d)
    let störst = 0
    for (let i = 0; i < dagar.length; i++) {
      const nu = dagar[i] as number
      const nästa = dagar[(i + 1) % dagar.length] as number
      // Cirkulärt: sista → första går över veckoskiftet.
      const gap = i === dagar.length - 1 ? 7 - nu + nästa : nästa - nu
      if (gap > störst) störst = gap
    }
    return störst * DYGN
  }

  throw new Error(`[cron-heartbeat] veckodagsfältet "${dow}" stöds inte.`)
}

/** Tystnadströskeln för ett jobb, i sekunder. */
export function tröskelSek(uttryck: string): number {
  return Math.round(maxIntervallSek(uttryck) * TYSTNAD_FAKTOR)
}

export type CronUtfall = 'success' | 'failed'
