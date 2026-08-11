# Runbook: en skrivning som inte lästs tillbaka är ett obelagt påstående

Gäller **allt du skriver ut ur repot** — PR-texter, ärendekroppar, kommentarer,
filer, konfiguration — och den gäller **rapporteringen om arbetet**, inte bara
arbetet självt.

Regeln i en mening: _skrivningen är inte klar när kommandot returnerat, den är klar
när du läst tillbaka resultatet från det ställe det ska ligga på._

## Varför den här filen finns

`gh pr edit 407 --body-file body.md` kördes med arbetskatalogen i en
scratchpad-katalog utanför repot. `gh` kräver ett git-repo som cwd och dog med
`fatal: not a git repository`. Utdatan pipades genom `2>&1 | tail -1`, som åt upp
felraden, och `&&`-kedjan såg ut att ha gått igenom.

PR-texten var oförändrad på GitHub. Det upptäcktes två turer senare, av en slump, när
kroppen råkade läsas för en annan anledning. Under tiden var det som rapporterats till
användaren fel — inte för att arbetet var fel, utan för att **rapporten om arbetet var
overifierad**.

Det är samma felklass som en grön testsvit som aldrig kört: ingenting ser trasigt ut,
och tystnaden är oskiljbar från framgång. Jämför
[bevisrigg-riktig-postgres.md](./bevisrigg-riktig-postgres.md), avsnittet om
negativkontroll — en grind som aldrig setts falla är ingen grind.

## Regeln

**1. Läs tillbaka från destinationen, inte från källan.**

```bash
# fel: bekräftar bara att den lokala filen finns
gh pr edit 407 --body-file body.md && echo "klart"

# rätt: läser tillbaka det som faktiskt ligger på GitHub
gh pr edit 407 --body-file "$PWD/body.md"
gh pr view 407 --json body -q .body > check.md
grep -q "den fras som skulle tillkomma" check.md && echo "verifierat" || echo "SKREVS ALDRIG"
```

Samma sak för filer: läs tillbaka innehållet, eller mät en hash, i stället för att
lita på att skrivkommandot inte klagade.

**2. Pipa aldrig bort felutmatning från en skrivning.**

`cmd | tail -N` gör att `$?` blir **tails** exitkod, inte `cmd`:s. Ett misslyckat
kommando blir tyst framgång. Samma sak för `| head`, `| grep`, `2>/dev/null` och
`|| true`. Vill du korta ned utdata: skriv den till fil och läs filen, eller sätt
`set -o pipefail`.

**3. `gh` kräver git-repo som cwd.**

Kör `gh` från repo-roten och peka på body-filen med absolut sökväg. `cd` till en
temp-katalog först dödar kommandot.

**4. Verifiera med något som skulle kunna falla.**

En kontroll som alltid är sann bevisar ingenting. Grep:a efter en fras som **bara**
finns i den nya versionen, inte efter något som fanns i båda — en grep som hade
matchat även före skrivningen är en tautologi och passerar tyst.

**5. En misslyckad verifiering kan bero på verktyget lika gärna som på innehållet —
och skillnaden måste mätas.**

Ett rött utfall är inte automatiskt ett fynd. Det säger bara att _kontrollen_ inte
gick igenom, och orsaken kan lika gärna ligga i hur du frågade.

Två fall ur samma arbetspass:

_Radbrytning som såg ut som saknat innehåll._ Fem fraser kontrollerades i en
PR-kropp; fyra gav träff, den femte — `commit statuses` — rapporterades saknad.
Frasen fanns, men GitHub hade radbrutit mitt i den, och `grep` arbetar radvis. Mätt
med `tr '\n' ' '` först fanns den. Hade utfallet tagits för sant vore slutsatsen
"texten skrevs ofullständigt" — fel, och den felaktiga slutsatsen hade lett till en
onödig omskrivning.

_Uppslagning som såg ut som en filskillnad._ En träd-jämförelse mot en mergad gren
gav `FILEN SKILJER SIG`. Grenen var redan raderad lokalt, så `git rev-parse` kunde
inte slå upp den och kastade `ambiguous argument` — vilket `diff` tolkade som en
skillnad. Med rätt sha (`gh pr view --json headRefOid`) var träden identiska.

Innan ett rött utfall rapporteras som ett fynd: kontrollera att kontrollen kunde ha
gett grönt. Slog uppslagningen upp något? Matchar mönstret formen på det du söker
(radvis vs helt dokument, skiftläge, radbrytningar, backticks)? Skrev kommandot till
stderr i stället för stdout?

