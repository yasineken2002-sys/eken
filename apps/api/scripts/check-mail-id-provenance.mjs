#!/usr/bin/env node
/**
 * ETT KORRELATIONS-ID SKRIVS FRÅN persistResendId — ALDRIG FRÅN enqueue (#653).
 *
 * ── DEFEKTEN VAKTEN FINNS FÖR ───────────────────────────────────────────────
 *
 * `MailQueue.enqueue` returnerar **Bulls jobId** (= idempotensnyckeln, t.ex.
 * `rent-reminder-<id>`). Resends `email_id` finns FÖRST efter att workern anropat
 * `resend.emails.send()`. Två skilda namnrymder.
 *
 * I #651 skrevs `RentNotice.reminderMessageId` med enqueue:s returvärde medan
 * webhooken frågade på `email_id`. De kunde aldrig matcha. `EMAIL_DELIVERED`
 * skrevs ALDRIG, INV-B-grinden kunde aldrig släppa fram en avi, och hela
 * kravtrappan var död vid steg 3→4 — fail-closed, alltså osynligt.
 *
 * Det tog en PRODUKTIONSMÄTNING att se det. Koden såg rätt ut: ett fält som
 * heter `messageId` sattes till returvärdet från en metod som heter
 * `sendRentNoticeReminder`, och två specar var gröna (den ena mockade
 * mejltjänsten till att returnera ett värde som EFTERLIKNADE formen på ett
 * Resend-id). Den här vakten gör frågan billig, och ställer den varje gång.
 *
 * ── REGLERNA ────────────────────────────────────────────────────────────────
 *
 *   R1 OMFÅNG    Mängden skrivningar HÄRLEDS ur koden. Tom mängd = vakten har
 *                gått blind och fäller.
 *   R2 HÄRKOMST  Varje skrivning ska ske i `persistResendId`, vara en
 *                nollställning, eller vara kvitterad med skäl.
 *   R3 FRÅGADE   Ett fält som WEBHOOKEN slår upp på får INTE kvitteras. Där är
 *                fel namnrymd inte latent utan omedelbart dödlig.
 *   R4 BÅDA HÅLL En kvittering för något som inte längre finns fälls.
 *
 * R3 är den som gör vakten framtidssäker: de fyra latenta fallen på
 * `PaymentReminder.emailMessageId` är kvitterade i dag därför att INGEN läser
 * fältet. Den dag någon kopplar webhooken till det blir kvitteringarna
 * automatiskt röda — nästa person kan alltså inte ärva defekten utan att se den.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Den läser KÄLLTEXT och mäter VAR ett värde skrivs — inte VAD det innehåller i
 * drift. Att `Tenant.lastInviteMessageId` faktiskt bär ett UUID kunde bara mätas
 * mot prod-data; vakten hade sagt "rätt källa" oavsett. Den ser inte heller att
 * `persistResendId` självt får rätt värde — det ägs av
 * `message-id-provenance.spec.ts`, som prövar HÄRKOMST med forminverterade
 * sentinelvärden.
 *
 * Kör:        node apps/api/scripts/check-mail-id-provenance.mjs
 * Självtest:  node apps/api/scripts/check-mail-id-provenance.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const WEBHOOK = join(SRC, 'webhooks', 'resend-webhook.service.ts')
const WORKER = join(SRC, 'mail', 'mail.worker.ts')
const ACK_FILE = join(HERE, 'mail-id-provenance.ack.json')
const MIN_SKÄL = 40

/** MÄTT mot f6a8990: 6 skrivningar, 3 frågade fält. Golven är trubbiga med flit. */
const MIN_SKRIVNINGAR = 4
const MIN_FRÅGADE = 2

