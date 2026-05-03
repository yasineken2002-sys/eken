-- AI usage logging + tool execution audit
--
-- AiUsageLog: spårar varje Anthropic API-anrop. Används för:
--   1. Per-org månadskvota (blockera när kostnaden når taket)
--   2. Rapporter över AI-användning per användare/endpoint/modell
--
-- AiToolExecution: audit-logg över varje tool som AI:n kört. Krävs för
-- GDPR (Art. 30 — registerföring av behandling) och för att kunna utreda
-- vad AI:n faktiskt har gjort i kundens data.

CREATE TABLE "AiUsageLog" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT,
  "endpoint" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DECIMAL(10,6) NOT NULL,
  "costSek" DECIMAL(10,4) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiUsageLog_organizationId_createdAt_idx" ON "AiUsageLog"("organizationId", "createdAt");
CREATE INDEX "AiUsageLog_userId_createdAt_idx" ON "AiUsageLog"("userId", "createdAt");

ALTER TABLE "AiUsageLog"
  ADD CONSTRAINT "AiUsageLog_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AiUsageLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AiToolExecution" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT,
  "toolName" TEXT NOT NULL,
  "toolInput" JSONB NOT NULL,
  "toolResult" JSONB,
  "success" BOOLEAN NOT NULL,
  "errorMessage" TEXT,
  "durationMs" INTEGER NOT NULL,
  "requiredConfirmation" BOOLEAN NOT NULL DEFAULT false,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiToolExecution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiToolExecution_organizationId_createdAt_idx" ON "AiToolExecution"("organizationId", "createdAt");
CREATE INDEX "AiToolExecution_userId_createdAt_idx" ON "AiToolExecution"("userId", "createdAt");
CREATE INDEX "AiToolExecution_toolName_idx" ON "AiToolExecution"("toolName");

ALTER TABLE "AiToolExecution"
  ADD CONSTRAINT "AiToolExecution_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AiToolExecution_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
