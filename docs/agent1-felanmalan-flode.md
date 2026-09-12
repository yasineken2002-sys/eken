# Agent 1: felanmälans återkoppling och chattutkast

Mätt och ändrat 2026-09-10 i Codespaces, på `codex/agent1-felanmalan-flode`.
Bas: `27a720d4b6fb194fed83c760ce713c6aa70a0ad5` (main).
Arbetskopia: `/workspaces/eken-fran-mac-20260909/arbete/agent1-felanmalan`.

## Problem och ändringar

1. Både hyresgäst-AI och det manuella formuläret anropade `MaintenanceService.create`, som redan skapar notifieringen, och skapade sedan en extra notifiering. Nu äger domäntjänsten ensam skapandenotisen. Hyresgästens namn (med befintlig företags-/e-postfallback), ärendenummer och titel bevaras.
2. AI-svaret lovade att hyresvärden fått notifieringen och skulle höra av sig, även när notisen misslyckades eller inga aktiva mottagare fanns. Svaret bekräftar nu det sparade ärendenumret och hänvisar till Mina felanmälningar.
3. Bekräftelsehashen förbrukas före ärendeskrivning och chattkvitto. Efter lyckad ärendeskrivning men tappat chattkvitto kunde återförsöket råda användaren att föreslå åtgärden igen. Felanmälningsvägen hänvisar nu till befintliga ärenden innan en ny begäran. Hashmekanismen och andra verktygs felmeddelanden är oförändrade.
4. Chatten tömde utkastet innan begäran lyckades. Utkast från fält, startmeddelande och förslagsknappar bevaras nu vid fel. Ett lyckat svar får bara tömma den skickade utkastversionen. Delat `TenantChatSchema` prövas före mutation; maxlängden kommer från samma schema.

## Kod och prov

- `apps/api/src/maintenance/maintenance.service.ts`: en central notis med bibehållen identitetsinformation.
- `apps/api/src/ai/tools/tenant-tool-executor.service.ts`: ingen andra notis; verifierbar lyckad-text.
- `apps/api/src/tenant-portal/tenant-portal.service.ts`: ingen andra notis; befintlig säker `mapTicket` behålls.
- `apps/api/src/ai/tenant-ai.service.ts`: ärligt råd vid oanvändbar felanmälningsbekräftelse.
- `apps/portal/src/features/ai/TenantAiChat.tsx`: utkast, schemagrind och skydd mot täta dubbla skick.
- `apps/api/src/maintenance/tenant-maintenance-flow.spec.ts`: 18 nya prov genom verkliga tjänstekroppar.
- `apps/portal/src/features/ai/TenantAiChat.test.tsx`: 11 nya React Query-/RTL-prov.

## Resultat

| Kontroll                                     | Före ändring                     | Slutligt        |
| -------------------------------------------- | -------------------------------- | --------------- |
| Ursprungliga 9 nya API-regressionsprov       | 2 godkända, 7 underkända         | 9 godkända      |
| Kompletterad ny API-svit                     | Inte körd i sin helhet mot basen | 18/18           |
| Ny chatt-svit                                | 3 godkända, 8 underkända         | 11/11           |
| Riktade API-sviter inklusive befintliga prov | —                                | 6 sviter, 51/51 |
| Typecheck API och portal                     | —                                | Godkända        |
| ESLint berörda filer, 0 tillåtna varningar   | —                                | Godkänd         |

API-proven kör verklig `confirmAction`, verktygsexekverare, `MaintenanceService` och `NotificationsService`. Prisma, kö och audit är ersättningar. Kontroll av mottagarquery och claim-query ingår; de simulerade svaren är inte bevis för SQL-filter eller samtidighet. Chattproven använder riktig React Query/RTL och ersatt API, inklusive nätfel och simulerad 503.

Proven bevarar två medvetna manuella registreringar med identisk text. Ett identiskt bekräftelseförsök efter tappat chattkvitto kör inte verktyget igen. Notisfel hindrar inte sparat ärende i någon ingång. Företagsnamn, personnamn, e-postfallback och avsaknad av namn kontrolleras.

### Vakter

Samtliga följande gav exit 0 både före och efter ändringen:

`check-action-tool-authorization`, `check-effect-idempotency`, `check-tool-authority`, `check-tool-human-path`, `check-tool-outward-capabilities`, `check-ai-tool-effects`, `check-history-registry`, `check-tool-iteration-cap`, `check-request-contract`, `check-dto-placement`, `check-strict-koercion`.

Kör varje vakt med `node apps/api/scripts/<namn>.mjs`. Inga baslinjer eller skyddskriterier ändrades.

### Reproduktion

Kör en tung kontroll i taget. `pgrep` ska inte visa pågående Jest/tsc; vänta i så fall.

```sh
pgrep -af '[j]est|[t]sc'
NODE_OPTIONS=--max-old-space-size=2200 pnpm --filter @eken/api exec jest --runInBand --runTestsByPath src/maintenance/tenant-maintenance-flow.spec.ts src/maintenance/maintenance-enum-source.spec.ts src/maintenance/maintenance-org-isolation.spec.ts src/maintenance/maintenance-ticket-subset.spec.ts src/ai/tenant-ai-jailbreak.spec.ts src/tenant-portal/tenant-portal.leak.spec.ts

pgrep -af '[j]est|[t]sc'
pnpm --filter @eken/portal exec vitest run src/features/ai/TenantAiChat.test.tsx --maxWorkers=1 --minWorkers=1

pgrep -af '[j]est|[t]sc'
NODE_OPTIONS=--max-old-space-size=2200 pnpm --filter @eken/api typecheck

pgrep -af '[j]est|[t]sc'
pnpm --filter @eken/portal typecheck
```

I en ny arbetskopia behövs installerade beroenden, genererad Prisma-klient och byggda `@eken/shared`/`@eken/ui`. Befintlig testkonfiguration ger ts-jest-varningar för byggda JS-filer; inga sådana konfigurationsändringar ingår här.

## Granskning och gränser

Separata granskningar av flödet och plan/regler användes. Oberoende slutgranskning hittade inga blockerande fynd inom diffen. Fyndet om tappat hyresgästnamn rättades och fick prov.

Detta är inte ett bevis för Agent 1:s autonoma lösningsgrad. Inga externa modell-anrop, verkliga hyresgästuppgifter, produktionsutskick eller flaggpåslag gjordes. Ingen manuell webbläsarkontroll gjordes.

Kvar: beständigt åtgärds-ID och kopplat resultat för säker återupptagning över krascher; samma nya AI-förslag kan fortfarande skapa ett nytt ärende. Bekräftelsefel lämnar fortfarande bekräftelsekortet öppet. Utkastet överlever inte full sidomladdning. Notifiering är fortfarande asynkron och kan misslyckas. Domänhistorik, PostgreSQL-samtidighet och verklig kö-/leveranseffekt är inte verifierade av dessa prov.

Full CI bedöms på PR:ns exakta HEAD. PR är utkast för Claude att granska; ingen merge eller produktionsaktivering ingår.
