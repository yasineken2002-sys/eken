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

# rätt: läser tillbaka det som faktiskt ligger på GitHub, och jämför mot facit
gh pr edit 407 --body-file "$PWD/body.md"
gh pr view 407 --json body -q .body > hamtad.md
diff <(printf '%s\n' "$(cat body.md)") <(printf '%s\n' "$(cat hamtad.md)") \
  && echo "verifierat" || echo "SKREVS ALDRIG / SKILJER SIG"
```

Samma sak för filer: läs tillbaka innehållet, eller mät en hash, i stället för att
lita på att skrivkommandot inte klagade. Jämför hela texten när du kan — se punkt 5
för varför fragmentsökning är sämre.

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

**5. Sök inte efter fragment. Jämför hela texten.**

Har du själv skrivit PR-kroppen, ärendet eller filen, så **finns den avsedda texten
redan**. Jämför den mot den hämtade i sin helhet, i stället för att leta efter delar
av den:

```bash
gh pr edit N --body-file "$PWD/body.md"
gh pr view N --json body -q .body > hamtad.md

# $(...) strippar avslutande nyrader, printf lägger tillbaka exakt en.
# GitHub lägger till en tom rad i slutet av varje kropp — utan den här
# normaliseringen larmar jämförelsen varje gång, och regeln överges vid
# första falsklarmet. Uppmätt på #412: enda diffen var "59a60 > ".
diff <(printf '%s\n' "$(cat body.md)") <(printf '%s\n' "$(cat hamtad.md)") \
  && echo "identisk" || echo "SKILJER SIG — se diffen ovan"
```

Normaliseringen är smal med avsikt: den rör bara avslutande nyrader. En ändrad rad
mitt i texten fäller fortfarande (mätt).

En jämförelse kan inte falla på radbrytning, indrag eller argumentparsning, för
**ingen sökfras används**. Den svarar dessutom på en bättre fråga: inte "finns den här
biten?" utan "är det jag skrev det som ligger där?".

Tre gånger i samma session gav fragmentsökning "saknas" om text som fanns — tre olika
orsaker, samma utfall, och alla tre hade uteblivit med en jämförelse:

| orsak                | vad som hände                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Radbrytning**      | `commit statuses` bröts mitt itu av GitHub; `grep` arbetar radvis                                                                                    |
| **Indrag**           | listpunktens fortsättningsrad behöll sitt indrag, så ett mellanslag i sökfrasen mötte tre i texten — `tr '\n' ' '` räckte inte, `tr -s ' '` behövdes |
| **Argumentparsning** | `--fail-with-body` åts som en flagga: `grep: invalid option`. Krävde `grep -qF --`                                                                   |

Alla tre gav **falskt negativt** — kontrollen sa "saknas" om något som fanns. Det är
den ofarliga riktningen: den kostar tid och kan leda till en onödig omskrivning, men
den kan inte få dig att rapportera en skrivning som gjord när den inte är det. Den
farliga riktningen är falskt positivt, och den täcks av punkt 4: nyckeln får inte
kunna matcha före skrivningen.

**Asymmetrin är avsiktlig.** En verifiering ska hellre larma i onödan än tiga när det
är fel, eftersom ett falskt negativt upptäcks direkt av den som tittar på utfallet,
medan ett falskt positivt aldrig upptäcks alls — det ser ut som framgång, och det var
precis så den här filen kom till. Välj därför den strängare kontrollen när du väljer,
och betala priset i enstaka falsklarm.

**6. En misslyckad verifiering kan bero på verktyget lika gärna som på innehållet —
och skillnaden måste mätas.**

Punkt 5 gäller när du har ett facit. Punkterna 6 och 7 gäller när du **inte** har det
— när texten är något du hämtar och inte själv skrivit, och det enda tillgängliga är
sökning. Då behövs både normaliseringen nedan och de obrytbara nycklarna i punkt 7.

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

_Arbetskatalogen som såg ut som en saknad fil._ `cat railway.toml` gav tomt och
`find . -maxdepth 2 -name "railway*"` gav noll träffar. Slutsatsen blev att filen inte
fanns i repot — trots att `health.controller.ts` och `CLAUDE.md` båda hänvisar till
den. Det var på väg att bli **ett ärende om obelagda påståenden i produktionskod,
byggt på ett obelagt påstående**. Kommandona kördes från `apps/api`, inte från
repo-roten. Filen fanns, var spårad i git, och innehöll exakt det kommentaren påstod.

Det fallet är värt att dröja vid, för det visar hur regeln missas. Punkt 6 hade
tillämpats fyra gånger samma dag — på grep-mönster, radbrytningar, indrag och
flaggparsning — men inte på arbetskatalogen, trots att `find` som ger noll träffar är
exakt samma sorts röda utfall. **Arbetskatalogen är ett verktygsvillkor, i samma
klass som grep-mönstret och argumentparsningen.** Ett `cat`, `find`, `ls` eller
`grep` som ger tomt svarar på frågan "finns det _här_", inte "finns det".

Det som fångade felet var att någon bad om belägg för _var_ påståendet stod. Att leta
upp raderna tvingade fram en sökning från rätt katalog, och då dök filen upp.

Innan ett rött utfall rapporteras som ett fynd: kontrollera att kontrollen kunde ha
gett grönt. **Var stod du?** (`pwd` — särskilt efter en `cd` några kommandon tidigare,
eller när ett `cd` misslyckats med "No such file or directory" för att du redan var
där.) Slog uppslagningen upp något? Matchar mönstret formen på det du söker (radvis vs
helt dokument, skiftläge, radbrytningar, backticks)? Skrev kommandot till stderr i
stället för stdout?

För sökningar i ett repo: ange absoluta sökvägar, eller sök från repo-roten
(`git rev-parse --show-toplevel`). `git ls-files <mönster>` är dessutom oberoende av
cwd på ett sätt `find .` inte är.

För markdown som hämtas tillbaka från GitHub räcker det inte att platta radbrytningar
— indenterade fortsättningsrader i listor lämnar kvar sitt indrag, så ett mellanslag i
sökfrasen möter tre i texten. **Normalisera blanksteg också:**

```bash
gh pr view N --json body -q .body | tr '\n' ' ' | tr -s ' ' | grep -F 'din fras'
```

Det fallet inträffade i #410, ett steg efter att punkt 6 skrivits: en fras
rapporterades saknad, hittades inte ens med `tr '\n' ' '`, och fanns hela tiden.

**7. Välj korta, obrytbara tokens som verifieringsnycklar — inte satser.**

Punkt 6 är läkemedlet. Det här är förebyggandet: måste du söka, så väljer du rätt
nyckel och problemet uppstår inte.

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

Det hände när punkt 7 verifierades på sig själv, med `--fail-with-body` hämtad ur
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
- [ ] Fanns ett facit? Då jämfördes hela texten i stället för att söka fragment
- [ ] Om sökning ändå: nyckeln är ett kort, obrytbart token — inte en mening
- [ ] Ett rött utfall verifierades vara innehållets fel, inte verktygets
- [ ] För sökningar i repot: rätt arbetskatalog, eller absolut sökväg
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
