import { ForbiddenException } from '@nestjs/common'
import { UserRole } from '@prisma/client'

/**
 * VEM FÅR SE HYRESKONTRAKT I DOKUMENTMODULEN?
 *
 * ── Varför bara EN kategori grindas ───────────────────────────────────────────
 *
 * Dokumentmodulens läsning är medvetet öppen för alla roller. Den bär
 * besiktningsfoton, ritningar, försäkringsbrev och annat en förvaltare eller
 * läsbehörig rimligen ska komma åt — och R1 avgjorde att läsning är förvaltning
 * (läsa = förvaltning får se, agera bindande = ekonomi).
 *
 * Ett dokument sticker ut: hyreskontraktet. Det bär hyresgästens PERSONNUMMER,
 * eftersom det är partsidentifieringen i ett bindande avtal
 * (contract-template.service.ts). Att grinda hela modulen för den enda
 * kategorins skull hade infört en gräns ingen bett om och tagit besiktningsfoton
 * med sig; att lämna den ogrindad lät varje autentiserad roll hämta varje
 * hyresavtal i organisationen. Grinden träffar därför kategorin, inte modulen.
 *
 * ── Varför i TJÄNSTEN och inte på controllern ────────────────────────────────
 *
 * Samma skäl som R1 (#194-mönstret): tjänsten är den punkt varje anropare måste
 * passera. En dekorator skyddar bara HTTP-vägen, och kontraktets PDF har redan
 * visat sig nåbar från mer än ett håll — `GET /contracts/download/:leaseId`
 * grindades separat, och dokumentmodulen var genvägen förbi den grinden.
 *
 * ── Listningen räknas som åtkomst ────────────────────────────────────────────
 *
 * `GET /documents?leaseId=` returnerar dokumentets `id`, och det id:t är allt
 * som behövs för nedladdningen. En grind som bara satt på nedladdningen hade
 * därför varit halva fixen: listan hade fortsatt dela ut nyckeln. Därför filtreras
 * CONTRACT-rader bort ur listan för roller som inte får se dem — de får sina
 * övriga dokument som förut, och får inte veta att kontraktet finns.
 *
 * Filtrering, inte 403, på listvägen: en lista med blandade kategorier ska inte
 * misslyckas i sin helhet för att den råkar innehålla ett kontrakt. Nedladdningen
 * däremot pekar ut EN rad, och där är ett nekande rätt svar.
 */
export const CONTRACT_DOCUMENT_ROLES: readonly UserRole[] = [
  UserRole.MANAGER,
  UserRole.ADMIN,
  UserRole.OWNER,
]

/** Samma mängd som contracts-controllerns generate/download/updateAppendix. */
export function mayAccessContractDocuments(role: UserRole | undefined): boolean {
  return role !== undefined && CONTRACT_DOCUMENT_ROLES.includes(role)
}

/**
 * Fail-closed: saknad roll nekas. Ett internt anrop utan aktörskontext ska inte
 * råka bli den bredaste vägen in — det var precis så #114 och R1 uppstod.
 */
export function assertMayAccessContractDocument(role: UserRole | undefined): void {
  if (!mayAccessContractDocuments(role)) {
    throw new ForbiddenException('Du har inte behörighet att öppna hyreskontrakt')
  }
}
