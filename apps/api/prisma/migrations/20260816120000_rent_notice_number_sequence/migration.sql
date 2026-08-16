-- M3: avinumret allokeras via en sekvenstabell i stället för max+1.
--
-- Scopet är (organizationId, year, month) därför att numret bär år och månad i
-- SJÄLVA STRÄNGEN (`AVI-{år}-{mm}-{NNNN}`). Unikheten på RentNotice är
-- @@unique([organizationId, noticeNumber]) — per org — men eftersom prefixet
-- skiljer januari från februari räcker det att löpnumret är unikt inom sin månad.
CREATE TABLE "RentNoticeNumberSequence" (
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentNoticeNumberSequence_pkey" PRIMARY KEY ("organizationId","year","month")
);

ALTER TABLE "RentNoticeNumberSequence"
    ADD CONSTRAINT "RentNoticeNumberSequence_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- BACKFILL: seeda varje scope från det högsta löpnummer som redan används, så
-- att numreringen FORTSÄTTER i stället för att börja om på 0001 och kollidera
-- med en befintlig avi.
--
-- År och månad läses ur SJÄLVA NUMRET, inte ur RentNotice.year/month. Det är
-- strängen som kolliderar, så scopet måste seedas från strängen — skulle en
-- historisk rad ha kolumner som avviker från sitt eget prefix är det prefixet
-- som gäller.
--
-- Regexet utesluter det äldre formatet (t.ex. AVI-XXXXXX), som saknar
-- år/månad-prefix och därför inte kan kollidera med de nya numren.
INSERT INTO "RentNoticeNumberSequence" ("organizationId", "year", "month", "lastNumber", "updatedAt")
SELECT
    "organizationId",
    CAST(substring("noticeNumber" FROM '^AVI-([0-9]{4})-') AS INTEGER)   AS "year",
    CAST(substring("noticeNumber" FROM '^AVI-[0-9]{4}-([0-9]{2})-') AS INTEGER) AS "month",
    MAX(CAST(substring("noticeNumber" FROM '-([0-9]{4})$') AS INTEGER))  AS "lastNumber",
    NOW()
FROM "RentNotice"
WHERE "noticeNumber" ~ '^AVI-[0-9]{4}-[0-9]{2}-[0-9]{4}$'
GROUP BY 1, 2, 3;
