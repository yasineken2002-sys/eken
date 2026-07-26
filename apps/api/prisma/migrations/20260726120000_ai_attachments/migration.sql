-- CreateTable
CREATE TABLE "AiAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAttachment_organizationId_userId_idx" ON "AiAttachment"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "AiAttachment_conversationId_idx" ON "AiAttachment"("conversationId");

-- CreateIndex
CREATE INDEX "AiAttachment_consumedAt_expiresAt_idx" ON "AiAttachment"("consumedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "AiAttachment" ADD CONSTRAINT "AiAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAttachment" ADD CONSTRAINT "AiAttachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAttachment" ADD CONSTRAINT "AiAttachment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
