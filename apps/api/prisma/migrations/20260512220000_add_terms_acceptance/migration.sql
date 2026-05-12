-- Acceptans av Användarvillkor och Integritetspolicy.
--
-- User-fälten sätts vid signup när användaren bockat i acceptansrutan.
-- Befintliga konton har dessa NULL och får re-acceptance-modal vid
-- nästa inloggning.
--
-- Organization-fälten används av re-acceptance-flödet när vi höjer
-- CURRENT_TERMS_VERSION i @eken/shared för att tvinga existerande
-- kunder att godkänna nya villkor.

ALTER TABLE "User"
  ADD COLUMN "acceptedTermsAt" TIMESTAMP(3),
  ADD COLUMN "termsVersion" TEXT;

ALTER TABLE "Organization"
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "termsVersion" TEXT;
