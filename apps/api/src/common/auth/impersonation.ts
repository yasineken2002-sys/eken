import type { JwtPayload } from '@eken/shared'

/**
 * Vem utförde handlingen EGENTLIGEN, när någon agerar via impersonation?
 *
 * ── PROBLEMET ──────────────────────────────────────────────────────────────
 *
 * `ImpersonationService.createToken` utfärdar en riktig JWT för att en
 * plattformsadministratör ska kunna felsöka i en kunds organisation:
 *
 *     sub:            targetUser.id      ← den IMPERSONERADE org-användaren
 *     role:           targetUser.role
 *     impersonatedBy: platformUserId     ← människan bakom, som EXTRA claim
 *
 * `sub` — som varje skrivväg använder som `actorId`/`createdById` — pekar alltså
 * på org-användaren, inte på den människa som faktiskt tryckte på knappen.
 * `impersonatedBy` finns i token men läses i dag på ETT ställe
 * (`auth.controller.ts`, som bara ekar den i `/auth/me`) och används av ingen
 * skrivväg.
 *
 * ── VAD DEN HÄR FUNKTIONEN GÖR, OCH INTE GÖR ───────────────────────────────
 *
 * Den ger anroparen den faktiska människan så att den kan sparas bredvid
 * handlingen. Den ÄNDRAR INTE `createdById` på verifikatet — huvudboken
 * fortsätter namnge org-användaren. En revisor som läser verifikatet ser
 * fortfarande fel person.
 *
 * Det är alltså ett spår, inte en lösning. Den systembreda frågan — ska
 * `createdById` peka på människan, eller ska ett separat fält bära den
 * impersonerande så att org-attributionen behålls? — är ett beslut som ligger i
 * ärende #379. Den här funktionen är avsedd att vara startpunkten för den
 * fixen: nästa väg som behöver uppgiften ska återanvända den, inte uppfinna en
 * egen variant, så att det finns ETT ställe att ändra när beslutet är fattat.
 *
 * Returnerar null när ingen impersonation pågår, vilket är normalfallet.
 */
export function impersonatorOf(payload: JwtPayload): string | null {
  const claim = (payload as JwtPayload & { impersonatedBy?: unknown }).impersonatedBy
  return typeof claim === 'string' && claim.length > 0 ? claim : null
}
