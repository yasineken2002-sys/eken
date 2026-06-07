-- Inkasso PR 4b₀ — dokumentationsinfrastruktur som gör INV-B uppfyllbar i PR 4b.
-- Penganeutral: ingen statusövergång, ingen export, ingen bokföring.
--
-- reminderPdfStorageKey: R2-nyckel till den lagrade påminnelse-PDF:en.
-- reminderMessageId: Resends message-id för påminnelseutskicket, webhookens
--   korrelationsnyckel mot rätt avi (@unique → ingen cross-tenant-skrivning).
-- Båda nullbara, ingen backfill (befintliga avier saknar lagrad PDF/message-id).

-- AlterTable
ALTER TABLE "RentNotice" ADD COLUMN     "reminderMessageId" TEXT,
ADD COLUMN     "reminderPdfStorageKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RentNotice_reminderMessageId_key" ON "RentNotice"("reminderMessageId");

-- Idempotent leveranskorrelation (security-auditor MEDIUM): Resend levererar
-- at-least-once, så två samtidiga delivered/bounced-event för samma avi kan annars
-- skapa dubblettposter i den append-only RentNoticeEvent-loggen (check-then-act-
-- race). Ett PARTIELLT unikt index DB-enforce:ar att en avi har HÖGST ett
-- EMAIL_DELIVERED och ett EMAIL_BOUNCED — medan övriga event-typer
-- (INTEREST_ACCRUED, REMINDER_SENT, NOTE_ADDED …) får återkomma fritt. Ett brett
-- @@unique([rentNoticeId, type]) hade brutit dessa och går därför inte att uttrycka
-- i Prisma-schemat; indexet lever här i SQL (webhooken fångar P2002 som no-op).
CREATE UNIQUE INDEX "RentNoticeEvent_delivery_idempotency_key"
  ON "RentNoticeEvent"("rentNoticeId", "type")
  WHERE "type" IN ('EMAIL_DELIVERED', 'EMAIL_BOUNCED');
