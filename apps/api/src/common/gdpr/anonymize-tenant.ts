import type { Prisma } from '@prisma/client'

/**
 * AVIDENTIFIERING AV EN HYRESGÄST — GDPR Art. 17, en enda implementation.
 *
 * ── VARFÖR AVIDENTIFIERING OCH INTE RADERING ────────────────────────────────
 *
 * Två skäl, och det första är rent mekaniskt:
 *
 *   1. En hyresgäst med historik GÅR INTE att radera. Elva modeller bär
 *      Restrict-FK mot `Tenant` (Lease, Invoice, Document ×2, MaintenanceTicket,
 *      RentNotice, Inspection, SentMessage, Deposit, KeyHandover,
 *      ConsumptionCharge, MiscCharge). Mätt i dev: 5 av 532 hyresgäster (0,9 %)
 *      är faktiskt raderbara — de som aldrig haft ett avtal.
 *   2. Underlaget SKA bevaras. Avierna och verifikaten är räkenskapsmaterial.
 *
 * Avidentifiering är därför den enda operation som faktiskt kan verkställa en
 * raderingsbegäran mot en verklig hyresgäst.
 *
 * ── VARFÖR EN DELAD FUNKTION ────────────────────────────────────────────────
 *
 * Det finns två vägar hit: hyresgästen själv via portalen, och operatören via
 * webbappen. De ska ge IDENTISKT sluttillstånd. Två kopior av fältlistan
 * divergerar första gången någon lägger till en kolumn — och den divergensen
 * syns inte i något test som bara kör en av vägarna. Samma skäl som
 * `assertPaymentWithinDebt` finns i ett exemplar.
 *
 * ── IDEMPOTENS ──────────────────────────────────────────────────────────────
 *
 * Funktionen är idempotent BY CONSTRUCTION: att nolla ett redan nollat fält är
 * en no-op. Den körs därför om även på en redan avidentifierad hyresgäst, så att
 * data som tillkommit efteråt (t.ex. en ny nyckelkvittens) också skrubbas.
 *
 * Två saker rörs däremot INTE en andra gång:
 *   - `anonymizedAt` behåller sin FÖRSTA tidpunkt. Den svarar på "när begärdes
 *     radering", inte "när kördes skrubben senast".
 *   - Ingen ny loggrad skrivs. En idempotent operation ska inte se ut som
 *     upprepade raderingsbegäranden i revisionsspåret.
 *
 * Returvärdet säger vilket av fallen som inträffade, så att anroparen kan skilja
 * "verkställde nu" från "var redan verkställd" utan att gissa.
 */
export interface AnonymizeResult {
  /** false = hyresgästen var redan avidentifierad; ingen ny loggrad skrevs. */
  performed: boolean
  /** Tidpunkten för den FÖRSTA avidentifieringen. */
  anonymizedAt: Date
}

export interface AnonymizeActor {
  /** null = hyresgästen själv via portalen (ingen User finns att peka på). */
  performedById: string | null
  ipAddress?: string | undefined
  userAgent?: string | undefined
  reason?: string | undefined
}

export function maskedTenantEmail(tenantId: string): string {
  return `gdpr-deleted-${tenantId.slice(0, 8)}@gdpr.invalid`
}

/**
 * Kör avidentifieringen inuti en befintlig transaktion.
 *
 * Anroparen äger transaktionen, eftersom operatörsvägen behöver läsa grindar i
 * samma transaktion som den skriver.
 */
export async function anonymizeTenantWithin(
  tx: Prisma.TransactionClient,
  tenantId: string,
  organizationId: string,
  actor: AnonymizeActor,
): Promise<AnonymizeResult> {
  const before = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { anonymizedAt: true },
  })
  const alreadyDone = before.anonymizedAt !== null
  const now = new Date()

  await tx.tenant.update({
    where: { id: tenantId },
    data: {
      firstName: null,
      lastName: null,
      companyName: 'Raderad hyresgäst',
      email: maskedTenantEmail(tenantId),
      phone: null,
      // Radera personnumret i BÅDA kolumnerna: chiffertext och blind-index.
      // Missas blind-indexet går personen fortfarande att korrelera efter en
      // Art. 17-radering — hashen är deterministisk och jämförbar mellan rader.
      personalNumberEnc: null,
      personalNumberHash: null,
      orgNumber: null,
      street: null,
      city: null,
      postalCode: null,
      contactPerson: null,
      passwordHash: null,
      portalActivated: false,
      activationTokenHash: null,
      activationTokenExpiresAt: null,
      activationReminderSentAt: null,
      passwordResetTokenHash: null,
      passwordResetTokenExpiresAt: null,
      // Behåll den första tidpunkten vid en upprepad körning.
      ...(alreadyDone ? {} : { anonymizedAt: now }),
    },
  })

  // Aktiva sessioner faller omedelbart, utan att vänta på att en token går ut.
  // Samma grepp som UsersService.deactivate återkallar refresh-tokens.
  await tx.tenantSession.deleteMany({ where: { tenantId } })

  // ── FRITEXTNAMN I ANGRÄNSANDE TABELL ──────────────────────────────────────
  //
  // `KeyHandover.issuedToName` bär namnet på den som fysiskt kvitterade nyckeln
  // när det var någon annan än hyresgästen (sambo, firmatecknare). Det är ett
  // rent namnfält utan rättslig funktion — kvittensen bevisas av raden själv,
  // inte av namnsträngen — och nollas därför.
  await tx.keyHandover.updateMany({
    where: { tenantId, issuedToName: { not: null } },
    data: { issuedToName: null },
  })

  // ── UTTRYCKLIGT UNDANTAG: SentMessage ─────────────────────────────────────
  //
  // `SentMessage.subject` och `.content` kan bära namn och personnummer, och
  // skrubbas ändå INTE här. Det är ett medvetet undantag, inte ett förbiseende.
  //
  // Skälet är att ett skickat meddelande kan VARA ett hyresrättsligt dokument —
  // en hyreshöjning, en rättelseanmaning, en uppsägning — där brödtexten är
  // beviset för vad som faktiskt meddelats och när. Att skrubba den kan förstöra
  // hyresvärdens möjlighet att göra en rättighet gällande.
  //
  // Avvägningen mellan den bevisfunktionen och Art. 17 är en HYRESRÄTTSLIG fråga
  // som ligger öppen för mänsklig juridisk bedömning. Inget lagrum skrivs här
  // förrän den är avgjord. Se GDPR-ärendet.
  //
  // Lägg alltså inte till en `sentMessage.updateMany` här utan att först läsa
  // det svaret.

  if (!alreadyDone) {
    await tx.tenantAnonymizationLog.create({
      data: {
        organizationId,
        tenantId,
        performedById: actor.performedById,
        performedAt: now,
        ...(actor.ipAddress ? { ipAddress: actor.ipAddress } : {}),
        ...(actor.userAgent ? { userAgent: actor.userAgent } : {}),
        ...(actor.reason ? { reason: actor.reason } : {}),
      },
    })
  }

  return { performed: !alreadyDone, anonymizedAt: before.anonymizedAt ?? now }
}