För markdown som hämtas tillbaka från GitHub räcker det inte att platta radbrytningar
— indenterade fortsättningsrader i listor lämnar kvar sitt indrag, så ett mellanslag i
sökfrasen möter tre i texten. **Normalisera blanksteg också:**

```bash
gh pr view N --json body -q .body | tr '\n' ' ' | tr -s ' ' | grep -F 'din fras'
```

Det fallet inträffade i #410, ett steg efter att punkt 5 skrivits: en fras
rapporterades saknad, hittades inte ens med `tr '\n' ' '`, och fanns hela tiden.

**6. Välj korta, obrytbara tokens som verifieringsnycklar — inte satser.**

Punkt 5 är läkemedlet. Det här är förebyggandet: väljer du rätt nyckel uppstår
problemet inte.

Två gånger i rad rapporterade verifieringen "saknas" om text som fanns, båda gångerna
för att sökfrasen var en **mening**. En mening kan radbrytas, indragas, ombrytas av en
editor, renderas om av GitHub eller få sina blanksteg normaliserade. En sha kan inte
det.

Verifiera därför på det minsta som är unikt för skrivningen:

| bra nyckel                         | varför                                                  |
| ---------------------------------- | ------------------------------------------------------- |
| `8ee3280`, `f9e2ec68`              | sha-prefix — kan inte brytas eller ombrytas             |
| `verifiera-att-skrivningen-tog.md` | filnamn — ett token, inga blanksteg                     |
| `#410`                             | ärendenummer                                            |
| `420 chunkar = 420 rader`          | uppmätt tal — kort, distinkt, och bär själva påståendet |
| `--fail-with-body`                 | flaggnamn                                               |

Undvik: `"en skrivning som inte lästs tillbaka är ett obelagt påstående"`. Den är
läsbar för en människa och skör för en `grep`.

Ett tal duger som nyckel bara om det är **distinkt** — `0` eller `200` matchar för
mycket. `420 chunkar = 420 rader` är bra just för att kombinationen bara kan komma
från den rad du vill bevisa. Jämför punkt 4: nyckeln ska inte kunna matcha före
skrivningen heller.

En nyckel som börjar med `-` eller `--` äts av argumentparsern innan den blir ett
sökmönster. `grep -F "--fail-with-body"` gav
`invalid option --fail-with-body` och rapporterades som "saknas" — frasen fanns.
**Avsluta flaggparsningen med `--`:**

```bash
grep -qF -- "--fail-with-body" fil    # -- säger: allt härefter är argument, inte flaggor
```

Det hände när punkt 6 verifierades på sig själv, med `--fail-with-body` hämtad ur
punktens egen tabell över bra nycklar. Den är bra i brytbarhetsmening och usel som
skalargument — två olika egenskaper hos samma sträng.

Detta gäller också loggar. Paritetsraden i prod verifieras med `420 chunkar = 420
rader`, inte med hela meningen `Lagtext/vektor-paritet OK: …` — och loggen skrivs
till fil först, eftersom `railway logs | grep` gav tomt medan `railway logs > fil`
följt av `grep fil` gav träff. Ännu en variant av punkt 2.

## Checklista

- [ ] Skrivningen kördes med cwd där verktyget kräver det
- [ ] Felutmatningen pipades inte bort
- [ ] Resultatet lästes tillbaka **från destinationen**
- [ ] Kontrollen letade efter något som bara kan finnas efter skrivningen
- [ ] Verifieringsnyckeln är ett kort, obrytbart token — inte en mening
- [ ] Ett rött utfall verifierades vara innehållets fel, inte verktygets
- [ ] Rapporten till användaren säger bara det som lästs tillbaka

## Relaterade fällor med samma form

`until`-loopar som väntar på GitHub-checkar snurrar för evigt om villkoret bara
täcker check runs:

```bash
# snurrar för evigt: Vercel-raderna är commit statuses och har .status == null
until [ "$(gh pr view N --json statusCheckRollup \
  -q '[.statusCheckRollup[] | select(.status != "COMPLETED")] | length')" = 0 ]; do sleep 20; done
```

Check runs bär `.status`/`.conclusion`; commit statuses bär `.state`. Läs hellre av
läget en gång och tolka båda fälten än att loopa på ett av dem.
