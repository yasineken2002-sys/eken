-- PR 2 (Resend-webhook): leverans-/bounce-/spam-status för portal-inbjudan.
-- inviteComplainedAt registrerar spam-anmälan (email.complained).
ALTER TABLE "Tenant" ADD COLUMN "inviteComplainedAt" TIMESTAMP(3);

-- lastInviteMessageId blir webhookens enda korrelationsnyckel mot rätt
-- hyresgäst. Unik-index gör korrelationen entydig: ett Resend-event kan
-- aldrig träffa mer än en hyresgäst (org-säker uppslagning). Flera NULL
-- tillåts av Postgres unika index, så hyresgäster utan utskick påverkas inte.
CREATE UNIQUE INDEX "Tenant_lastInviteMessageId_key" ON "Tenant"("lastInviteMessageId");
