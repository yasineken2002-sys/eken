-- G4a: förstklassig händelsetyp för struken påminnelseavgift.
--
-- Speglar PAYMENT_REVERSED, som infördes med samma motivering (#326 C): en egen
-- typ i stället för NOTE_ADDED med en action-flagga i payloaden, eftersom
-- @@index([rentNoticeId, type]) gör en förstklassig typ sökbar medan en
-- payload-diskriminerad NOTE_ADDED bara går att hitta genom att läsa JSON i
-- varje rad. En behandlingshistorik som inte går att fråga är svår att granska.
--
-- Behövs särskilt här: strykningen raderar avgiftsraden respektive nollar
-- reminderFeeAmount, och till skillnad från VOID finns ingen statusändring på
-- dokumentet som förklarar varför beloppet försvann. Utan händelsen är
-- åtgärden osynlig i avins historik.
--
-- ENDAST RÄTTELSE (G4a). Eftergift av en giltig fordran (G4b) är en ANNAN
-- affärshändelse med annan kontering, och ska få en egen typ när FAR:s
-- kontobeslut är verifierat av människa.

ALTER TYPE "RentNoticeEventType" ADD VALUE IF NOT EXISTS 'REMINDER_FEE_REVERSED';
ALTER TYPE "InvoiceEventType" ADD VALUE IF NOT EXISTS 'REMINDER_FEE_REVERSED';
