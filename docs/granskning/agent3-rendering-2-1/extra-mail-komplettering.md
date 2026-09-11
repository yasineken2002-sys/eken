**Sent kompletterat föreunderlag: InvoiceReminder.**

Den delade `mail/templates/shared/format.ts` används av fem React-mallar.
InvoiceCreated, InvoiceOverdue, ReminderFriendly och ReminderFormal finns i
den auktoritativa serien. InvoiceReminder (`InvoiceReminder.tsx:38`) är också
registrerad i `MailRenderer` och tillgänglig genom `sendInvoiceReminder`,
men saknar identifierad aktuell produktionsanropare och saknades i de sex
ursprungliga goldenfallen. Ändringen till UTC påverkar även denna mall.

Denna serie kompletterar det tidigare underlaget efter att luckan upptäckts.
Den är inte en ursprunglig före-fångst från tiden före implementationen och
ersätter eller skriver aldrig om `before-final-1/2`. Föreläget återkör den
verkliga MailRenderer-klassen och samtliga dess mejlmallar från exakta Git-blobbar
på `5ae9906b152307eae0d79eec719d4303a042742c`. Efterläget kör aktuell riktig
adapter. Installerade React-/React Email-/Node-beroenden används och redovisas
i varje manifest; detta återställer inte någon okänd historisk runtime.

Fixturen använder en syntetisk faktura utan förbrukning med förfallotid
`2026-09-11T23:30:00.000Z`. Endast body-fältet med förfallodatum ändras för en
värd i Europe/Stockholm: `12 september 2026` blir `11 september 2026` i HTML
och plain text. Preview och det befintliga ämnet innehåller inget datum.
I UTC krävs rå byteidentitet före/efter. Efterutdata ska också vara rått
identiska mellan värdar i UTC och Europe/Stockholm. Jämförelsehjälparen
medger exakt en förekomst av det deklarerade datumfältet per rå fil;
varje annan byteskillnad underkänns. Ingen HTML/text normaliseras generellt.

Varje fångst använder två nya rendererinstanser och sparar båda råresultaten.
För fyra separata processer, kör från worktreens rot och välj nya utdatakataloger:

```bash
TZ=UTC node docs/granskning/agent3-rendering-2-1/capture-extra-mail.cjs before /tmp/r21-extra-before-utc
TZ=Europe/Stockholm node docs/granskning/agent3-rendering-2-1/capture-extra-mail.cjs before /tmp/r21-extra-before-stockholm
TZ=UTC node docs/granskning/agent3-rendering-2-1/capture-extra-mail.cjs after /tmp/r21-extra-after-utc
TZ=Europe/Stockholm node docs/granskning/agent3-rendering-2-1/capture-extra-mail.cjs after /tmp/r21-extra-after-stockholm
```

Drivern vägrar skriva över en befintlig katalog. Varje manifest redovisar
bas-SHA, arbetskopians HEAD/status, källblobhashar, sparade källbytes,
fixturhash, råa HTML-/texthashar, PID, klockslag och faktisk miljö. Before-läget
tillåter ingen reservväg till aktuell mejlkällkod. Driverns exporterade
`readExtraMailCapture(directory)` verifierar samtliga sparade hashvärden.
`assertExtraMailComparison({ beforeUtc, beforeStockholm, afterUtc, afterStockholm })`
läser fyra fångster, kontrollerar råa bytes och returnerar jämförelsehashar
och det enda tillåtna datumfältets offset. Den kan användas direkt i r21-23.

Ingen provider, kö, DB eller Chromium anropas av denna extra mejlfångst.
Inga fångstkörningar har utförts av granskaren som skrev drivern.
