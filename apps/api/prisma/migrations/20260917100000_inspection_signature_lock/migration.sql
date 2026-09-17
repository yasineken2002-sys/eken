-- FRYSNINGEN AV DET SIGNERADE BESIKTNINGSPROTOKOLLET (F025)
--
-- Spärren som nekar efterhandsändring bor i tjänstelagret, under radlås
-- (`inspections.service.ts`). Den här migrationen lägger till det som spärren
-- inte kan skapa i efterhand: uppgiften om VAD som signerades, och NÄR en
-- barnrad skrevs.
--
-- ── ÄLDRE RADER FÅR NULL, OCH BACKFILLAS INTE ───────────────────────────────
--
-- Det är det enda ärliga utfallet, och det är ett medvetet val:
--
--   * "InspectionItem"."createdAt" — en `DEFAULT CURRENT_TIMESTAMP` på ett
--     tillägg skriver migrationens tidpunkt på VARENDA befintlig post. En
--     skadepost som ser ut att ha skapats 2026-09-17, i ett protokoll som
--     signerades i mars, är värre än en tom kolumn: den ser ut som en uppgift
--     och skulle läsas som en. Kolumnen läggs därför till UTAN default, och
--     defaulten sätts EFTERÅT så att den bara gäller nya rader.
--
--   * "Inspection"."signedContentHash" — går inte att räkna fram för redan
--     signerade protokoll. En hash beräknad i dag beskriver innehållet i dag,
--     inte innehållet vid signeringen, och just skillnaden mellan de två är vad
--     fältet finns för att fånga. Att lagra den som om den gällde vid
--     signeringen hade varit att tillverka beviset.
--
-- Följden, uttryckligen: för protokoll som signerades FÖRE den här migrationen
-- kan modellen inte bevisa någonting om innehållets oförändrade skick. De
-- fryses från och med nu, men det som redan kan ha ändrats går inte att upptäcka
-- i efterhand. Samma resonemang som "actorKind" (G1 steg 3), där NULL betyder
-- OKÄNT och aldrig stämplades om till ett antagande.

BEGIN;

ALTER TABLE "Inspection" ADD COLUMN "signedContentHash" TEXT;

-- Utan DEFAULT: befintliga rader ska bli NULL, inte stämplade.
ALTER TABLE "InspectionItem" ADD COLUMN "createdAt" TIMESTAMP(3);
ALTER TABLE "InspectionItem" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Defaulten gäller därefter bara rader som skapas efter den här punkten, vilket
-- är hela poängen med att dela upp det i två satser.
ALTER TABLE "InspectionItem" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

COMMIT;
