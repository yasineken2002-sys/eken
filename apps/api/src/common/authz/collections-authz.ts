import { ForbiddenException } from '@nestjs/common'
import { UserRole } from '@prisma/client'

/**
 * VEM FÅR AGERA MOT INKASSO? (R1)
 *
 * ── Varför den här filen finns ────────────────────────────────────────────────
 *
 * BAKGRUNDEN (rollgrindens semantik och varför den ändrades) står samlad i
 * `common/guards/roles.guard.ts`. Kort: när R1 skrevs var guarden hierarkisk, så
 * inkasso-controllernas lista släppte in MANAGER utan att nämna den — och en
 * förvaltare kunde därför lämna över en hyresgästs skuld till inkasso utan att
 * någon spärr sa ifrån. Tjänsterna hade ingen egen rollkontroll att falla
 * tillbaka på.
 *
 * R2 steg 2 tog bort hierarkin: guarden matchar numera exakt, så en lista KAN nu
 * uttrycka "ACCOUNTANT men inte MANAGER". Grinden här är därför inte längre en
 * nödlösning för något dekoratorn inte klarade — men den står kvar, av två skäl
 * som båda gäller oavsett guardens semantik:
 *
 *   1. INTE ALLA VÄGAR GÅR VIA HTTP. AI-verktyget `export_for_collection`
 *      anropar render-vägen synkront, förbi kön och förbi varje dekorator. En
 *      spärr som bara finns på controllern skyddar inte den vägen.
 *   2. DET ÄR EN BINDANDE HANDLING. Två oberoende lager är rätt nivå för något
 *      som inte går att ta tillbaka, och tjänstelagret är den punkt varje
 *      framtida anropare måste passera.
 *
 * Klassdekoratorn på inkasso-controllerna är fortsatt en grovsållning: den
 * täcker både läsning (som MANAGER ska ha) och de bindande handlingarna (som
 * MANAGER inte ska ha), och en klassnivålista kan inte skilja dem åt. Det är
 * tjänstegrinden som drar den linjen.
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
 *
 * ── Var grinden anropas ──────────────────────────────────────────────────────
 *
 *  • HTTP: i tjänstens enqueue-metoder (CollectionExportService,
 *    RentCollectionExportService) — innan något jobb köas.
 *  • AI: vid anropsstället i tool-executor, eftersom AI-verktyget
 *    `export_for_collection` anropar render-vägen SYNKRONT och alltså inte
 *    passerar enqueue-grinden. AI-lagrets ACCOUNTING_ONLY_ACTIONS nekar redan
 *    MANAGER där, men det är en separat lista — och två listor som kan glida
 *    isär är precis vad R1 finns till för att stänga.
 *  • PdfWorker: INTE grindad, medvetet. Den kör efter köandet, har ingen aktör,
 *    och grinden har redan passerats.
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
