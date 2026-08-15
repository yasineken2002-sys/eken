/**
 * Rotation av SIGNING_PII_KEY och SIGNING_PII_PEPPER (#459).
 *
 * Kravet på rotation var dokumenterat sedan #255 men mekanismen fanns inte: ett
 * rutinmässigt "rotera secrets"-svep hade tyst förstört personnummer-
 * uppslagningen. Det här verktyget är den saknade vägen.
 *
 * ── TVÅ OBEROENDE LÄGEN, ETT I TAGET ────────────────────────────────────────
 *
 *   --mode=pepper   Räknar om blind-indexen (`personalNumberHash`).
 *                   Kräver SIGNING_PII_KEY (OFÖRÄNDRAD — klartexten måste kunna
 *                   läsas), SIGNING_PII_PEPPER_OLD och SIGNING_PII_PEPPER_NEW.
 *                   Chiffertexten rörs inte.
 *
 *   --mode=key      Krypterar om chiffertexten (`personalNumberEnc` m.fl.).
 *                   Kräver SIGNING_PII_KEY_OLD och SIGNING_PII_KEY_NEW.
 *                   Peppern rörs inte, och därmed inte hasharna.
 *
 * Avsiktligt INTE ett läge som gör båda samtidigt. En rotation i taget är
 * lättare att avbryta och lättare att förstå i efterhand; körs de i följd blir
 * varje halva sitt eget verifierbara steg.
 *
 * `--dry-run` klassificerar och rapporterar utan att skriva en enda rad.
 *
 * ── VAD SOM RÖRS ────────────────────────────────────────────────────────────
 *
 * Peppern (3 kolumner — allt som är HMAC:at med den):
 *   Tenant.personalNumberHash, Customer.personalNumberHash,
 *   SignatureEvidence.personalNumberHash
 *
 * Nyckeln (5 kolumner — allt som är AES-krypterat med den):
 *   Tenant.personalNumberEnc, Customer.personalNumberEnc,
 *   SignatureEvidence.personalNumberEnc, SignatureEvidence.signaturePayload,
 *   SignatureEvidence.certificate
 *
 * De två sista är lätta att missa: både #459 och docs/accounting-fix-status.md
 * räknar bara upp personnummer-kolumnerna. `signaturePayload` (rå signatur) och
 * `certificate` krypteras med SAMMA nyckel i signing.service.ts, och en
 * nyckelrotation som hoppar över dem gör dem permanent oläsbara.
 *
 * PSD2:s bank-tokens står UTANFÖR: de använder PSD2_TOKEN_KEY, en egen nyckel
 * (bank-consent-crypto.service.ts). Rör dem inte härifrån.
 *
 * ── IDEMPOTENS UTAN MARKÖRKOLUMN ────────────────────────────────────────────
 *
 * Rotationsstatus är läsbar ur datan själv, så ingen `rotatedAt`, ingen cursor-
 * tabell och inget som kan komma ur synk med verkligheten:
 *
 *   pepper:  hash == HMAC(NY, klartext)     → REDAN_ROTERAD
 *            hash == HMAC(GAMMAL, klartext) → ATT_ROTERA
 *            varken eller                   → AVBRYT
 *
 *   key:     dekryptering med NY nyckel lyckas     → REDAN_ROTERAD
 *            dekryptering med GAMMAL nyckel lyckas → ATT_ROTERA
 *            ingendera                             → AVBRYT
 *
 * Nyckelläget kan skilja lägena åt eftersom AES-256-GCM med fel nyckel KASTAR på
 * authTag — den returnerar inte skräp. En avbruten körning återupptas genom att
 * köras om; redan roterade rader hoppas över.
 *
 * Det tredje utfallet är poängen: klassificeraren har ingen fallback till "anta
 * orörd". En rad som varken matchar gammalt eller nytt är korrupt, eller kommer
 * från en tredje hemlighet — då ska HELA körningen stanna, inte bara raden.
 *
 * ── BEVARANDEBEVIS PER RAD ──────────────────────────────────────────────────
 *
 * Ingen rad skrivs förrän klartexten bevisligen överlever transformationen:
 * dekryptera det gamla, bygg det nya, dekryptera det nya, jämför. Först då
 * UPDATE. Krockar de avbryts hela körningen.
 *
 * ── OM ATT SKRIVA I SignatureEvidence ───────────────────────────────────────
 *
 * SignatureEvidence är append-only och har med flit ingen `updatedAt`: ett
 * signeringsbevis får inte kunna ändras i efterhand.
 *
 * Rotationen skriver ändå i tabellen, och skälet är att append-only-regeln
 * skyddar bevisets INNEHÅLL — vad som signerades, av vem, när, med vilken
 * identitet — inte det kryptografiska nyckelmaterial som för tillfället skyddar
 * raden. Att byta det materialet är hela poängen med operationen, inte en
 * bieffekt.
 *
 * Ingen liknelse här med flit. "Som att flytta ett arkiv till en ny lokal" låg
 * nära till hands men är vilseledande: raden flyttas inte, den skrivs över —
 * byte för byte, på samma plats. Det som gör operationen försvarbar är inte att
 * den låter bli att röra beviset, utan att bytet är verifierat innan det sker.
 *
 * Villkoret som bär argumentet är därför bevarandebeviset ovan: verktyget kan
 * inte skriva en rad vars klartext det inte först har läst tillbaka identiskt.
 * Det gäller radvis — `AVBRYT` returneras och körningen kastar innan `update()`
 * någonsin nås för den raden. Det förutsätter att verktyget kör utan
 * konkurrerande skrivningar mot samma rader; ingen databas-spärr garanterar det.
 *
 * Varje körning lämnar dessutom ett spår i `PiiSecretRotation` (läge, utfall,
 * antal rader, tidsstämplar — aldrig ett värde), så att arkivet självt visar att
 * transformationen skett. Spåret skrivs ÄVEN vid avbrott, med de antal som
 * faktiskt hann skrivas: varje `update()` är en egen commit, så ett avbrott mitt
 * i lämnar databasen delvis roterad, och ett spår som då rapporterade noll hade
 * påstått motsatsen till vad som hänt.
 *
 * KÄND BEGRÄNSNING: spåret är aggregerat, inte radvis. Det visar att en rotation
 * ägde rum i ett tidsfönster och hur många rader den rörde — inte att en VISS
 * bevisrad bara bytt lagringsform. Radnivå-spårbarhet skulle kräva att id:n på
 * roterade rader sparas, vilket är ett medvetet öppet vägval (spårtabellen är
 * global och bär i dag inga person-kopplade id:n).
 *
 * MÄNNISKOVERIFIERING: resonemanget ovan är en bedömning, inte ett lagrum, och
 * det står med flit utan SFS-hänvisning. Ska det bindas till lagtext måste den
 * hänvisningen verifieras av en människa (CLAUDE.md).
 */

