-- Portal-inbjudan (massutskick): spårar massinbjudan separat från aktiveringstoken.
-- Statusen härleds i läs-endpointen; leverans-/bounce-fälten fylls i PR 2 (Resend-webhook).
ALTER TABLE "Tenant" ADD COLUMN "invitedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "inviteCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Tenant" ADD COLUMN "inviteDeliveredAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "inviteBouncedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "inviteBounceReason" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "lastInviteMessageId" TEXT;
