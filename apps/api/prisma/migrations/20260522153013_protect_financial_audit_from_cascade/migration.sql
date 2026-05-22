-- FIX 3: Skydda räkenskaps- och revisionsdata mot kaskadradering.
--
-- Bokföringslagen (1999:1078) kräver att räkenskapsinformation bevaras i 7 år.
-- Tidigare kaskadraderades all finansiell data när en Organization togs bort.
-- Denna migration byter onDelete: Cascade -> Restrict på finansiella entiteter
-- och revisionsentiteter, samt Cascade -> SetNull på AiToolExecution.user/tenant
-- (konsekvent med AiUsageLog, så revisionsspåret bevaras).
--
-- Endast FK-constraints ändras. Ingen data tas bort, inga kolumner/tabeller rörs.

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_organizationId_fkey";
ALTER TABLE "InvoiceEvent" DROP CONSTRAINT "InvoiceEvent_invoiceId_fkey";
ALTER TABLE "Account" DROP CONSTRAINT "Account_organizationId_fkey";
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_organizationId_fkey";
ALTER TABLE "ClosedAccountingPeriod" DROP CONSTRAINT "ClosedAccountingPeriod_organizationId_fkey";
ALTER TABLE "BankTransaction" DROP CONSTRAINT "BankTransaction_organizationId_fkey";
ALTER TABLE "RentNotice" DROP CONSTRAINT "RentNotice_organizationId_fkey";
ALTER TABLE "Deposit" DROP CONSTRAINT "Deposit_organizationId_fkey";
ALTER TABLE "RentIncrease" DROP CONSTRAINT "RentIncrease_organizationId_fkey";
ALTER TABLE "PlatformInvoice" DROP CONSTRAINT "PlatformInvoice_organizationId_fkey";
ALTER TABLE "AiUsageLog" DROP CONSTRAINT "AiUsageLog_organizationId_fkey";
ALTER TABLE "AiToolExecution" DROP CONSTRAINT "AiToolExecution_organizationId_fkey";
ALTER TABLE "AiToolExecution" DROP CONSTRAINT "AiToolExecution_userId_fkey";
ALTER TABLE "AiToolExecution" DROP CONSTRAINT "AiToolExecution_tenantId_fkey";
ALTER TABLE "ImpersonationLog" DROP CONSTRAINT "ImpersonationLog_organizationId_fkey";
ALTER TABLE "ErrorLog" DROP CONSTRAINT "ErrorLog_organizationId_fkey";

-- AddForeignKey (financial — Bokföringslagen 1999:1078)
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceEvent" ADD CONSTRAINT "InvoiceEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Account" ADD CONSTRAINT "Account_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClosedAccountingPeriod" ADD CONSTRAINT "ClosedAccountingPeriod_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RentNotice" ADD CONSTRAINT "RentNotice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RentIncrease" ADD CONSTRAINT "RentIncrease_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformInvoice" ADD CONSTRAINT "PlatformInvoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (audit — revisionsspår måste bevaras)
ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiToolExecution" ADD CONSTRAINT "AiToolExecution_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiToolExecution" ADD CONSTRAINT "AiToolExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiToolExecution" ADD CONSTRAINT "AiToolExecution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImpersonationLog" ADD CONSTRAINT "ImpersonationLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ErrorLog" ADD CONSTRAINT "ErrorLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
