-- H3 PR A: en banktransaktion får allokeras över FLERA hyresavier.
--
-- `RentNoticePayment.bankTransactionId` var @unique, alltså högst EN allokering
-- per banktransaktion. Vattenfallet (PR B) fördelar en klumpbetalning över flera
-- avier och kräver 1→N.
--
-- Spärrens AVSIKT bevaras: samma banktransaktion får inte allokeras dubbelt till
-- SAMMA avi. Det sammansatta indexet uttrycker exakt det, och är en SVAGARE
-- begränsning än den det ersätter — varje befintlig rad uppfyller den redan, så
-- migrationen kan inte falla på innehåll.
--
-- INERT vid införandet, mätt: noll banktransaktioner har mer än en allokering,
-- varken i dev (0 av 3 bank-kopplade) eller i prod (0 av 0). N är alltid 1 tills
-- PR B släpper på vattenfallet.
--
-- Postgres räknar NULL som distinkt i unika index, så manuella betalningar
-- (bankTransactionId = NULL) är oberörda — precis som under den gamla spärren.
DROP INDEX "RentNoticePayment_bankTransactionId_key";

CREATE UNIQUE INDEX "RentNoticePayment_bankTransactionId_rentNoticeId_key"
    ON "RentNoticePayment"("bankTransactionId", "rentNoticeId");
