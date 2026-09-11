**Oberoende slutgranskning av identitet och browserlivscykel, 2026-09-11.**

Granskare: `/root/rendering_determinism`. Granskad arbetskopia ovanpå
`9a3305e64ed2753e64d192e9f69b48dd20bb722d`, mot godkänd bas
`5ae9906b152307eae0d79eec719d4303a042742c`. Detta är en kodgranskning av
arbetskopian, inte ett godkännande av ännu okänd slutlig HEAD eller CI.
Granskaren har inte kört Jest, Chromium, typecheck eller PostgreSQL vid denna
slutgranskning och har inte ändrat produktionskod.

**Bedömning: inga kvarstående blockerande fynd i granskad identitets- och
browserkod.** Följande tidigare fynd har åtgärdats:

- Wrapperhashning och en ofullständig `module.children`-graf har ersatts av
  uttryckliga appfiler/kataloger samt namngivna motorpaketrötter. Paketens
  deklarerade dependencies, peers och optionalDependencies löses från sina
  faktiska föräldrapaket. Både upplösningskanter och frånvaro ingår. Två
  versioner av samma paket slås inte ihop på grund av paketnamnet.
- Dynamisk `react-dom/server` omfattas genom paketets faktiska filer. Även
  shared-konstanternas definitionsfil, Prisma-exportkedjan, brandingens
  barrel/helpers och Node-binären ingår i den granskade gränsen
  (`rendering-context.ts`, `renderingCodeManifest`).
- Initial inventering fångar fel som `null`. Senare giltiga hashsträngar kan
  inte godkännas mot denna sentinel. Inventeringsfel vid initialisering
  hindrar därmed inte legacy-bootstrap; kontrollerad rendering kräver en
  giltig initial identitet. Mail återanvänder samma initiala identitet och
  gör ingen ytterligare global inventering (`INITIAL_RENDERING_CODE`,
  `mail.renderer.ts:56`).
- Kontrollerade PDF-anrop äger en separat intern `PdfService`-browser och
  använder samma befintliga rendering/poolkod. Den ursprungliga instansen
  äger både livscykel och gemensam semaphore. Den kontrollerade miljön binds
  vid första användning, kontrolleras före browserhämtning och igen efteråt.
  En redan använd legacy-browser får inte intyga den kontrollerade miljön
  (`pdf.service.ts:298`). `onModuleDestroy` stänger båda ägda browsers.
- Mail kontrollerar aktuell och initial identitet före cacheträff. Ett
  cachelagrat resultat kan därför inte kringgå identitetskontrollen
  (`mail.renderer.ts:73`).

De sista arrayförenklingarna är sakliga: `flatMap` ersätter en separat
muterbar ackumulator och behåller undantaget för `node_modules`, samma
rekursion och samma ordning. `files.map` ersätter deklaration plus loop och
utför samma synkrona filavläsningar och hashning. Inga filer eller kontroller
har utelämnats och ingen produktionscache har utvidgats.

**Provgranskning är skild från körningsbevis.**

`r21-22` har lästs. Det använder riktiga PDF-anrop och riktiga browserobjekt,
spionerar på den verkliga gemensamma `withPage`, kräver skilda legacy- och
kontrollerade browsers, nekar fel förväntad identitet, visar att legacy kan
fortsätta med ändrad `FONTCONFIG_FILE` och kräver att båda browsers är
frånkopplade efter stängning. Detta är ett relevant beteendeprov. Det visar
inte i sig att varje tänkbart initialiseringsfel provats i en ny process.

Huvudagenten rapporterade att r21-01–06, 08–10, 12, 14 och 15 passerat och
att 07, 11, 13 och 16 kördes vid uppdraget. Dessa uppgifter är rapporterade,
inte självständigt verifierade av denna granskare. Resultat för r21-22,
övriga ännu pågående prov och slutlig CI ska hämtas ur leveransens verkliga
loggar. Ingen slutlig grön CI eller fullständig provleverans intygas här.

**Garantins exakta begränsningar.**

- Käll-/motorinstallationen måste förbli oförändrad under processens livstid
  och hela den kontrollerade browserns livstid. Kontrollerna bevisar inte
  frånvaro av tillfälliga ändringar som återställs mellan avläsningarna.
- Gränsen är medvetet konservativ. Hela namngivna filer/paket och faktiska
  installationssökvägar påverkar identiteten, även vid ändringar utan synlig
  effekt. Det finns ingen garanti att flytt mellan installationskataloger
  behåller identiteten.
- Ingen reproducerbarhet mellan oprövade OS-, motor-, font- eller
  native-konfigurationer intygas. Externa ICU-data och särskilda
  `NODE_OPTIONS` är inte separat bevisade. Linuxkontrollerna är för de
  kontrollerade PDF-anropen; mailens och PDF:ens native-beroenden ska inte
  beskrivas som identiska enbart därför att de delar kodidentitet.
- Initial inventeringsförlust självläker inte till en betrodd identitet i
  samma process. Kontrollerad rendering behöver en ny giltigt initialiserad
  process. Legacy kan fortfarande använda sin befintliga väg.
- Färsk filhashning kostar I/O och kan ge minnes-/cachepress under tunga
  prov. Testorkestrering får separera capture-processer från ts-jest, men
  dessa kostnader motiverar inte att svagare produktionskontroller införs.
- Granskningen binder inte verkliga artefakter till exekveraren och bevisar
  inte steg 2.2. Den delen är fortfarande avgränsad från detta uppdrag.

En misstanke om saknade fontconfig-verktyg i runnern avskrevs: Dockerfilen
installerar Pango, som i Debian bookworm beror direkt på `fontconfig`;
paketet innehåller både `/usr/bin/fc-list` och `/usr/bin/fc-conflist`.
[Debians paketberoende](https://packages.debian.org/bookworm/libpango-1.0-0),
[Debians filförteckning](https://packages.debian.org/bookworm/amd64/fontconfig/filelist).
Detta är paketunderlag, inte ett utfört bygge av runner-imagen.

**Oberoende radkontroll och granskat innehåll.**

`git diff 5ae9906b152307eae0d79eec719d4303a042742c --numstat` gav
469 tillagda och 81 borttagna produktionsrader, totalt **550**. CI och
produktionsskript ingår; dokumentation och identifierade testfiler räknas
separat. Följande SHA-256 anger de faktiskt lästa produktionsfilerna:

| Fil | SHA-256 |
| --- | --- |
| `apps/api/src/invoices/rendering-context.ts` | `f8d091c1d8c5d542bd490749710867382ab8f35e746778b966cad20d35c96d1e` |
| `apps/api/src/invoices/pdf.service.ts` | `ee642ac012c1e2c380dc957b71e9729bbc1aaa85361a042af33cd2ab0168998a` |
| `apps/api/src/mail/mail.renderer.ts` | `0db5ef0f39d57365634a01b358983972f7555b7903bacec1cfb90a2bc1d9cfec` |

Senare ändringar behöver bedömas mot dessa granskningsförutsättningar.
