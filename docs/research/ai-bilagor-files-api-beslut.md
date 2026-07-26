# Anthropics Files API för chattbilagor — utvärdering och beslut

**Datum:** 2026-07-26 · **Kontext:** spår B (bilagor i AI-chatten), utvärderat i B3
**Beslut: INTE nu. Egen PR när/om den bärs av ett verkligt behov.**

## Frågan

I dag skickas en bilaga som base64 i varje request den förekommer i. Ett samtal
där användaren bifogar ett kontoutdrag och sedan ställer fyra följdfrågor läser
alltså samma fil ur R2 fyra gånger, base64-kodar den fyra gånger och skickar den
fyra gånger.

Anthropics Files API låter en fil laddas upp **en** gång och därefter refereras
med `file_id` i stället för bytes:

```
POST /v1/files                       → { id: "file_..." }
{ type: "document", source: { type: "file", file_id: "file_..." } }
```

## Vad mätningen visade

**1. Det kräver att hela chatten flyttar till beta-API:t.**

`file_id`-källorna finns bara under `client.beta.messages`. I SDK 0.89:

| Typ                                              | `resources/messages` (stabil) | `resources/beta/messages` |
| ------------------------------------------------ | ----------------------------- | ------------------------- |
| `BetaFileDocumentSource` / `BetaFileImageSource` | saknas (0 träffar)            | finns                     |

Verifierat mot skarpa API:t — stabila endpointen avvisar källan rakt av:

```
messages.0.content.0.document.source: Input tag 'file' found using 'type'
does not match any of the expected tags: 'base64', 'content', 'text', 'url'
```

Beta-headern `files-api-2025-04-14` krävs, och den sätts per anrop. Att flytta
operatörschatten dit betyder att **båda** vägarna (`messages.create` och
`messages.stream`), verktygsloopen, thinking-blocken och bekräftelseflödet går
via beta-ytan. Det är inte ett fält att lägga till — det är att byta yta för
allt som redan är verifierat.

**2. Det blir ett andra lagringssystem att hålla i synk.**

I dag är sanningen: `AiAttachment`-raden ⟶ R2-objektet. Med Files API blir det
`AiAttachment` ⟶ R2 ⟶ Anthropic-fil, med tre lägen som kan drifta isär: filen
finns hos Anthropic men inte hos oss (vår retention städade), hos oss men inte
hos dem (deras livslängd tog slut), eller på båda ställena med olika innehåll.
Retentionen vi just byggde (B3) skulle behöva en motsvarighet för deras sida,
och rehydreringens graciösa degradering skulle behöva ett fjärde utfall.

**3. Det är ett integritetsbeslut, inte bara ett tekniskt.**

Bilagorna i den här chatten är hyresvärdens kontoutdrag, hyreskontrakt och
besiktningsfoton — alltså personnummer, betalningshistorik och bostadsuppgifter
om namngivna hyresgäster. I dag lämnar de aldrig vår lagring annat än som
innehåll i ett enskilt modellanrop. Files API innebär att de **lagras** hos
Anthropic tills något raderar dem. Det är en fråga för dataskyddsgenomgången
inför lansering, inte för en härdnings-PR.

## Vad vi gjorde i stället

Kostnaden Files API skulle ha adresserat är i praktiken redan begränsad:

- **Rehydreringsbudgeten** (B2, skärpt i B3) gör att en historik aldrig drar med
  sig obegränsat med bilagor — de äldsta faller till en textnotis.
- **`consumedAt`** gör att samma bilaga inte kan skickas två gånger som ny.
- **32 MB-taket** (B3) gör att ett samtal aldrig kan växa till en request som
  spränger API:t.

Kvar är den verkliga kostnaden: samma fil åker med i flera turer i ett aktivt
samtal. Den är värd att mäta innan den optimeras bort — vi vet i dag inte hur
många turer en typisk bilaga faktiskt lever.

## När det bör tas upp igen

Något av:

1. **Mätdata** visar att bilagor i praktiken följer med över många turer och att
   det kostar märkbart (`AiUsageLog` har underlaget: input-tokens per samtal med
   respektive utan bilagor).
2. **Dataskyddsgenomgången** inför lansering avgör att lagring hos Anthropic är
   acceptabel för den här datakategorin.
3. **`file_id`-källorna blir allmänt tillgängliga** på stabila Messages API, så
   att beta-flytten faller bort ur kalkylen.

Punkt 2 är den bindande. Punkt 1 avgör om det ens är värt arbetet.
