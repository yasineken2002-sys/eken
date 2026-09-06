-- Betalningssättet på en fakturaallokering: enum + råtext.
--
-- ── VARFÖR INGEN BACKFILL AV RÅTEXT ─────────────────────────────────────────
--
-- Fakturavägen har ALDRIG lagrat råtexten. `toPaymentMethod` mappade den i
-- controllern och det som nådde databasen var redan enumvärdet, i
-- `InvoiceEvent.payload` (jsonb). Det finns alltså ingen kolumn med 'Bankgiro'
-- att översätta — en mappande UPDATE här hade haft en tom mängd och sett ut som
-- ett arbete den inte utförde.
--
-- Nya kolumner är NULL för äldre allokeringar. Det är rätt: `InvoicePayment` är
-- en betalningspost och en backfill hade fabricerat en uppgift som aldrig
-- registrerades.
ALTER TABLE "InvoicePayment" ADD COLUMN "paymentMethod" "PaymentMethod";
ALTER TABLE "InvoicePayment" ADD COLUMN "paymentMethodRaw" TEXT;

-- ── OCH DET SOM FAKTISKT MÅSTE KONTROLLERAS ─────────────────────────────────
--
-- Kravet var "okänd råtext → rött, aldrig tyst MANUAL". Den enda plats där ett
-- betalsätt redan står lagrat på fakturavägen är `InvoiceEvent.payload`. Efter
-- den här migrationen är enumen den enda tillåtna formen även där, så varje
-- befintligt värde måste vara ett enumvärde. Är det inte det — t.ex. en rad
-- skriven innan `toPaymentMethod` fanns, eller av en väg vi inte känner —
-- FÄLLER migrationen, och en människa får avgöra vad värdet betyder.
--
-- Kontrollen är inte tom av konstruktion: den läser varje rad som HAR fältet,
-- och `payment_method_migration.db.spec.ts` matar in ett okänt värde och kräver
-- att den här satsen kastar.
DO $$
DECLARE
  okanda TEXT;
BEGIN
  SELECT string_agg(DISTINCT v, ', ')
    INTO okanda
    FROM (
      SELECT payload->>'paymentMethod' AS v
        FROM "InvoiceEvent"
       WHERE payload ? 'paymentMethod'
         AND payload->>'paymentMethod' IS NOT NULL
    ) q
   WHERE v NOT IN ('BANK', 'CASH', 'SWISH', 'MANUAL');

  IF okanda IS NOT NULL THEN
    RAISE EXCEPTION
      'InvoiceEvent.payload innehåller betalsätt utanför PaymentMethod-enumen: %. Migrationen stannar hellre än att gissa; översätt värdena explicit och kör om.',
      okanda;
  END IF;
END $$;
