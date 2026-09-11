# Steg 2.2 — komplettering fryst före implementation

Bas: `0d048101f291cf352a730100ec96d6b042ed98a4`. Ny gren:
`codex/agent3-rendering-2-2-real`. Taket är 450 produktionsrader **mot denna bas**;
räknare och klassificering ändras inte. Äldre stopprapport avser föregående order.

Alla r22-01–14 i `kontrakt-och-facit.md` behålls. Följande preciseringar och ett
kompletterande id fryses nu, innan adapterimplementation:

- r22-03 ska angripa både faktura och avi: JSON-tal i stället för SQL-sträng,
  NaN/Infinity, otillåtet kalenderdatum och ogiltig månad. Ingen dispatch/beslut.
- r22-04 omfattar också MIME och fullständigt fryst resursinnehåll. Identiska
  kommandon ska återläsas innan dagens resurser/snapshot/renderare används.
- r22-05 ska visa att en separat anslutning kan committa domänändringen under
  rendering; kontrollen får inte bara simulera en gammal fingerprint.
- r22-09 reproducerar två sparade beslut (faktura och avi) i två nya Node- och
  Chromium-processer. Jämförelsen är med den redan förseglade providerbodyn.
- r22-11 byter en verklig resursfil A→B atomiskt, kräver avvisad reproduktion,
  beständigt konfliktspår utan anropsrätt, och fortsatt blockering efter B→A.
- r22-14 prövar även byteändring efter rendering men före bindning; inga
  halvskrivna beslut, medlemmar eller dispatch får återstå.

| Id | Förutsättning / angrepp | Förväntat observerbart utfall |
| --- | --- | --- |
| r22-15 | Verkligt renderad body accepteras av syntetisk transport men svaret tappas; exekveraren startas om, aktuell DB och resurser ändras | Ett tillåtet omanrop använder exakt sparad body och samma attemptId utan rendering/resursläsning, ger originalets mejl-ID och bara en syntetisk acceptans. För tidigt/sent omanrop förblir blockerat. Reproduktion ger aldrig anropsrätt. |

Motiv: ordern skiljer uttryckligen reproduktion från transportomanrop. Eget id
hindrar att reproduktionsbevis förväxlas med ett faktiskt test av retryvägen.
CI ska kräva dessa 15 id tillsammans med basens oförändrade 70 id.

Återanvändning verifierad på basen: `delivery-decisions.ts:26–33` resources/team,
`:177–200` full JSONB-jämförelse; `delivery-execution.ts:77–119` atomisk bindning;
`20260911150000_delivery_execution/migration.sql:56–68` SQL-spärr i samma
transaktion. Ingen ny tabell/migration för att duplicera detta skydd.

2a-provfilens SHA-256 före implementation:
`764fee9c3753dd8ea4bd9d288ed2b8a88b7c3ec29c33c324a256e85da9fa7f62`.
Den ska förbli oförändrad. Äldre kommandon får inga retroaktiva kontextkrav.

Identitetsgränsen omfattar 2.1:s deklarerade motor/kod/typsnitt/miljö plus
adapter/mappning. Oföränderlig installation krävs under hela framställningen.
Fryst klocka, avsändare och logotyp inklusive MIME lagras i fullständiga kommandot.
Historiskt skäl till att kopplingen saknades: INGEN DOKUMENTERAD ORSAK.
