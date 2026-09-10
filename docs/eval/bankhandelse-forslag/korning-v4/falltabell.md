# Separata SQL-komponentprov — inte #874:s 31 originalfall

Provider, Prisma, faktiska import-/matchmetoder och köer körs inte. Markörer är syntetiska anropsobservatörer; de är inte ekonomisk färdighantering.

| Fall | Observationer | Nya betalningsrader / öre | Äldre rader / öre | Replay / held / avvisat | Testanrop / öre | Öppen identitet |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 01-two-equal-events | 2 | 2 / 20000 | 0 / 0 | 0 / 0 / 0 | 2 / 20000 | False |
| 02-exact-reimport | 2 | 1 / 10000 | 0 / 0 | 1 / 0 / 0 | 1 / 10000 | False |
| 03-concurrent-reimport | 2 | 1 / 10000 | 0 / 0 | 1 / 0 / 0 | 1 / 10000 | False |
| 04-concurrent-distinct | 2 | 2 / 20000 | 0 / 0 | 0 / 0 / 0 | 2 / 20000 | False |
| 05-account-local-id | 2 | 2 / 30000 | 0 / 0 | 0 / 0 / 0 | 2 / 30000 | False |
| 06-organization-isolation | 2 | 2 / 20000 | 0 / 0 | 0 / 0 / 0 | 2 / 20000 | False |
| 07-verified-provider-bridge | 2 | 1 / 10000 | 0 / 0 | 1 / 0 / 0 | 1 / 10000 | False |
| 08-unbound-new-consent | 2 | 1 / 10000 | 0 / 0 | 0 / 1 / 0 | 1 / 10000 | True |
| 09-client-asserted-proof | 1 | 0 / 0 | 0 / 0 | 0 / 1 / 0 | 0 / 0 | True |
| 10-unproven-api-file | 2 | 1 / 10000 | 0 / 0 | 0 / 1 / 0 | 1 / 10000 | True |
| 11-proven-same-api-file | 2 | 1 / 10000 | 0 / 0 | 1 / 0 / 0 | 1 / 10000 | False |
| 12-proven-distinct-api-file | 2 | 2 / 20000 | 0 / 0 | 0 / 0 / 0 | 2 / 20000 | False |
| 10-unproven-file-api | 2 | 1 / 10000 | 0 / 0 | 0 / 1 / 0 | 1 / 10000 | True |
| 11-proven-same-file-api | 2 | 1 / 10000 | 0 / 0 | 1 / 0 / 0 | 1 / 10000 | False |
| 12-proven-distinct-file-api | 2 | 2 / 20000 | 0 / 0 | 0 / 0 / 0 | 2 / 20000 | False |
| 13-no-source-proof | 1 | 0 / 0 | 0 / 0 | 0 / 1 / 0 | 0 / 0 | True |
| 14-legacy-unproven | 1 | 0 / 0 | 1 / 10000 | 0 / 1 / 0 | 0 / 0 | True |
| 15-legacy-verified-link | 2 | 0 / 0 | 1 / 10000 | 0 / 2 / 0 | 0 / 0 | True |
| 16-verified-transition | 1 | 1 / 10000 | 1 / 10000 | 0 / 0 / 0 | 1 / 10000 | False |
| 17-before-transition | 1 | 0 / 0 | 1 / 10000 | 0 / 1 / 0 | 0 / 0 | True |
| 18-changed-content | 2 | 1 / 10000 | 0 / 0 | 0 / 1 / 0 | 1 / 10000 | True |
| 19-conflict-before-claim | 2 | 1 / 10000 | 0 / 0 | 0 / 1 / 0 | 0 / 0 | True |
| 20-status-conflict | 3 | 1 / 10000 | 0 / 0 | 0 / 2 / 0 | 1 / 10000 | True |
| 21-rollback-save | 1 | 1 / 10000 | 0 / 0 | 0 / 0 / 0 | 1 / 10000 | False |
| 22-crash-before-claim | 2 | 1 / 10000 | 0 / 0 | 1 / 0 / 0 | 1 / 10000 | False |
| 23-crash-before-effect | 2 | 1 / 10000 | 0 / 0 | 1 / 0 / 0 | 0 / 0 | True |
| 24-crash-after-effect | 2 | 1 / 10000 | 0 / 0 | 1 / 0 / 0 | 1 / 10000 | True |
| 25-wrong-claim-org | 1 | 1 / 10000 | 0 / 0 | 0 / 0 / 0 | 0 / 0 | True |
| 26-wrong-finish-token | 1 | 1 / 10000 | 0 / 0 | 0 / 0 / 0 | 1 / 10000 | False |
| 27-old-ocr-amount-passthrough | 2 | 2 / 10000 | 0 / 0 | 0 / 0 / 0 | 2 / 10000 | False |
| 28-noneligible-recorded | 3 | 0 / 0 | 0 / 0 | 0 / 0 / 3 | 0 / 0 | False |
