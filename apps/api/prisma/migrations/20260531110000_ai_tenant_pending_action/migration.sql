-- SECURITY (RISK 1, tenant-AI): pending-action-bindning för hyresgäst-confirm.
-- Förhindrar att en hyresgäst bekräftar en åtgärd (t.ex. request_termination)
-- som AI:n aldrig föreslog, genom direktanrop mot confirm-endpointen.
ALTER TABLE "AiTenantConversation" ADD COLUMN "pendingActionHash" TEXT;
ALTER TABLE "AiTenantConversation" ADD COLUMN "pendingActionExpiresAt" TIMESTAMP(3);
