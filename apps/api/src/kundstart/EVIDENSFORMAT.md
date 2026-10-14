# Kundavstämning vid kundstart: indataformat (KUNDSTART-205, R165-3)

Formatet är **neutralt och versionsbestämt** och används för att jämföra ett importerat
öppningspaket med en **oberoende** export ur det tidigare systemets kundreskontra.

- Det är **ingen** Visma- eller Fortnox-adapter, och inget här påstår att en sådan export
  finns i det formatet. Vilken verklig produkt, vilket företag och vilken ansvarig person
  som ska leverera exporten väljs vid en riktig kundstart.
- Exemplen nedan är **syntetiska**.

## Det som bevisas och det som inte bevisas

|                                     | Vad det betyder                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Råhash**                          | Servern hashar exakt de bytes som lämnats (`sourceRawSha256`, `mappingRawSha256`). En hash bevisar att det är **samma fil**. Den bevisar inte att exporten är sann, auktoritativ eller fullständig. |
| **Omfattning**                      | `scopeDeclaration` är en **deklaration** från den som lämnar underlaget, inte ett tekniskt bevis på fullständighet.                                                                                 |
| **Mottagningsbevis för deposition** | Ett **deklarerat referensvärde** (text), inte verifierade bytes. Ett saknat värde stoppar jämförelsen.                                                                                              |
| **Ingen rekonstruktion**            | Källan får inte byggas upp från Evenos egen import. Den ska komma ur det tidigare systemet.                                                                                                         |
| **Inga URL:er**                     | Inga URL- eller referensfält accepteras. Bevis är lagrade bytes inom organisationen.                                                                                                                |

## Gränser

- Varje fil skickas som text och får vara högst 900 000 tecken.
- Källa och mappning får **tillsammans** vara högst 960 000 UTF-8-bytes. Då ryms hela anropet under API:ts gräns på 1 048 576 bytes. Servern prövar gränsen själv, inte bara formuläret.
- Varje fil får innehålla högst 1000 dokument respektive 1000 mappningsrader.
- Teckenkodningen ska vara UTF-8, och separatorn är `;`. En UTF-8-BOM får bara stå först i filen. Rubriken ska vara exakt den angivna. Fel, dubbla eller extra rubriker, fel antal celler och oavslutade citattecken stoppar jämförelsen.

## Deklarationer i uppladdningen

Följande uppgifter anges i uppladdningen och binds i underlagets kontrollsumma. De är **deklarationer** och ingen garanti för att exporten är sann eller fullständig.

| Fält                  | Prövning                                                                          |
| --------------------- | --------------------------------------------------------------------------------- |
| `sourceSystemProduct` | Det tidigare systemets namn (fritt).                                              |
| `sourceCompanyKey`    | Ska stå i varje rad i **både** källan och mappningen. Annars stoppas jämförelsen. |
| `sourceOrgNumber`     | Källföretagets organisationsnummer. Ska vara lika med organisationens.            |
| `sourceAsOfDate`      | Avstämningsdag. Ska vara dagen före organisationens aktuella brytdatum.           |
| `sourceExportedAt`    | När exporten togs ut (ISO-tid med tidszon).                                       |
| `scopeDeclaration`    | Vad exporten omfattar.                                                            |
| `scopeResponsible`    | Vem som ansvarar för att exporten är fullständig.                                 |

## Importens betalt och krediterat (A2)

Öppningspaketets import (12 kolumner, se `opening-csv.ts`) kan ha två **valfria** kolumner till efter `mottagetDatum`: `betaltBelopp` och `krediteratBelopp`, i kronor med samma beloppsregel som övriga belopp.

- En äldre fil med 12 kolumner godtas som förut. Kedjefälten blir då **NULL**, alltså att uppgiften saknas, och aldrig 0.
- För en fordran med satta fält gäller `ursprungligtBelopp − betaltBelopp − krediteratBelopp = oppetBelopp`.
- En ny kundavstämning **stoppar** för varje importerad fordran där betalt eller krediterat saknas, med beskedet "Importen saknar betalt/krediterat för dokumentet".
- För depositioner ska kolumnerna vara tomma.
- Verkställda paket rörs inte. Deras rader står kvar med NULL.

## EVENO-RESKONTRA-1 (källan)

Rubriken ska vara exakt denna rad:

```
kallforetag;kund;avtal;dokument;typ;period;forfallodag;ursprungOre;betaltOre;krediteratOre;oppetOre;mottagetDatum;mottagningsbevis
```

