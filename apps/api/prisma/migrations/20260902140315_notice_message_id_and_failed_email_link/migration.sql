-- #651: webhookens korrelationsnycklar, och kopplingen från ett misslyckat
-- utskick tillbaka till avin.
--
-- ADDITIVT OCH NULLBART. Ingen backfill: befintliga rader får NULL, vilket är
-- det ärliga läget. De två prod-rader som i dag bär Bulls jobId i
-- reminderMessageId nollställs i en SEPARAT, antecknad åtgärd — inte som en
-- tyst bieffekt av den här migrationen.

-- AlterTable
ALTER TABLE "RentNotice" ADD COLUMN     "noticeMessageId" TEXT;

-- AlterTable
ALTER TABLE "FailedEmail" ADD COLUMN     "rentNoticeId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RentNotice_noticeMessageId_key" ON "RentNotice"("noticeMessageId");

-- CreateIndex
CREATE INDEX "FailedEmail_rentNoticeId_idx" ON "FailedEmail"("rentNoticeId");

-- AddForeignKey
-- CASCADE och inte SET NULL: FailedEmail bär en append-only-trigger på SATSNIVÅ
-- (append_only_failed_email, #585). SET NULL är en kaskad-UPDATE som spärren
-- fäller, vilket hade brutit avi-borttagandet i stället för att nolla kolumnen.
-- DELETE spärras inte.
ALTER TABLE "FailedEmail" ADD CONSTRAINT "FailedEmail_rentNoticeId_fkey" FOREIGN KEY ("rentNoticeId") REFERENCES "RentNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── AVINS EGEN LEVERANS FÅR EGNA HÄNDELSETYPER ──────────────────────────────
--
-- Inte kosmetik. INV-B-grinden (checkInkassoReadiness) läser EMAIL_DELIVERED som
-- beviset att PÅMINNELSEN nått gäldenären. Hade avins leverans skrivit samma typ
-- hade den tyst uppfyllt grinden, och ett krav kunnat gå till inkasso på beviset
-- att den ursprungliga avin kom fram — inte påminnelsen.
ALTER TYPE "RentNoticeEventType" ADD VALUE IF NOT EXISTS 'NOTICE_EMAIL_DELIVERED';
ALTER TYPE "RentNoticeEventType" ADD VALUE IF NOT EXISTS 'NOTICE_EMAIL_BOUNCED';
