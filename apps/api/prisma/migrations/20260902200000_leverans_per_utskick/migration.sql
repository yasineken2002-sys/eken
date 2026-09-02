-- LEVERANSIDENTITET PER UTSKICK — enheten rättad (#656).
--
-- ── VAD SOM VAR OSANT ───────────────────────────────────────────────────────
--
--   UNIQUE("rentNoticeId", "type")  WHERE type IN (de fyra leveranstyperna)
--
-- Villkoret påstår "en avi kan studsa en gång". Det är inte sant: en avi kan
-- skickas många gånger, och varje UTSKICK har sitt eget utfall. Följden var att
-- en omsändning som studsade igen inte gick att registrera alls — webhooken
-- fångade P2002 som no-op — och att INV-B:s `has('EMAIL_BOUNCED')` blockerade
-- för alltid även efter en lyckad omsändning.
--
-- Med enheten rättad finns ingen tidsstämpel att jämföra. Varje utskick bär
-- sitt eget svar.
--
-- ── MÄTT FÖRE KÖRNING: LÄGGER APPEND-ONLY-TRIGGERN SIG I? ───────────────────
--
-- `RentNoticeEvent` bär `append_only_rent_notice_event` (BEFORE UPDATE FOR EACH
-- STATEMENT) sedan #585. Uppmätt 2026-09-02 mot eken_dev, i en transaktion som
-- rullades tillbaka:
--
--     triggern på tabellen                          AKTIV
--     ALTER TABLE ADD COLUMN NOT NULL DEFAULT ''    OK
--     DROP INDEX + CREATE UNIQUE INDEX              OK
--     UPDATE ... SET "sendId" = 'x'                 AVVISAD av triggern
--
-- DDL rör alltså inte triggern, men en BACKFILL vore omöjlig. Migrationen gör
-- därför ingen — och behöver ingen, se sentinelvalet nedan.
--
-- ── DÄRFÖR NOT NULL MED TOM DEFAULT, INTE NULLBAR ───────────────────────────
--
-- Två NULL är DISTINKTA i ett unikt index. En nullbar kolumn hade alltså tyst
-- tagit bort skyddet för varje rad som fanns före kolumnen: två `EMAIL_BOUNCED`
-- med NULL hade båda fått plats. Tom sträng kolliderar med sig själv och bevarar
-- exakt den gamla semantiken för de raderna — en av varje typ.
--
-- Mätt i produktion före körning: 2 avier, 13 händelser, 0 leveranshändelser,
-- 0 avier med reminderMessageId. Formen är vald för att den är riktig, inte för
-- att volymen är liten.
--
-- ── INGEN FRÄMMANDE NYCKEL PÅ sendId ────────────────────────────────────────
--
-- `''` betyder "skrevs innan utskicket var en egen enhet" och pekar per
-- definition inte på någon rad. En FK hade avvisat exakt de rader som måste få
-- finnas kvar. Kopplingen upprätthålls av koden: varje NY rad får ett sendId
-- som finns.


-- CreateEnum
CREATE TYPE "RentNoticeSendKind" AS ENUM ('REMINDER', 'NOTICE');

-- AlterTable
ALTER TABLE "RentNoticeEvent" ADD COLUMN     "sendId" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "RentNoticeSend" (
    "id" TEXT NOT NULL,
    "rentNoticeId" TEXT NOT NULL,
    "kind" "RentNoticeSendKind" NOT NULL,
    "messageId" TEXT,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentNoticeSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RentNoticeSend_messageId_key" ON "RentNoticeSend"("messageId");

-- CreateIndex
CREATE INDEX "RentNoticeSend_rentNoticeId_createdAt_idx" ON "RentNoticeSend"("rentNoticeId", "createdAt");

-- AddForeignKey
ALTER TABLE "RentNoticeSend" ADD CONSTRAINT "RentNoticeSend_rentNoticeId_fkey" FOREIGN KEY ("rentNoticeId") REFERENCES "RentNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── DET UNIKA INDEXET, MED RÄTT ENHET ──────────────────────────────────────
--
-- Prisma kan inte uttrycka ett partiellt unikt index, så det står i rå SQL och
-- skyddas av `check-critical-indexes.mjs`.
DROP INDEX IF EXISTS "RentNoticeEvent_delivery_idempotency_key";

CREATE UNIQUE INDEX "RentNoticeEvent_delivery_idempotency_key"
  ON "RentNoticeEvent"("rentNoticeId", "type", "sendId")
  WHERE "type" IN (
    'EMAIL_DELIVERED',
    'EMAIL_BOUNCED',
    'NOTICE_EMAIL_DELIVERED',
    'NOTICE_EMAIL_BOUNCED'
  );

-- Webhooken slår upp utskicket på händelsens sendId när den skriver utfallet.
CREATE INDEX "RentNoticeEvent_sendId_idx" ON "RentNoticeEvent"("sendId");