const RÄTT_VÄG = [
  'Ett korrelations-id måste vara det leverantören gav TILLBAKA, inte det kön gav.',
  '',
  'SÅ HÄR GÖR DU RÄTT:',
  '',
  '  1. Skicka med en `correlation` när du köar mejlet:',
  '       await this.mail.sendX({ …, /* via optionens rentNoticeId e.d. */ })',
  '',
  '  2. Låt `persistResendId` i mail.worker.ts skriva fältet. Den körs EFTER',
  '     lyckat utskick och har Resends `email_id`. Lägg till ett `kind` i',
  '     MailCorrelation och en gren i switchen — inget mer.',
  '',
  'GÖR ALDRIG detta på anropsstället:',
  '       const id = await this.mail.sendX(…)     // ← Bulls jobId',
  '       await prisma.x.update({ data: { yMessageId: id } })',
  '',
  'Det var #651. Webhooken frågar på email_id och kan aldrig matcha ett jobId;',
  'utfallet är inte ett fel utan TYSTNAD — händelsen skrivs aldrig, och en grind',
  'som väntar på den blir permanent stängd.',
  '',
  'Går det verkligen inte nu: kvittera i mail-id-provenance.ack.json med ett skäl.',
  'MEN ett fält som webhooken SLÅR UPP PÅ får inte kvitteras (R3) — där är felet',
  'inte latent.',
].join('\n   ')

/** Alla .ts under src, utom specar. */
export function källfiler(dir = SRC, ut = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) källfiler(p, ut)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) ut.push(p)
  }
  return ut
}

/** Index efter den balanserade `{…}` som börjar på `från`, annars -1. */
function efterBlock(kod, från) {
  let djup = 0
  for (let j = från; j < kod.length; j++) {
    if (kod[j] === '{') djup++
    else if (kod[j] === '}') {
      djup--
      if (djup === 0) return j + 1
    }
  }
  return -1
}

/** Intervallen för `persistResendId`s kropp — den enda tillåtna skrivplatsen. */
export function persistResendIdIntervall(workerKod) {
  const m = /\bpersistResendId\s*\([^)]*\)\s*:[^{]*\{/.exec(workerKod)
  if (!m) return null
  const start = workerKod.indexOf('{', m.index)
  const slut = efterBlock(workerKod, start)
  return slut < 0 ? null : [start, slut]
}

// `\p{L}\p{N}_$` och lookbehind, inte `\w`/`\b` (#713): fältet namnges efter
// sitt SAMMANHANG — `avierMessageId`, `påminnelseEmailId` — och ett svenskt
// tecken i prefixet gjorde skrivningen osynlig. Se kanariefågeln i självtestet.
const FÄLTFORM = /(?<![\p{L}\p{N}_$])([\p{L}\p{N}_$]*(?:MessageId|EmailId))\s*:\s*([^,\n}]*)/gu

/**
 * Skrivningar av ett korrelations-id, härledda ur `data:`-literaler.
 *
 * `data:` och inte hela filen: webhookens `where: { reminderMessageId: emailId }`
 * är ett UPPSLAG, inte en skrivning, och en regel som blandar ihop dem hade
 * fällt själva korrelationen.
 */
