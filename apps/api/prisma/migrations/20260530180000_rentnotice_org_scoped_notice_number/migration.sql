-- RentNotice.noticeNumber: globalt unik → unik PER ORGANISATION (H1)
--
-- Bugg/korrekthet: noticeNumber hade ett globalt unikt index
-- (RentNotice_noticeNumber_key) medan avinummer genereras per organisation i
-- serien AVI-{år}-{månad}-{NNNN}. nextNoticeNumber() räknade dessutom max-
-- sekvensen över ALLA organisationers avier (saknade organizationId-filter),
-- så en ny kunds serie kunde börja på t.ex. AVI-2026-06-0047, och två orgar
-- kunde kollidera på samma globala nummer (P2002).
--
-- Fixen gör numret unikt inom organisationen (matchar contractNumber-,
-- verifikationsnummer- och fakturanummer-mönstret). Detta SLÄPPER på
-- constrainten (per-org är svagare än globalt), så befintliga rader — som
-- redan är globalt unika — förblir giltiga. Den composite unique:n indexerar
-- även (organizationId, noticeNumber) → prefixsökningen i nextNoticeNumber
-- slipper full table scan.

-- DropIndex (globalt unikt)
DROP INDEX "RentNotice_noticeNumber_key";

-- CreateIndex (unikt per organisation)
CREATE UNIQUE INDEX "RentNotice_organizationId_noticeNumber_key" ON "RentNotice"("organizationId", "noticeNumber");
