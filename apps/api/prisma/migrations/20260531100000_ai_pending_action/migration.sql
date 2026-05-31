-- SECURITY (AI RISK 1): server-lagrad pending action för AI-confirm.
-- confirm-endpointen validerar mot en icke-konsumerad, ej utgången rad så att
-- en klient inte kan bekräfta en åtgärd AI:n aldrig föreslog (human-in-the-loop).

CREATE TABLE "AiPendingAction" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolInputHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiPendingAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiPendingAction_conversationId_idx" ON "AiPendingAction"("conversationId");
CREATE INDEX "AiPendingAction_organizationId_userId_idx" ON "AiPendingAction"("organizationId", "userId");
CREATE INDEX "AiPendingAction_expiresAt_idx" ON "AiPendingAction"("expiresAt");

ALTER TABLE "AiPendingAction" ADD CONSTRAINT "AiPendingAction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