export function härledSkrivningar(filer, workerRelativ) {
  const ut = []
  for (const { fil, text } of filer) {
    const kod = codeMask(text)
    const persist = fil === workerRelativ ? persistResendIdIntervall(kod) : null
    for (const d of kod.matchAll(/\bdata\s*:\s*\{/g)) {
      const start = kod.indexOf('{', d.index)
      const slut = efterBlock(kod, start)
      if (slut < 0) continue
      const block = kod.slice(start, slut)
      for (const m of block.matchAll(FÄLTFORM)) {
        const värde = m[2].trim()
        if (värde === '') continue
        const absolut = start + (m.index ?? 0)
        ut.push({
          fil,
          fält: m[1],
          värde,
          rad: kod.slice(0, absolut).split('\n').length,
          iPersistResendId: persist !== null && absolut >= persist[0] && absolut < persist[1],
          ärNollställning: värde === 'null',
        })
      }
    }
  }
  return ut
}

/** Fälten WEBHOOKEN slår upp på — härledda ur dess `where:`-klausuler. */
export function härledFrågade(webhookText) {
  const kod = codeMask(webhookText)
  const fält = new Set()
  for (const w of kod.matchAll(/\bwhere\s*:\s*\{/g)) {
    const start = kod.indexOf('{', w.index)
    const slut = efterBlock(kod, start)
    if (slut < 0) continue
    for (const m of kod.slice(start, slut).matchAll(FÄLTFORM)) fält.add(m[1])
  }
  return fält
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ skrivningar, frågade, ack, golvSkrivningar = 0, golvFrågade = 0 }) {
  const problem = []
  const poster = ack?.fields ?? {}

  // TOMHET OCH GOLV ÄR TVÅ OLIKA SAKER, och skillnaden är inte kosmetisk.
  //
  // En TOM mängd betyder att härledningen gått blind — det är strukturellt och
  // gäller alltid, även för en fixtur. Ett GOLV på fyra är en MÄTT förväntan om
  // just den här kodbasen, och gäller bara det skarpa svepet.
  //
  // Först var golvet inbakat i båda fallen, och då kortslöt det varje
  // fixturbaserat prov i självtestet: nio kontroller "föll" på omfånget innan
  // regeln de skulle mäta ens kördes. En kontroll som inte kan nå sin regel
  // mäter ingenting — samma form som vakten själv finns för att fånga.
  if (skrivningar.length === 0) {
    problem.push({
      rule: 'OMFÅNG: NOLL skrivningar härleddes',
      detail:
        'Härledningen har gått blind — en vakt utan mätobjekt mäter ingenting. ' +
        'Har `data:`-formen ändrats, eller fältnamnskonventionen?',
    })
    return problem
  }
  if (frågade.size === 0) {
    problem.push({
      rule: 'OMFÅNG: NOLL frågade fält härleddes',
      detail:
        'Utan de frågade fälten faller R3 bort, och då kan ett aktivt dödligt ' +
        'fall kvitteras som om det vore latent. Har webhookens `where:`-form ändrats?',
    })
    return problem
  }
  if (skrivningar.length < golvSkrivningar) {
    problem.push({
      rule: `OMFÅNG: bara ${skrivningar.length} skrivningar härleddes (golv ${golvSkrivningar})`,
      detail: 'Mängden har krympt oväntat mycket. Är härledningen fortfarande hel?',
    })
    return problem
  }
  if (frågade.size < golvFrågade) {
    problem.push({
      rule: `OMFÅNG: bara ${frågade.size} frågade fält härleddes (golv ${golvFrågade})`,
      detail: 'Har webhookens `where:`-form ändrats?',
    })
    return problem
  }

  // Antalet OKVITTERADE skrivningar per nyckel, för `count`-kontrollen nedan.
  const antalPerNyckel = new Map()
  for (const s of skrivningar) {
    if (s.iPersistResendId || s.ärNollställning) continue
    const k = `${s.fil}::${s.fält}`
    antalPerNyckel.set(k, (antalPerNyckel.get(k) ?? 0) + 1)
  }

  const kvitterade = new Set()
  for (const s of skrivningar) {
    if (s.iPersistResendId || s.ärNollställning) continue

    const nyckel = `${s.fil}::${s.fält}`
    const post = poster[nyckel]

    // R3: ett FRÅGAT fält får aldrig kvitteras.
    if (frågade.has(s.fält)) {
      problem.push({
        rule: `\`${nyckel}\` (rad ${s.rad}) skriver ett FRÅGAT korrelations-id utanför persistResendId`,
        detail:
          `Webhooken slår upp på \`${s.fält}\`. Ett värde ur fel namnrymd matchar ` +
          `aldrig, och utfallet är TYSTNAD — inte ett fel.\n   ` +
          (post ? 'KVITTERING HJÄLPER INTE HÄR (R3): felet är inte latent.\n   ' : '') +
          RÄTT_VÄG,
      })
      if (post) kvitterade.add(nyckel)
      continue
    }

    if (!post) {
      problem.push({
        rule: `\`${nyckel}\` (rad ${s.rad}) skriver ett korrelations-id utanför persistResendId`,
        detail: RÄTT_VÄG,
      })
      continue
    }
    if (kvitterade.has(nyckel)) continue
    kvitterade.add(nyckel)
    if ((post.reason ?? '').trim().length < MIN_SKÄL) {
      problem.push({
        rule: `\`${nyckel}\` har en kvittering med för tunt skäl (${(post.reason ?? '').trim().length} < ${MIN_SKÄL})`,
        detail: 'En kvitteringslista utan skäl är en lista över saker ingen minns varför de står där.',
      })
    }

    // ANTALET, inte bara nyckeln. Nyckeln är `fil::fält`, så FLERA skrivningar i
    // samma fil delar den — och en DELVIS fix hade annars varit osynlig: två av
    // tre lagade, kvitteringen kvar, vakten tyst. `count` gör varje enskild
    // skrivning räknad.
    const faktiskt = antalPerNyckel.get(nyckel) ?? 0
    if (post.count !== undefined && post.count !== faktiskt) {
      problem.push({
        rule: `\`${nyckel}\`: kvitteringen säger ${post.count} skrivningar, koden har ${faktiskt}`,
        detail:
          faktiskt < post.count
            ? 'Några är lagade — uppdatera `count`, eller ta bort posten när alla är det.'
            : 'FLER skrivningar har tillkommit än vad som kvitterats. En ny skrivning ' +
              'ärver inte en gammal kvittering; skriv skälet för den också.',
      })
    }
  }

  // R4: kvitteringar för något som inte längre finns.
  for (const nyckel of Object.keys(poster)) {
    if (!kvitterade.has(nyckel)) {
      problem.push({
        rule: `kvittering för \`${nyckel}\`, som inte längre skriver utanför persistResendId`,
        detail:
          'Skrivningen är lagad eller borttagen — ta bort posten. En kvitteringslista ' +
          'som bara kan växa slutar vara en skuld och blir en ursäkt.',
      })
    }
  }

  return problem
}

function allaFiler() {
  return källfiler().map((p) => ({
    fil: relative(SRC, p).split('\\').join('/'),
    text: readFileSync(p, 'utf8'),
  }))
}

const WORKER_REL = relative(SRC, WORKER).split('\\').join('/')

function kör() {
  const filer = allaFiler()
  const skrivningar = härledSkrivningar(filer, WORKER_REL)
  const frågade = härledFrågade(readFileSync(WEBHOOK, 'utf8'))
  const ack = JSON.parse(readFileSync(ACK_FILE, 'utf8'))
  const problem = evaluate({
    skrivningar,
    frågade,
    ack,
    golvSkrivningar: MIN_SKRIVNINGAR,
    golvFrågade: MIN_FRÅGADE,
  })

  if (problem.length > 0) {
    console.error('\n=== KORRELATIONS-ID UR FEL NAMNRYMD (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.rule}\n   ${p.detail}`)
    console.error(
      '\nRegeln: Bulls jobId och Resends email_id är skilda namnrymder. Ett fält som\n' +
        'webhooken frågar på måste skrivas från persistResendId. Se #651 och #653.\n',
    )
    process.exit(1)
  }

  const utanför = skrivningar.filter((s) => !s.iPersistResendId && !s.ärNollställning).length
  console.warn(
    `✅ ${skrivningar.length} skrivningar av korrelations-id — ` +
      `${skrivningar.length - utanför} från persistResendId eller nollställning, ` +
      `${utanför} kvitterade. ${frågade.size} fält frågas av webhooken.`,
  )
}

// ── FIXTURER ────────────────────────────────────────────────────────────────

const WORKER_FIXTUR = `
  private async persistResendId(correlation: MailCorrelation, resendId: string): Promise<void> {
    switch (correlation.kind) {
      case 'rent-notice':
        await this.prisma.rentNotice.update({
          where: { id: correlation.rentNoticeId },
          data: { noticeMessageId: resendId },
        })
        break
    }
  }
`

/** DEN AVGÖRANDE: ett FRÅGAT fält skrivet med köns returvärde, på ett anropsställe. */
const ANROPSSTÄLLE_FRÅGAT = `
  const id = await this.mail.sendRentNoticeReminder({ rentNoticeId: notice.id })
  await this.prisma.rentNotice.update({
    where: { id: notice.id },
    data: { reminderMessageId: id },
  })
`

/** Ett OFRÅGAT fält — latent, alltså kvitterbart. */
const ANROPSSTÄLLE_OFRÅGAT = `
  await this.prisma.paymentReminder.update({
    where: { id: markerId },
    data: { emailMessageId: outcome.jobId },
  })
`

const NOLLSTÄLLNING = `
  await this.prisma.tenant.update({
    where: { id: t.id },
    data: { lastInviteMessageId: null },
  })
`

const WEBHOOK_FIXTUR = `
  const notice = await this.prisma.rentNotice.findFirst({
    where: { OR: [{ reminderMessageId: emailId }, { noticeMessageId: emailId }] },
  })
  await this.prisma.tenant.updateMany({ where: { lastInviteMessageId: emailId } })
`

function självtest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`${ok ? '✅' : '❌'} ${namn}${extra ? '  → ' + extra : ''}`)
    if (!ok) fel++
  }

  // ── #713: FÄLTNAMNETS PREFIX ────────────────────────────────────────────
  //
  // Fältet namnges efter sitt SAMMANHANG: `reminderMessageId`, och i den här
  // kodbasen lika gärna `avierMessageId` eller `påminnelseEmailId`. Prefixet
  // lästes med `\w*`, som är ASCII.
  //
  // Uppmätt mot origin/main, ur en `data:`-literal:
  //
  //   { påminnelseEmailId: r.id }   \w* → fältet blir "minnelseEmailId"   KAPAD
  //   { avierMessageId: r.id }      \w* → "avierMessageId" (ren ASCII)
  //
  // DET ÄR KAPAD, INTE MISSAD, och det är värre. `\w*` matchar `minnelse`
  // efter `å`, så skrivningen HITTAS — med fel fältnamn — och ANTALET är
  // oförändrat. Vakten korsar sedan skrivningarna mot de fält webhooken frågar
  // på; ett kapat namn matchar inget frågat fält, så korrelationen bryts i
  // vakten i stället för i koden. Ett prov som räknar skrivningar ser ingenting.
  //
  // Provet jämför därför mot det VÄNTADE NAMNET, aldrig mot "hittade något".
  {
    const fil = [{ rel: 'x.ts', text: "await tx.rentNotice.update({ data: { påminnelseEmailId: r.id } })" }]
    const s1 = härledSkrivningar(fil, 'w.ts').map((x) => x.fält)
    t('#713 MISSAD: fältnamn med svenskt prefix ger en skrivning', s1.includes('påminnelseEmailId'), JSON.stringify(s1))
    const asciiFil = [{ rel: 'x.ts', text: "await tx.rentNotice.update({ data: { avierMessageId: r.id } })" }]
    t('#713 MOTPROV: ASCII-prefix fungerar som förut',
      härledSkrivningar(asciiFil, 'w.ts').map((x) => x.fält).includes('avierMessageId'))
    const frågade = [...härledFrågade("where: { påminnelseEmailId: emailId }")]
    t('#713 MISSAD: webhookens uppslag på ett svenskt fältnamn ses',
      frågade.includes('påminnelseEmailId'), JSON.stringify(frågade))
    // MOTPROV: suffixet krävs fortfarande — ett fält som inte slutar på
    // MessageId/EmailId är inget korrelations-id.
    const utan = [{ rel: 'x.ts', text: "await tx.rentNotice.update({ data: { ärendeNr: r.id } })" }]
    t('#713 MOTPROV: ett fält utan MessageId/EmailId-suffix räknas inte',
      härledSkrivningar(utan, 'w.ts').length === 0)
  }

  // (0) Den delade skannerns kanariefåglar — metavaktens krav.
  const skanner = kanariefåglar()
  t('delad skanner: kanariefåglarna gröna', skanner.length === 0, skanner.join(' | '))

  // (1) HÄRLEDNINGEN av de frågade fälten.
  const frågadeFix = härledFrågade(WEBHOOK_FIXTUR)
  t(
    'härleder frågade fält ur webhookens where-klausuler',
    frågadeFix.has('reminderMessageId') &&
      frågadeFix.has('noticeMessageId') &&
      frågadeFix.has('lastInviteMessageId'),
    [...frågadeFix].join(','),
  )
  const frågadeRiktiga = härledFrågade(readFileSync(WEBHOOK, 'utf8'))
  t(
    `härleder ${frågadeRiktiga.size} frågade fält ur den RIKTIGA webhooken (golv ${MIN_FRÅGADE})`,
    frågadeRiktiga.size >= MIN_FRÅGADE,
    [...frågadeRiktiga].join(','),
  )

  // (2) `where:` ÄR INTE `data:`. Utan den här skillnaden fäller vakten
  //     korrelationsuppslaget självt — alltså precis det som ska finnas.
  t(
    'ett `where:`-uppslag räknas INTE som en skrivning',
    härledSkrivningar([{ fil: 'x/webhook.ts', text: WEBHOOK_FIXTUR }], 'mail/mail.worker.ts')
      .length === 0,
  )

  // (3) REGELKANARIEFÅGELN — båda hållen.
  const iWorkern = härledSkrivningar(
    [{ fil: 'mail/mail.worker.ts', text: WORKER_FIXTUR }],
    'mail/mail.worker.ts',
  )
  t('en skrivning INUTI persistResendId känns igen', iWorkern.length === 1 && iWorkern[0].iPersistResendId)

  const anropsställe = härledSkrivningar(
    [{ fil: 'x/rent-reminder.service.ts', text: ANROPSSTÄLLE_FRÅGAT }],
    'mail/mail.worker.ts',
  )
  t('en skrivning på ett ANROPSSTÄLLE känns igen som utanför',
    anropsställe.length === 1 && !anropsställe[0].iPersistResendId)

  const bas = { skrivningar: [...iWorkern, ...anropsställe], frågade: frågadeFix }
  const utanKvitt = evaluate({ ...bas, ack: { fields: {} } })
  t('REGEL: ett FRÅGAT fält skrivet utanför persistResendId är RÖTT',
    utanKvitt.some((p) => p.rule.includes('FRÅGAT korrelations-id')),
    utanKvitt.map((p) => p.rule).join(' | '))

  // (4) R3: en kvittering RÄDDAR INTE ett frågat fält. Utan den här kunde
  //     #651-defekten återinföras med en kvittering som såg ordentlig ut.
  const medKvitt = evaluate({
    ...bas,
    ack: {
      fields: {
        'x/rent-reminder.service.ts::reminderMessageId': { reason: 'x'.repeat(MIN_SKÄL + 5) },
      },
    },
  })
  t('R3: en KVITTERING räddar inte ett frågat fält',
    medKvitt.some((p) => p.rule.includes('FRÅGAT korrelations-id')),
    medKvitt.map((p) => p.rule).join(' | '))

  // (5) …men ett OFRÅGAT fält går att kvittera, och blir tyst.
  const ofrågat = härledSkrivningar(
    [{ fil: 'x/payment-reminder.service.ts', text: ANROPSSTÄLLE_OFRÅGAT }],
    'mail/mail.worker.ts',
  )
  const ofrågatUtan = evaluate({ skrivningar: ofrågat, frågade: frågadeFix, ack: { fields: {} } })
  t('ett OFRÅGAT fält utan kvittering fälls',
    ofrågatUtan.some((p) => p.rule.includes('utanför persistResendId')))
  const ofrågatMed = evaluate({
    skrivningar: ofrågat,
    frågade: frågadeFix,
    ack: {
      fields: {
        'x/payment-reminder.service.ts::emailMessageId': { reason: 'x'.repeat(MIN_SKÄL + 5) },
      },
    },
  })
  t('ett OFRÅGAT fält MED kvittering är tyst', ofrågatMed.length === 0,
    ofrågatMed.map((p) => p.rule).join(' | '))

  // (6) En NOLLSTÄLLNING är ingen korrelationsskrivning.
  const noll = härledSkrivningar(
    [{ fil: 'x/tenant-invitations.service.ts', text: NOLLSTÄLLNING }],
    'mail/mail.worker.ts',
  )
  t('en nollställning (`: null`) räknas inte som korrelationsskrivning',
    noll.length === 1 && noll[0].ärNollställning)
  t('…och den är tyst i regeln',
    evaluate({ skrivningar: noll, frågade: frågadeFix, ack: { fields: {} } }).length === 0)

  // (6b) COUNT: en DELVIS fix får inte bli tyst.
  //
  // Nyckeln är `fil::fält`, så flera skrivningar i samma fil delar den. Utan
  // `count` hade två av tre lagade skrivningar lämnat en kvittering som täckte
  // den kvarvarande — och vakten hade varit grön om ett verkligt fall.
  const tvåSkrivningar = härledSkrivningar(
    [
      {
        fil: 'x/payment-reminder.service.ts',
        text: ANROPSSTÄLLE_OFRÅGAT + ANROPSSTÄLLE_OFRÅGAT,
      },
    ],
    'mail/mail.worker.ts',
  )
  t('två skrivningar i samma fil delar nyckel', tvåSkrivningar.length === 2)
  const felAntal = evaluate({
    skrivningar: tvåSkrivningar,
    frågade: frågadeFix,
    ack: {
      fields: {
        'x/payment-reminder.service.ts::emailMessageId': {
          count: 3,
          reason: 'x'.repeat(MIN_SKÄL + 5),
        },
      },
    },
  })
  t('COUNT: kvitteringen säger 3 men koden har 2 → RÖTT',
    felAntal.some((p) => p.rule.includes('kvitteringen säger 3')),
    felAntal.map((p) => p.rule).join(' | '))
  const rättAntal = evaluate({
    skrivningar: tvåSkrivningar,
    frågade: frågadeFix,
    ack: {
      fields: {
        'x/payment-reminder.service.ts::emailMessageId': {
          count: 2,
          reason: 'x'.repeat(MIN_SKÄL + 5),
        },
      },
    },
  })
  t('COUNT: rätt antal är tyst', rättAntal.length === 0, rättAntal.map((p) => p.rule).join(' | '))

  // (7) R4: kvitteringen fäller åt BÅDA hållen.
  const inaktuell = evaluate({
    skrivningar: iWorkern,
    frågade: frågadeFix,
    ack: { fields: { 'x/borta.ts::fooMessageId': { reason: 'x'.repeat(MIN_SKÄL + 5) } } },
  })
  t('R4: en kvittering som inte motsvarar någon skrivning fälls',
    inaktuell.some((p) => p.rule.includes('inte längre skriver')))

  // (8) OMFÅNGSKANARIEFÅGELN — tom mängd fäller.
  t('OMFÅNG: en tom skrivmängd fälls',
    evaluate({ skrivningar: [], frågade: frågadeFix, ack: { fields: {} } })
      .some((p) => p.rule.includes('NOLL skrivningar')))
  t('OMFÅNG: en tom FRÅGAD mängd fälls',
    evaluate({ skrivningar: iWorkern, frågade: new Set(), ack: { fields: {} } })
      .some((p) => p.rule.includes('NOLL frågade')))
  t('GOLVET är skilt från tomheten och fäller på en krympt mängd',
    evaluate({ skrivningar: iWorkern, frågade: frågadeFix, ack: { fields: {} }, golvSkrivningar: 99 })
      .some((p) => p.rule.includes('golv 99')))

  // (9) Kodbasen i paritet med kvitteringen.
  const filer = allaFiler()
  const riktiga = härledSkrivningar(filer, WORKER_REL)
  t(`OMFÅNG: ${riktiga.length} skrivningar härledda ur kodbasen (golv ${MIN_SKRIVNINGAR})`,
    riktiga.length >= MIN_SKRIVNINGAR)
  const parity = evaluate({
    skrivningar: riktiga,
    frågade: frågadeRiktiga,
    ack: JSON.parse(readFileSync(ACK_FILE, 'utf8')),
    golvSkrivningar: MIN_SKRIVNINGAR,
    golvFrågade: MIN_FRÅGADE,
  })
  t('kodbasen är i paritet med kvitteringen', parity.length === 0,
    parity.map((p) => p.rule).join(' | '))

  console.warn(fel === 0 ? '\n✅ Självtest OK.' : `\n❌ Självtest: ${fel} fallerade.`)
  process.exit(fel === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) självtest()
else kör()