import { Prisma, PrismaClient } from '@prisma/client'
import * as crypto from 'crypto'

/** Hur många rader som hämtas per varv. Prod har ensiffrigt antal — 500 är gott om marginal. */
const BATCH = 500

export type RotationMode = 'pepper' | 'key'

/** Vad en enskild rad ska göras med. Tre utfall, ingen fallback. */
type RowVerdict = 'ATT_ROTERA' | 'REDAN_ROTERAD' | 'HOPPA_OVER' | 'AVBRYT'

export interface RotationCounts {
  scanned: number
  rotated: number
  alreadyRotated: number
  skipped: number
}

export interface RotationResult {
  mode: RotationMode
  dryRun: boolean
  perTable: Record<string, RotationCounts>
  total: RotationCounts
}

/**
 * Kastas när en rad inte går att klassificera. Avbryter HELA körningen.
 *
 * Två formuleringar med flit: `message` går till operatörens terminal och pekar
 * ut EXAKT vilken rad som stoppade körningen — utan den blir felet obrukbart.
 * `category` är den avpersonifierade varianten som hamnar i `PiiSecretRotation`,
 * eftersom spårtabellen är global och inte ska bära ett id som knyter en
 * misslyckad rotation till en enskild person.
 */
export class RotationAbort extends Error {
  readonly category: string

  constructor(message: string, category = 'OKAND') {
    super(message)
    this.name = 'RotationAbort'
    this.category = category
  }
}

function log(msg: string): void {
  // console.log är bannlyst i projektet.
  console.warn(`[rotate-pii] ${msg}`)
}

