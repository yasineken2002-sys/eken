-- #653: kolumnen bär Bulls jobId, inte Resends email_id. Namnet sa något annat,
-- och just den tvetydigheten lät #651 överleva i månader.
--
-- RENAME, inte ny kolumn + kopiering: värdet är oförändrat och korrekt för sitt
-- syfte. Det är etiketten som var fel. En RENAME bevarar dessutom raderna utan
-- ett migreringssteg som kan halvköras.
--
-- Prod har 0 rader i PaymentReminder (mätt 2026-09-02), så låset är trivialt.
ALTER TABLE "PaymentReminder" RENAME COLUMN "emailMessageId" TO "mailJobId";
