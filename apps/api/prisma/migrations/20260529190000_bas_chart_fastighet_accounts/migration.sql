-- FIX 9 · PR 1 — BAS-kontoplan för fastighet (LAGBROTT 3 + 4)
--
-- Bokföringslagen (1999:1078) kräver att räkenskapsinformation konteras mot
-- korrekta, branschanpassade BAS-konton. Eveno seedade tidigare felaktiga
-- hyresintäktskonton (3001/3010/3011/3012/3013/3030) och bokförde depositioner
-- mot 2490 (Övriga kortfristiga skulder).
--
-- Denna migration lägger till de korrekta BAS 2024-kontona (3900-serien för
-- fastighet + 2890 för mottagna depositioner) för alla organisationer som
-- redan har en seedad kontoplan. 2890 (Övriga kortfristiga skulder) väljs
-- framför 2820 eftersom 2820 i officiell BAS avser löneskulder till anställda
-- och skulle ge SIE4-kollision i revisorns bokslutsprogram.
--
-- Gamla konton RADERAS INTE: befintliga journalposter kan referera dem och
-- räkenskapsinformation måste bevaras i 7 år (BFL 7 kap 2 §). De slutar bara
-- användas vid ny auto-postering. Historiska verifikationer ligger kvar
-- oförändrade — append-only-principen (BFL 5 kap 5 §) tillåter inte att vi
-- skriver om redan bokförda poster.

INSERT INTO "Account" (id, "organizationId", number, name, type, "isActive")
SELECT gen_random_uuid(), o.id, v.number, v.name, v.type::"AccountType", true
FROM "Organization" o
CROSS JOIN (VALUES
  (3911, 'Hyresintäkter, bostäder', 'REVENUE'),
  (3912, 'Hyresintäkter, parkeringsplatser', 'REVENUE'),
  (3913, 'Hyresintäkter, lokaler', 'REVENUE'),
  (3914, 'Hyresintäkter, övriga (förråd m.m.)', 'REVENUE'),
  (3920, 'Hyresgästers el- och värmeersättning', 'REVENUE'),
  (2890, 'Mottagna depositioner (hyresgäster)', 'LIABILITY')
) AS v(number, name, type)
-- Bara organisationer som redan har en kontoplan — vi skapar inte konton för
-- orgs som medvetet saknar seedning.
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."organizationId" = o.id)
  -- Idempotent: hoppa över konton som redan finns (unik per org + nummer).
  AND NOT EXISTS (
    SELECT 1 FROM "Account" a2
    WHERE a2."organizationId" = o.id AND a2.number = v.number
  );
