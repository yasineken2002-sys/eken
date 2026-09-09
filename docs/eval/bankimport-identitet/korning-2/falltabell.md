# Faktiska bankimportfall — produktkrav och observation

FAIL är en avvikelse från det frysta testkontraktet. HYPOTETISKA namespaces/cursors är inte verifierade bankavtal.
Inga matchningar eller bokföringar körs; nedströms betyder observerade anrop till ersatt matchningsgräns. Alla belopp nedan är heltalsören.

| Fall | Avsedda / sparade | Avsett / sparat öre | Import / dup / avvisat | Olösta sparade | Matchanrop / köanrop | Synkfel | Kontofält / rader | Krav |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| I01-distinct-same-fields | 2 / 1 | 20000 / 10000 | 1 / 1 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | FAIL |
| I02-exact-reimport | 1 / 1 | 10000 / 10000 | 1 / 1 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | PASS |
| I03-distinct-without-ocr | 2 / 2 | 20000 / 20000 | 2 / 0 / 0 | 2 | 2 / 2 | 0 | 0 / 2 | PASS |
| I04-organization-isolation | 2 / 2 | 20000 / 20000 | 2 / 0 / 0 | 2 | 2 / 2 | 0 | 0 / 2 | PASS |
| I05-changed-content | 1 / 1 | 10000 / 10000 | 1 / 1 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | FAIL |
| I06-pending-then-booked | 1 / 1 | 10000 / 10000 | 1 / 0 / 1 | 1 | 1 / 1 | 0 | 0 / 1 | PASS |
| I07-explicit-negative-status | 1 / 1 | 10000 / 10000 | 1 / 0 / 1 | 1 | 1 / 1 | 0 | 0 / 1 | PASS |
| I08-reference-fallback | 1 / 1 | 10000 / 10000 | 1 / 0 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | PASS |
| I09-conflicting-references | 1 / 1 | 10000 / 10000 | 1 / 0 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | PASS |
| I10-empty-ocr-with-reference | 1 / 1 | 10000 / 10000 | 1 / 0 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | PASS |
| I11-prose-is-not-intent | 1 / 1 | 10000 / 10000 | 1 / 0 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | PASS |
| I12-same-id-different-providers | 2 / 1 | 30000 / 10000 | 1 / 1 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | FAIL |
| I13-matching-error-reimport | 1 / 1 | 10000 / 10000 | 1 / 1 / 0 | 1 | 1 / 0 | 0 | 0 / 1 | PASS |
| I14-non-sek | 0 / 0 | 0 / 0 | 0 / 0 / 1 | 0 | 0 / 0 | 0 | 0 / 0 | PASS |
| F-file-api-same-event | 1 / 1 | 10000 / 10000 | 1 / 1 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | FAIL |
| F-file-api-different-events | 2 / 1 | 20000 / 10000 | 1 / 1 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | FAIL |
| F-api-file-same-event | 1 / 1 | 10000 / 10000 | 1 / 1 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | FAIL |
| F-api-file-different-events | 2 / 1 | 20000 / 10000 | 1 / 1 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | FAIL |
| S-account-cursors-AB | 4 / 2 | 100000 / 30000 | 2 / 0 / 0 | 2 | 2 / 2 | 1 | 0 / 2 | FAIL |
| S-account-cursors-BA | 4 / 2 | 100000 / 30000 | 2 / 0 / 0 | 2 | 2 / 2 | 1 | 0 / 2 | FAIL |
| S-shared-cursor-AB | 4 / 4 | 100000 / 100000 | 4 / 0 / 0 | 4 | 4 / 4 | 0 | 0 / 4 | FAIL |
| S-shared-cursor-BA | 4 / 4 | 100000 / 100000 | 4 / 0 / 0 | 4 | 4 / 4 | 0 | 0 / 4 | FAIL |
| S-account-local-id | 2 / 1 | 30000 / 10000 | 1 / 1 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | FAIL |
| S-two-accounts-equal-signals | 2 / 1 | 20000 / 10000 | 1 / 1 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | FAIL |
| S-next-page-1-rounds | 2 / 1 | 40000 / 10000 | 1 / 0 / 0 | 1 | 1 / 1 | 0 | 0 / 1 | FAIL |
| S-next-page-3-rounds | 2 / 2 | 40000 / 40000 | 2 / 0 / 0 | 2 | 2 / 2 | 0 | 0 / 2 | FAIL |
| S-empty-account-page | 2 / 1 | 30000 / 20000 | 1 / 0 / 0 | 1 | 1 / 1 | 1 | 0 / 1 | FAIL |
| S-failed-account-retry | 2 / 2 | 30000 / 30000 | 2 / 0 / 0 | 2 | 2 / 2 | 1 | 0 / 2 | FAIL |
| S-sync-organization-scope | 2 / 2 | 20000 / 20000 | 2 / 0 / 0 | 2 | 2 / 2 | 0 | 0 / 2 | FAIL |
| S-reimport-account-pages | 2 / 2 | 30000 / 30000 | 2 / 4 / 0 | 2 | 2 / 2 | 0 | 0 / 2 | FAIL |
| S-overlapping-pages | 2 / 2 | 40000 / 40000 | 2 / 1 / 0 | 2 | 2 / 2 | 0 | 0 / 2 | FAIL |
