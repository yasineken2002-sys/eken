-- CreateTable
CREATE TABLE "FailedEmail" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FailedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FailedEmail_createdAt_idx" ON "FailedEmail"("createdAt");

-- CreateIndex
CREATE INDEX "FailedEmail_template_idx" ON "FailedEmail"("template");