// ─── Primitiver ──────────────────────────────────────────────────────────────
// Duplicerade från SigningCryptoService med flit, av samma skäl som den gamla
// backfillen: skriptet körs som en fristående nod-process, och ett DI-bootstrap
// bara för tre funktioner hade dragit in hela AppModule (köer, cron, R2).
// `rotate-pii-secrets.spec.ts` låser att formaten är identiska med tjänstens.

export function aesKeyFromHex(hex: string, name: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new RotationAbort(`${name} måste vara 64 hex-tecken (32 byte)`)
  }
  return Buffer.from(hex, 'hex')
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
}

/** Returnerar klartexten, eller `null` om nyckeln inte hör till chiffertexten. */
export function tryDecrypt(key: Buffer, enc: string): string | null {
  try {
    const raw = Buffer.from(enc, 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    // Fel nyckel → authTag stämmer inte → kast. Det ÄR diskriminatorn, inte ett fel.
    return null
  }
}

export function blindIndex(pepper: string, personalNumber: string): string {
  return crypto.createHmac('sha256', pepper).update(personalNumber.replace(/\D/g, '')).digest('hex')
}

// ─── Tabeller ────────────────────────────────────────────────────────────────

interface PiiRow {
  id: string
  personalNumberEnc: string | null
  personalNumberHash: string | null
  signaturePayload?: string | null
  certificate?: string | null
}

interface TargetDelegate {
  findMany(args: {
    select: Record<string, boolean>
    orderBy: { id: 'asc' }
    take: number
    cursor?: { id: string }
    skip?: number
  }): Promise<PiiRow[]>
  update(args: { where: { id: string }; data: Record<string, string> }): Promise<unknown>
}

interface Target {
  name: string
  delegate: TargetDelegate
  /** Extra AES-kolumner utöver personalNumberEnc (bara SignatureEvidence har några). */
  extraEncryptedColumns: readonly string[]
}

export function buildTargets(prisma: PrismaClient): Target[] {
  return [
    {
      name: 'Tenant',
      delegate: prisma.tenant as unknown as TargetDelegate,
      extraEncryptedColumns: [],
    },
    {
      name: 'Customer',
      delegate: prisma.customer as unknown as TargetDelegate,
      extraEncryptedColumns: [],
    },
    {
      name: 'SignatureEvidence',
      delegate: prisma.signatureEvidence as unknown as TargetDelegate,
      // Krypterade med SAMMA nyckel som personnumret. Missas de blir de
      // permanent oläsbara vid en nyckelrotation.
      extraEncryptedColumns: ['signaturePayload', 'certificate'],
    },
  ]
}

// ─── Klassificering ──────────────────────────────────────────────────────────

export interface PepperContext {
  key: Buffer
  oldPepper: string
  newPepper: string
}

export interface KeyContext {
  oldKey: Buffer
  newKey: Buffer
}

/**
 * Peppar-läget: hashen räknas om ur klartexten. Chiffertexten rörs inte, så
 * bevarandebeviset är att klartexten över huvud taget går att läsa.
 */
export function classifyForPepper(
  row: PiiRow,
  ctx: PepperContext,
  where: string,
): { verdict: RowVerdict; newHash?: string; reason?: string; category?: string } {
  const { personalNumberEnc: enc, personalNumberHash: hash } = row
  if (enc === null && hash === null) return { verdict: 'HOPPA_OVER' }
  if (enc === null || hash === null) {
    return {
      verdict: 'AVBRYT',
      reason: `${where}: chiffertext och blind-index är inte i par (enc=${enc === null ? 'null' : 'satt'}, hash=${hash === null ? 'null' : 'satt'}) — går inte att rotera, och skulle tyst bli fel om den antogs orörd`,
      category: 'PAR_SAKNAS',
    }
  }
  const plain = tryDecrypt(ctx.key, enc)
  if (plain === null) {
    return {
      verdict: 'AVBRYT',
      reason: `${where}: chiffertexten går inte att dekryptera med SIGNING_PII_KEY — peppar-rotation kräver att NYCKELN är oförändrad`,
      category: 'FEL_NYCKEL_VID_PEPPARROTATION',
    }
  }
  if (hash === blindIndex(ctx.newPepper, plain)) return { verdict: 'REDAN_ROTERAD' }
  if (hash === blindIndex(ctx.oldPepper, plain)) {
    return { verdict: 'ATT_ROTERA', newHash: blindIndex(ctx.newPepper, plain) }
  }
  return {
    verdict: 'AVBRYT',
    reason: `${where}: blind-indexet matchar varken gammal eller ny pepper — raden kommer från en tredje pepper eller är korrupt`,
    category: 'TREDJE_PEPPER',
  }
}

/**
 * Nyckel-läget: varje AES-kolumn krypteras om. Bevarandebeviset körs per kolumn
 * — dekryptera gammalt, kryptera nytt, dekryptera nytt, jämför — INNAN något
 * skrivs.
 */
export function classifyForKey(
  row: PiiRow,
  ctx: KeyContext,
  columns: readonly string[],
  where: string,
): { verdict: RowVerdict; data?: Record<string, string>; reason?: string; category?: string } {
  const present = columns.filter((c) => {
    const v = (row as unknown as Record<string, string | null | undefined>)[c]
    return typeof v === 'string' && v.length > 0
  })
  if (present.length === 0) return { verdict: 'HOPPA_OVER' }

  const data: Record<string, string> = {}
  const verdicts = new Set<string>()

  for (const col of present) {
    const enc = (row as unknown as Record<string, string>)[col] as string
    if (tryDecrypt(ctx.newKey, enc) !== null) {
      verdicts.add('REDAN_ROTERAD')
      continue
    }
    const plain = tryDecrypt(ctx.oldKey, enc)
    if (plain === null) {
      return {
        verdict: 'AVBRYT',
        reason: `${where}.${col}: går inte att dekryptera med vare sig gammal eller ny nyckel — kolumnen kommer från en tredje nyckel eller är korrupt`,
        category: 'TREDJE_NYCKEL',
      }
    }
    // BEVARANDEBEVIS: läs tillbaka det nya innan något skrivs.
    const reEnc = encrypt(ctx.newKey, plain)
    if (tryDecrypt(ctx.newKey, reEnc) !== plain) {
      return {
        verdict: 'AVBRYT',
        reason: `${where}.${col}: klartexten överlevde inte omkrypteringen — ingen rad har skrivits`,
        category: 'BEVARANDEBEVIS_FALLERADE',
      }
    }
    data[col] = reEnc
    verdicts.add('ATT_ROTERA')
  }

  // En rad skrivs i EN update, så dess kolumner kan inte ha divergerat av en
  // avbruten körning. Har de ändå det är något annat fel — stanna.
  if (verdicts.size > 1) {
    return {
      verdict: 'AVBRYT',
      reason: `${where}: kolumnerna är krypterade med OLIKA nycklar (${[...verdicts].join(' + ')}) — inkonsekvent tillstånd som en rotation inte får skriva över`,
      category: 'BLANDADE_NYCKLAR',
    }
  }
  if (verdicts.has('REDAN_ROTERAD')) return { verdict: 'REDAN_ROTERAD' }
  return { verdict: 'ATT_ROTERA', data }
}

// ─── Förutsättningar ─────────────────────────────────────────────────────────

/**
 * Peppar-rotationen strandar pågående signeringsbegäranden.
 *
 * `SigningRequest.requiredRoles` är en Json-kolumn som PERSISTERAR
 * `expectedPersonalNumberHash` (signing.service.ts) — en kopia av hyresgästens
 * blind-index, fryst när begäran skapades. Den bär ingen chiffertext, så den kan
 * inte räknas om som de andra; och att härleda om den ur avtalet vore fel, för
 * har hyresgästens personnummer ändrats sedan dess skulle rotationen tyst FLYTTA
 * identitetsbindningen på ett fryst intent.
 *
 * Därför en förutsättning i stället för en omskrivning: rotera inte medan någon
 * begäran är i luften. Vänta tills de är klara eller avbrutna.
 */
export async function assertNoInFlightSigning(prisma: PrismaClient): Promise<void> {
  const inFlight = await prisma.signingRequest.count({
    where: { status: { in: ['PENDING', 'SIGNING_IN_PROGRESS'] } },
  })
  if (inFlight > 0) {
    throw new RotationAbort(
      `${inFlight} signeringsbegäran(den) är i luften (PENDING/SIGNING_IN_PROGRESS). ` +
        'Deras requiredRoles bär ett fryst blind-index som en peppar-rotation inte kan ' +
        'räkna om utan att flytta identitetsbindningen. Vänta tills de är klara eller ' +
        'avbrutna och kör om.',
    )
  }
}

// ─── Körning ─────────────────────────────────────────────────────────────────

export interface RotateOptions {
  mode: RotationMode
  dryRun: boolean
  env: NodeJS.ProcessEnv
  /**
   * Valfri referens som uppdateras LÖPANDE under körningen.
   *
   * Returvärdet finns bara när allt gick bra, men varje `update()` är en egen
   * commit — kastar rad 4 999 av 5 000 står de föregående redan skrivna i
   * databasen. Utan den här referensen hade avbrottsspåret rapporterat noll
   * roterade rader medan verkligheten var delvis roterad, och spårtabellen hade
   * påstått motsatsen till vad som hänt.
   */
  progress?: { perTable: Record<string, RotationCounts>; total: RotationCounts }
}

function readPepperContext(env: NodeJS.ProcessEnv): PepperContext {
  const keyHex = env['SIGNING_PII_KEY']
  const oldPepper = env['SIGNING_PII_PEPPER_OLD']
  const newPepper = env['SIGNING_PII_PEPPER_NEW']
  if (!keyHex)
    throw new RotationAbort('SIGNING_PII_KEY saknas (måste vara OFÖRÄNDRAD vid peppar-rotation)')
  if (!oldPepper || oldPepper.length < 16)
    throw new RotationAbort('SIGNING_PII_PEPPER_OLD saknas/för kort (≥16 tecken)')
  if (!newPepper || newPepper.length < 16)
    throw new RotationAbort('SIGNING_PII_PEPPER_NEW saknas/för kort (≥16 tecken)')
  if (oldPepper === newPepper)
    throw new RotationAbort('SIGNING_PII_PEPPER_OLD och _NEW är identiska — ingenting att rotera')
  return { key: aesKeyFromHex(keyHex, 'SIGNING_PII_KEY'), oldPepper, newPepper }
}

function readKeyContext(env: NodeJS.ProcessEnv): KeyContext {
  const oldHex = env['SIGNING_PII_KEY_OLD']
  const newHex = env['SIGNING_PII_KEY_NEW']
  if (!oldHex) throw new RotationAbort('SIGNING_PII_KEY_OLD saknas')
  if (!newHex) throw new RotationAbort('SIGNING_PII_KEY_NEW saknas')
  if (oldHex.toLowerCase() === newHex.toLowerCase()) {
    throw new RotationAbort('SIGNING_PII_KEY_OLD och _NEW är identiska — ingenting att rotera')
  }
  return {
    oldKey: aesKeyFromHex(oldHex, 'SIGNING_PII_KEY_OLD'),
    newKey: aesKeyFromHex(newHex, 'SIGNING_PII_KEY_NEW'),
  }
}

export async function rotatePiiSecrets(
  prisma: PrismaClient,
  opts: RotateOptions,
): Promise<RotationResult> {
  const { mode, dryRun, env } = opts
  const pepperCtx = mode === 'pepper' ? readPepperContext(env) : null
  const keyCtx = mode === 'key' ? readKeyContext(env) : null

  if (mode === 'pepper') await assertNoInFlightSigning(prisma)

  const perTable: Record<string, RotationCounts> = opts.progress?.perTable ?? {}
  const total: RotationCounts = opts.progress?.total ?? {
    scanned: 0,
    rotated: 0,
    alreadyRotated: 0,
    skipped: 0,
  }

  for (const target of buildTargets(prisma)) {
    // Skrivs in i perTable DIREKT, så referensen växer medan vi går. Summeras
    // den först efter tabellen är den tom när en rad mitt i kastar.
    const counts: RotationCounts = { scanned: 0, rotated: 0, alreadyRotated: 0, skipped: 0 }
    perTable[target.name] = counts
    const columns = ['personalNumberEnc', ...target.extraEncryptedColumns]
    const select: Record<string, boolean> = {
      id: true,
      personalNumberEnc: true,
      personalNumberHash: true,
    }
    for (const c of target.extraEncryptedColumns) select[c] = true

    let cursor: string | null = null
    for (;;) {
      const rows: PiiRow[] = await target.delegate.findMany({
        select,
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      if (rows.length === 0) break
      cursor = rows[rows.length - 1]!.id

      for (const row of rows) {
        counts.scanned++
        total.scanned++
        const where = `${target.name} ${row.id}`
        const res =
          mode === 'pepper'
            ? classifyForPepper(row, pepperCtx!, where)
            : classifyForKey(row, keyCtx!, columns, where)

        if (res.verdict === 'AVBRYT') throw new RotationAbort(res.reason ?? where, res.category)
        if (res.verdict === 'HOPPA_OVER') {
          counts.skipped++
          total.skipped++
          continue
        }
        if (res.verdict === 'REDAN_ROTERAD') {
          counts.alreadyRotated++
          total.alreadyRotated++
          continue
        }

        if (!dryRun) {
          const data =
            mode === 'pepper'
              ? { personalNumberHash: (res as { newHash: string }).newHash }
              : (res as { data: Record<string, string> }).data
          await target.delegate.update({ where: { id: row.id }, data })
        }
        counts.rotated++
        total.rotated++
      }
    }

    log(
      `${target.name}: ${counts.scanned} lästa, ${counts.rotated} ${dryRun ? 'skulle roteras' : 'roterade'}, ` +
        `${counts.alreadyRotated} redan roterade, ${counts.skipped} utan data`,
    )
  }

  return { mode, dryRun, perTable, total }
}

/**
 * Slutraden: vad betyder räknarna för den som just nu står och ska fatta ett
 * beslut?
 *
 * `rotated` betyder OLIKA saker i de två lägena, och det är hela grunden till
 * att den här funktionen måste veta vilket läge den beskriver:
 *
 * | läge      | `rotated` betyder            | rätt besked        |
 * |-----------|------------------------------|--------------------|
 * | torrkörn. | rader som SKULLE ha roterats | `OFULLSTÄNDIG`     |
 * | skarpt    | rader som NYSS roterades     | `KLAR`             |
 *
 * Flaggan läses ur `result.dryRun` och tas medvetet INTE som parameter.
 * `RotationResult` bär den redan, och både flaggan och räknarna produceras av
 * samma `rotatePiiSecrets`-anrop — de kan alltså inte hamna i otakt. En
 * parameter (även en obligatorisk) hade gjort utelämnande omöjligt men inte
 * FEL: `true` och `false` typkontrollerar lika bra, och fakta hade fått en
 * andra källa som kan glida isär från den första.
 *
 * NOLL KONTROLLERBARA RADER GER "KAN EJ VERIFIERAS", ALDRIG "OK" — en tom
 * tabell får inte se ut som en lyckad kontroll. Det gäller båda lägena och
 * prövas före allt annat.
 */
export function describeVerification(result: RotationResult): string {
  const kontrollerbara = result.total.scanned - result.total.skipped
  if (kontrollerbara === 0) {
    return 'KAN EJ VERIFIERAS — noll rader bär personnummer, så ingenting kunde prövas'
  }

  if (!result.dryRun) {
    // En skarp körning som nått hit har skrivit klart. Varje kontrollerbar rad
    // bär nu den nya hemligheten — de som just skrevs om OCH de som redan var
    // roterade sedan en tidigare körning.
    //
    // Nästa steg står i meddelandet med flit. Raden läses i exakt det ögonblick
    // operatören avgör om den gamla hemligheten får kastas, och efter det finns
    // ingen väg tillbaka. Ett besked utan nästa steg inbjuder till att hoppa
    // över verifieringen.
    const bar = result.total.rotated + result.total.alreadyRotated
    return (
      `KLAR — ${bar} av ${kontrollerbara} rader bär den nya hemligheten.\n` +
      'Verifiera boot-kontrollens utfall innan _OLD tas bort.'
    )
  }

  if (result.total.rotated === 0) {
    return `OK — ${result.total.alreadyRotated} av ${kontrollerbara} rader bär den nya hemligheten`
  }
  return `OFULLSTÄNDIG — ${result.total.rotated} av ${kontrollerbara} rader bär fortfarande den gamla hemligheten`
}

/**
 * Avbrottsraden — samma sammanblandning som slutraden, åt andra hållet.
 *
 * En torrkörning som avbryter har inte skrivit någonting. Att då rapportera
 * "N skrivna rader — databasen är delvis roterad" skickar en operatör att
 * reparera en databas som är orörd.
 *
 * Fälten är namngivna i ett objekt, inte positionella: här finns inget
 * `RotationResult` att läsa flaggan ur (körningen kastade innan den byggdes),
 * så en parameter är oundviklig — men två booleska/numeriska argument i rad går
 * att kasta om utan att kompilatorn märker det.
 */
export function describeAbort(arg: {
  dryRun: boolean
  rowsRotated: number
  category: string
}): string {
  const { dryRun, rowsRotated, category } = arg
  return dryRun
    ? `AVBRUTEN efter ${rowsRotated} rader som SKULLE ha roterats — spår skrivet (${category}). ` +
        'Torrkörning: databasen är ORÖRD. Åtgärda orsaken och kör om.'
    : `AVBRUTEN efter ${rowsRotated} skrivna rader — spår skrivet (${category}). ` +
        'Databasen är delvis roterad; kör om efter att orsaken är åtgärdad.'
}

/* istanbul ignore next -- entry point, logiken testas via rotatePiiSecrets */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const modeArg = args.find((a) => a.startsWith('--mode='))?.slice('--mode='.length)
  const dryRun = args.includes('--dry-run')

  if (modeArg !== 'pepper' && modeArg !== 'key') {
    console.error(
      'Användning: rotate-pii-secrets --mode=pepper|key [--dry-run]\n\n' +
        '  --mode=pepper  SIGNING_PII_KEY (oförändrad) + SIGNING_PII_PEPPER_OLD + _NEW\n' +
        '  --mode=key     SIGNING_PII_KEY_OLD + SIGNING_PII_KEY_NEW\n\n' +
        'Kör ALLTID --dry-run först.',
    )
    process.exit(2)
  }

  const prisma = new PrismaClient()
  const startedAt = new Date()

  // Levande räknare. Returvärdet finns bara vid lyckad körning, men varje
  // update() är en egen commit — kastar en rad mitt i står de föregående redan
  // skrivna. Spåret måste kunna rapportera DET läget, inte noll.
  const progress = {
    perTable: {} as Record<string, RotationCounts>,
    total: { scanned: 0, rotated: 0, alreadyRotated: 0, skipped: 0 } as RotationCounts,
  }

  const skrivSpar = (status: string, abortReason?: string): Promise<unknown> =>
    prisma.piiSecretRotation
      .create({
        data: {
          mode: modeArg.toUpperCase(),
          status,
          startedAt,
          finishedAt: new Date(),
          rowsScanned: progress.total.scanned,
          rowsRotated: progress.total.rotated,
          rowsAlreadyRotated: progress.total.alreadyRotated,
          rowsSkipped: progress.total.skipped,
          perTable: progress.perTable as unknown as Prisma.InputJsonValue,
          ...(abortReason ? { abortReason } : {}),
        },
      })
      // Spårskrivningen får aldrig maskera det verkliga felet.
      .catch(() => undefined)

  try {
    log(`läge=${modeArg}${dryRun ? ' (DRY RUN — skriver ingenting)' : ''}`)
    const result = await rotatePiiSecrets(prisma, {
      mode: modeArg,
      dryRun,
      env: process.env,
      progress,
    })
    log(describeVerification(result))
    await skrivSpar(dryRun ? 'DRY_RUN' : 'COMPLETED')
    log('spår skrivet i PiiSecretRotation')
  } catch (err) {
    // Kategorin, inte meddelandet: meddelandet pekar ut en enskild rad och hör
    // hemma i operatörens terminal, inte i en global spårtabell.
    const kategori = err instanceof RotationAbort ? err.category : 'OVANTAT_FEL'
    await skrivSpar('ABORTED', kategori)
    log(describeAbort({ dryRun, rowsRotated: progress.total.rotated, category: kategori }))
    throw err
  } finally {
    await prisma.$disconnect()
  }
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[rotate-pii] AVBRUTEN:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
