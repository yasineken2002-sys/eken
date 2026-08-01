import { ForbiddenException } from '@nestjs/common'
import { UserRole } from '@prisma/client'

/**
 * VEM FÅR AGERA MOT INKASSO? (R1)
 *
 * ── Varför den här filen finns ────────────────────────────────────────────────
 *
 * `RolesGuard` är HIERARKISK: `userLevel >= ROLE_HIERARCHY[krav]`. Bara den
 * LÄGSTA rollen i en `@Roles`-lista har effekt, resten är dekoration. Det gör
 * att `@Roles('OWNER','ADMIN','ACCOUNTANT')` läses som "dessa tre" men BETYDER
 * "ACCOUNTANT och uppåt" — och MANAGER (nivå 3) ligger över ACCOUNTANT (nivå 2)
 * och släpps därför in utan att nämnas.
 *
 * Inkasso-controllerna bar precis den listan. Följden: en förvaltare kunde
 * exportera en hyresgästs skuld till inkasso och markera den skickad — en
 * bindande handling mot en enskild person — utan att någon spärr sa ifrån.
 * Tjänsterna hade ingen egen rollkontroll att falla tillbaka på.
 *
 * Dekoratorn KAN inte uttrycka avsikten, eftersom hierarkin inte har något sätt
 * att säga "ACCOUNTANT men inte MANAGER". Därför ligger den bärande grinden här,
 * i tjänstelagret, med EXAKT mängdmatchning — samma semantik som bokföringens
 * grindar (CLOSE_ROLES, REVERSAL_ROLES) och AI-lagrets ACCOUNTING_ONLY_ACTIONS
 * redan använder. Dekoratorn blir en grovsållning som stänger ute VIEWER.
 *
 * ── Var gränsen går ──────────────────────────────────────────────────────────
 *
 * LÄSA = förvaltning får se. ATT AGERA BINDANDE = ekonomi.
 *
 * Att se vilka hyresgäster som är förfallna, och att pausa kravtrappan när en
 * betalningsplan avtalats, är förvaltningsarbete — förvaltaren är den som har
 * hyresgästkontakten, och båda är reversibla. Att lämna över skulden till
 * inkasso är något annat: det är bindande mot en enskild person, det syns i
 * hens kreditupplysning, och det går inte att ta tillbaka.
 *
 * Samma gräns drar AI-lagret redan (export/mark-sent i ACCOUNTING_ONLY_ACTIONS,
 * pause/resume i MANAGER_ALLOWED_ACTIONS). R1 rättar HTTP-vägen till att säga
 * samma sak, i stället för att låta de två lagren vara oense.
 */

/**
 * Roller som får utföra en BINDANDE inkassohandling: exportera underlag,
 * bulk-exportera, markera som skickad till inkasso.
 *
 * EXAKT matchning — MANAGER ingår medvetet INTE, och kan inte råka ingå via
 * hierarkin som i dekoratorn.
 */
export const COLLECTION_ACTION_ROLES: readonly UserRole[] = [
  UserRole.ACCOUNTANT,
  UserRole.ADMIN,
  UserRole.OWNER,
]

/** Handlingarna grinden skyddar — används bara för att formulera felet. */
export type CollectionAction =
  | 'exportera underlag till inkasso'
  | 'bulk-exportera underlag till inkasso'
  | 'markera som skickad till inkasso'

/**
 * FAIL-CLOSED: okänd eller saknad roll nekas.
 *
 * Anropas i tjänsten, inte i controllern — samma chokepunkts-princip som
 * periodstängningen (#194): en framtida intern anropare, ett AI-verktyg eller
 * en ny controller ska träffa samma spärr utan att någon behöver komma ihåg
 * att sätta en dekorator.
 */
export function assertMayActOnCollections(
  actorRole: UserRole | undefined,
  action: CollectionAction,
): void {
  if (!actorRole || !COLLECTION_ACTION_ROLES.includes(actorRole)) {
    throw new ForbiddenException(
      `Du saknar behörighet att ${action}. Att lämna över en skuld till inkasso är ` +
        'en bindande handling mot hyresgästen och hanteras av ekonomiansvarig ' +
        '(bokförare, administratör eller kontoägare).',
    )
  }
}
