/**
 * IDEMPOTENSNYCKELN FÅR ALDRIG BÄRA HELA EN RÅTOKEN.
 *
 * Nyckeln blir `jobId` i Bull (`mail.queue.ts:63`) och loggas fyra gånger per
 * utskick — vid enqueue (`mail.queue.ts:71`), vid varje försök, vid lyckat
 * utskick och vid fel (`mail.worker.ts:59,97,141`) — samt skickas vidare till
 * Resend (`mail.worker.ts:86`).
 *
 * Före den här fixen löd de två org-sidiga nycklarna `invite:${token}` och
 * `pwreset:${token}` med HELA den 64 tecken långa råtoken. Att hasha kolumnen i
 * databasen rör inte den vägen alls: klartexten användes som identifierare.
 *
 * ── Varför formen assertas och inte bara frånvaron av token ─────────────────
 *
 * Ett test som bara kontrollerar "nyckeln innehåller inte token" hade passerat
 * om någon "förenklade" bort id-prefixet och lämnade kvar de åtta hex-tecknen.
 * Det vore en ANNAN bugg: åtta hex = 32 bitar, och en kollision yttrar sig som
 * ett mejl som TYST aldrig skickas — Bull avvisar jobbet som en dubblett. Det
 * är sämre än läckan, eftersom den som inte fick sin återställningslänk inte
 * har något att felsöka.
 *
 * Det är ID:T som gör nyckeln unik. De åtta tecknen finns för läsbarhet i
 * loggen. Regexen nedan kräver därför BÅDA delarna och exakt åtta hex.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')

function källa(relativ: string): string {
  return readFileSync(join(SRC, relativ), 'utf8')
}

/**
 * `prefix:${nåtId}-${token.substring(0, 8)}` — id först, trunkerad token sist.
 *
 * Matchar mot KÄLLKODEN och inte mot ett runtime-värde: nyckeln byggs i en
 * template literal, och det är just den literalen som ska granskas. Ett
 * runtime-test hade behövt köra hela mejlflödet för att se en sträng som redan
 * står ordagrant i koden.
 */
function nyckelForm(prefix: string): RegExp {
  return new RegExp(
    `idempotencyKey:\\s*\`${prefix}:\\$\\{[\\w.]+\\}-\\$\\{\\w+\\.substring\\(0,\\s*8\\)\\}\``,
  )
}

/** Hela råtoken direkt i nyckeln — det som fixen tar bort. */
function heltokenForm(prefix: string): RegExp {
  return new RegExp(`idempotencyKey:\\s*\`${prefix}:\\$\\{\\w+\\}\``)
}

describe('idempotensnycklar bär id + trunkerad token, aldrig hela', () => {
  const fall = [
    { namn: 'inbjudan', fil: 'users/users.service.ts', prefix: 'invite' },
    { namn: 'lösenordsåterställning', fil: 'auth/auth.service.ts', prefix: 'pwreset' },
  ] as const

  it.each(fall)('$namn: nyckeln har formen prefix:<id>-<8 hex>', ({ fil, prefix }) => {
    expect(källa(fil)).toMatch(nyckelForm(prefix))
  })

  it.each(fall)('$namn: hela råtoken förekommer inte som nyckel', ({ fil, prefix }) => {
    // Uttrycklig negativ kontroll på återfallet. Faller både om någon skriver
    // tillbaka `${token}` och om formkontrollen ovan skulle luckras upp.
    expect(källa(fil)).not.toMatch(heltokenForm(prefix))
  })

  it('hyresgästportalen — som gjorde rätt hela tiden — har samma form', () => {
    // Referensimplementationen. Står den kvar är formen ovan en spegling och
    // inte en uppfinning; ändras den ska det märkas här.
    expect(källa('tenant-portal/tenant-auth.service.ts')).toMatch(
      /idempotencyKey:\s*`tenant-reset-\$\{[\w.]+\}-\$\{\w+\.substring\(0,\s*8\)\}`/,
    )
  })
})

describe('tokenkolumnerna lagras hashade, inte i klartext', () => {
  const fall = [
    {
      namn: 'UserInvitation',
      fil: 'users/users.service.ts',
      skapa: /userInvitation\.create\(\{\s*data:\s*\{[^}]*token:\s*sha256\(token\)/s,
    },
    {
      namn: 'PasswordResetToken',
      fil: 'auth/auth.service.ts',
      skapa: /passwordResetToken\.create\(\{\s*data:\s*\{[^}]*token:\s*sha256\(token\)/s,
    },
  ] as const

  it.each(fall)('$namn skrivs som sha256(token)', ({ fil, skapa }) => {
    expect(källa(fil)).toMatch(skapa)
  })

  it.each([
    {
      namn: 'UserInvitation',
      mönster: /userInvitation\.findUnique\(\{\s*where:\s*\{\s*token:\s*sha256\(token\)/s,
    },
    {
      namn: 'PasswordResetToken',
      mönster: /passwordResetToken\.findUnique\(\{\s*where:\s*\{\s*token:\s*sha256\(token\)/s,
    },
  ])('$namn slås upp på hashen — skrivning och läsning speglar varandra', ({ mönster }) => {
    // Den här kontrollen är den som fångar en HALV migrering: hashad skrivning
    // med ohashad uppslagning ger ett flöde som failar tyst för varje användare.
    expect(källa('auth/auth.service.ts')).toMatch(mönster)
  })
})