| Fält                                                    | Regel                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kallforetag`                                           | Det tidigare systemets företagsnyckel. Den ska vara densamma som `sourceCompanyKey` i begäran.                                                                                                                |
| `kund`, `avtal`                                         | Gamla nycklar. De översätts **bara** via mappningsfilen.                                                                                                                                                      |
| `dokument`, `typ`                                       | Dokumentnyckeln är `kallforetag` + `dokument` + `typ`. `typ` är `RECEIVABLE` eller `DEPOSIT`.                                                                                                                 |
| `period`                                                | `ÅÅÅÅ-MM`. Krävs för RECEIVABLE och ska vara tom för DEPOSIT.                                                                                                                                                 |
| `forfallodag`                                           | `ÅÅÅÅ-MM-DD`. Krävs för RECEIVABLE.                                                                                                                                                                           |
| `ursprungOre`, `betaltOre`, `krediteratOre`, `oppetOre` | Heltal i **öre**. Ett **tomt** fält betyder SAKNAS och stoppar jämförelsen. Det är aldrig 0. Värdet `0` är ett giltigt uttryckligt värde. För RECEIVABLE gäller `ursprung − betalt − krediterat = öppet ≥ 0`. |
| `mottagetDatum`, `mottagningsbevis`                     | Krävs för DEPOSIT. Mottagningsbeviset är ett deklarerat referensvärde.                                                                                                                                        |

Depositioner jämförs **separat** och nettas aldrig mot hyresfordringar. Tillgodohavanden, negativa saldon, förskott och redan fakturerade framtida perioder stoppas, precis som i den befintliga kundstarten.

## EVENO-MAPPNING-1 (gammal identitet → ny)

```
kallforetag;kund;avtal;tenantId;leaseId;metod
```

- Varje gammalt par (kund, avtal) får en rad. En dubblett eller en tvetydig rad stoppar jämförelsen.
- `tenantId` och `leaseId` ska finnas i **samma organisation**, och avtalet ska tillhöra hyresgästen. Annars stoppas jämförelsen, och felet visar inget id från någon annan organisation.
- `metod` beskriver underlaget för kopplingen, till exempel `kontrakt + personnummer kontrollerat`.
- Ingen tyst matchning görs på namn, belopp eller totalsumma.

## Syntetiskt exempel (191-fallet)

Källa:

```
kallforetag;kund;avtal;dokument;typ;period;forfallodag;ursprungOre;betaltOre;krediteratOre;oppetOre;mottagetDatum;mottagningsbevis
GAMMALT-AB;A;K-1;DOC-1;RECEIVABLE;2026-10;2026-10-31;600000;0;0;600000;;
GAMMALT-AB;B;K-2;DOC-2;RECEIVABLE;2026-10;2026-10-31;400000;0;0;400000;;
```

Mappning:

```
kallforetag;kund;avtal;tenantId;leaseId;metod
GAMMALT-AB;A;K-1;<tenant A>;<avtal K-1>;syntetiskt prov
GAMMALT-AB;B;K-2;<tenant B>;<avtal K-2>;syntetiskt prov
```

Utfall:

- **E5b, fel fördelning:** källan har ursprung 1 000 000, betalt 250 000, krediterat 150 000 och öppet 600 000 öre. Importen har samma ursprung och öppet men betalt 150 000 och krediterat 250 000. Det ger en dokumentavvikelse, trots att både ursprung och öppet stämmer.

- En import där DOC-1 ligger på B och DOC-2 på A ger **2 dokumentavvikelser**: A −200 000 öre och B +200 000 öre. Det gäller trots att totalsumman blir 0, och godkännande stoppas.
- En korrekt import ger 0 avvikelser.

## Bindning

Evidensen är oföränderlig, och varje ändring ger en ny version.

**Servern binder evidensen till:**

- organisationen och organisationsnumret;
- brytdatumet;
- paketets version och sha256;
- källans och mappningens bytes;
- de lösta tenant- och lease-kopplingarna (`bindingSha256`);
- jämförelsens resultat.

**Godkännandet kräver:**

- en granskning av exakt den versionen, gjord av en inloggad ekonomigranskare (ACCOUNTANT, läst ur databasen);
- en annan användare som OWNER, också läst ur databasen.

Både godkännande och verkställning prövar bindningen på nytt under organisations- och paketlås.
