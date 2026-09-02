-- G1 STEG 3 — DET VARAKTIGA AKTÖRSSLAGET
--
-- KOLUMNEN ÄR NULLBAR OCH BEFINTLIGA RADER FÅR NULL. Ingen backfill.
-- NULL BETYDER OKÄNT, INTE MÄNNISKA: att stämpla gamla rader HUMAN hade varit
-- exakt det obelagda påstående hela G1 finns för att ta bort.
--
-- Kolumnen sätts av `actorStampExtension` utifrån en kontext som öppnas vid tre
-- gränser (interceptorn = HUMAN, runCronSafely = SYSTEM, runAsAi = AGENT) — inte
-- av de 183 icke-AI-skrivställen som annars hade behövt komma ihåg den.
--
-- BRYTPUNKTEN: rader skapade efter `AKTORSKOLUMNENS_BRYTPUNKT` som ändå saknar
-- aktör är läckan, och `ActorNullSweepService` larmar på dem. Det är motmedlet
-- mot att NULL blir ett tyst normaltillstånd — och därmed mot att en bortkopplad
-- stämpling ser ut som gammalt data.
--
-- `Account.createdAt` läggs till i samma migration därför att brytpunkten kräver
-- den; utan den kunde tabellen inte mätas, och hade fallit ur mängden av ett
-- skäl som inte har med aktören att göra.

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('HUMAN', 'AGENT', 'SYSTEM');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "actorKind" "ActorKind",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "ConsumptionCharge" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "ConsumptionTariff" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "Deposit" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "Lease" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "MaintenancePlan" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "MaintenanceTicket" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "Meter" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "MeterReading" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "MiscCharge" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "RentIncrease" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "RentNotice" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "SentMessage" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "SignatureEvidence" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "SigningRequest" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "TerminationRequest" ADD COLUMN     "actorKind" "ActorKind";

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "actorKind" "ActorKind";
