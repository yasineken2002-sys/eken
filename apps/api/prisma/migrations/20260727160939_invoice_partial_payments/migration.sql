-- Betalningsallokering mot faktura (C4/C5) — speglar RentNoticePayment.
--
-- Före denna modell bokförde båda fakturans betalvägar (bankmatchning och
-- POST /invoices/:id/pay) alltid fakturans TOTAL, oavsett mottaget belopp.
-- 1930 divergerade därmed från kontoutdraget vid varje delbetalning.

-- CreateEnum
CREATE TYPE "InvoicePaymentSource" AS ENUM ('BANK_RECONCILIATION', 'MANUAL');

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "bankTransactionId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "source" "InvoicePaymentSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- En bank-transaktion får allokeras till EXAKT en faktura (dubbel-allokerings-
-- skydd). NULL är distinkt i Postgres unika index → flera manuella allokeringar
-- kan samexistera på samma faktura.
CREATE UNIQUE INDEX "InvoicePayment_bankTransactionId_key" ON "InvoicePayment"("bankTransactionId");

CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, inte CASCADE: en bank-transaktion är räkenskapsinformation. Skulle
-- den ändå tas bort ska allokeringen finnas kvar — betalningen har ju skett.
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
