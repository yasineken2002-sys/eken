-- #651, del 2 av 2. EGEN MIGRATION AV EN MEKANISK ORSAK, inte av stilskäl:
-- `ALTER TYPE … ADD VALUE` (föregående migration) får inte användas i SAMMA
-- transaktion som det skapas i, och Prisma kör varje migrationsfil i en
-- transaktion. Indexet nedan NÄMNER de nya värdena och måste därför ligga i en
-- senare fil.
--
-- Vad det gör: utvidgar den partiella unika idempotensen till avins egna
-- leveranstyper. Resend levererar at-least-once, så två samtidiga event för
-- samma avi skulle annars ge DUBBLETTER i den append-only RentNoticeEvent-
-- loggen — rader som per konstruktion inte går att städa bort.
-- Webhooken fångar P2002 som no-op, precis som för de befintliga typerna.
DROP INDEX IF EXISTS "RentNoticeEvent_delivery_idempotency_key";

CREATE UNIQUE INDEX "RentNoticeEvent_delivery_idempotency_key"
  ON "RentNoticeEvent"("rentNoticeId", "type")
  WHERE "type" IN (
    'EMAIL_DELIVERED',
    'EMAIL_BOUNCED',
    'NOTICE_EMAIL_DELIVERED',
    'NOTICE_EMAIL_BOUNCED'
  );
