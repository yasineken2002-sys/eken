-- Strypventil för utgående e-post, per organisation.
--
-- Additiv och defaultad till false: varje befintlig organisation fortsätter
-- mejla exakt som förut. Kolumnen läses av MailQueue.enqueue (primär grind) och
-- av mail.worker precis före Resend (sistahandsskydd för jobb som redan låg i
-- kön när flaggan sattes).
ALTER TABLE "Organization"
  ADD COLUMN "transactionalEmailsDisabled" BOOLEAN NOT NULL DEFAULT false;
