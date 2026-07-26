# AI-sidan (operatör, web) — omdesign: karta + PR-sekvens

Kartlagt 2026-07-26 mot `main` `b6f23a1`. Ingen kod ändrad vid kartläggningen.

## Bekräftad måldesign

- Kompositören är huvudpersonen: stor rundad inmatning, grön skicka-knapp.
- Välkomstläge när chatten är tom: hälsning + snabbstart-chips (förfallna avier, stäm av bank,
  skapa faktura, hyreshöjning). När man skrivit glider kompositören ner och konversationen fyller
  ytan ovanför.
- Verktyg-knapp i kompositören öppnar en grupperad meny över assistentens verkliga verktyg
  (ekonomi & avier, bankavstämning, avtal & hyresgäster, dokument & juridik). Bindande
  "gör"-verktyg får en "bekräftas"-tagg; rena läs-verktyg ingen tagg. Visa alla.
- Bild + dokument ska kunna skickas/laddas upp i kompositören (kontoutdrag, kontrakt,
  besiktningsbild).
- Låst palett (varm grön `#1a6b3c`), Poppins, riktiga linjeikoner i grönt — inte emoji.

---

## Karta över nuläget

### 1. Var sidan bor

|           |                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Route     | `/ai` → `apps/web/src/app/router.tsx:302` (`appPage('/ai', AiPage)`)                                                             |
| Sida      | `apps/web/src/features/ai/AiPage.tsx` — 912 rader, monolit (sidopanel + välkomstläge + meddelandelista + kompositör i samma fil) |
| API-lager | `apps/web/src/features/ai/api/ai.api.ts` — axios-helpers, `streamChat`, `TOOL_LABELS`/`describeTool`                             |
| Övrigt    | `hooks/useAi.ts`, `components/AnalysisModal.tsx` (274 rader)                                                                     |

**Kompositören idag** (uppmätt i browsern): 768 px bred, 60 px hög. `<textarea rows={1}` med
`maxHeight: 120px`, plus mikrofon (Web Speech API) och skicka. Ingen bilage-knapp, ingen
verktygsknapp. Sitter i en `border-t`-remsa längst ner, visuellt underordnad.

**Välkomstläget** finns redan: Sparkles + "Hej! Jag är Eveno AI" + 6 chips ur `SUGGESTIONS`
(AiPage:84–116) med Lucide-ikoner i tokenfärger — alltså redan riktiga linjeikoner, inte emoji.
Måldesignens fyra chips är en omskrivning av den listan.

**Streaming:** `GET /api/v1/ai/chat/stream?message=…` läst med `fetch` + manuell
`event:`/`data:`-parsning (inte `EventSource` — den kan inte sätta `Authorization`).
Events: `delta`, `tool`, `done`, `error`, `pendingAction`.

### 2. Verktygen — 56 st, knappt exponerade

`TOOLS` i `apps/api/src/ai/tools/ai-tools.definition.ts`: **56 unika verktyg**.
Därtill 8 separata hyresgäst-verktyg i `tenant-ai-tools.definition.ts`.

Uppdelningen som "bekräftas"-taggen behöver finns redan:

- **30 bindande** — `ACTION_TOOLS` (`ai-tools.definition.ts:1010`). Träffas ett av dem exekveras
  det inte: servern skapar en `pendingAction`, hashar inputen, och kräver `POST /v1/ai/confirm`.
- **26 rena läsverktyg** — exekveras direkt.

**Ingen meny och inget förslags-UI finns.** Enda användarvända verktygsytan är `TOOL_LABELS` i
`ai.api.ts` — 49 etiketter som bara beskriver ett _pågående_ anrop ("Hämtar översikt"), renderat
vid AiPage:816. Listan har redan glidit isär från backend:

- 10 verktyg saknar etikett → faller tillbaka på `Kör find optimization opportunities`.
  Två av dem är bindande (`prepare_contract_signing`, `send_document_to_tenant`).
- 2 döda etiketter: `get_units`, `get_leases` — verktyg som inte längre finns.

→ **Katalogen ska komma från backend.** Driften uppstod på precis det sätt en handhållen
frontend-lista gör.

### 3. KRITISKT — bild/dokument i chatten finns inte

Chatten är text-only på tre oberoende nivåer:

1. **DTO:n** — `ChatDto` = `message: string` (1–4000 tecken) + `conversationId?`. Inget bilagefält.
2. **Transporten** — SSE tar `@Query('message') message: string`. Base64 får inte plats i en URL.
3. **SDK-anropet** — `ai-assistant.service.ts:591` bygger `{ role: 'user', content: message }`,
   alltså en **sträng**, aldrig en content-block-array. `AiMessage.blocks` finns men används bara
   för tool_use-rundturer.

**Vision finns bara i separata flöden**, som dessutom kringgår SDK:n:

| flöde                   | fil                                                  | blocktyp                                                                |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Batch-kontraktsskanning | `import/contract-scanner.service.ts:110`             | `document` (PDF) / `image` — rå `fetch` mot api.anthropic.com           |
| PDF-bankparser          | `reconciliation/pdf-statement-parser.service.ts:132` | `document` (PDF)                                                        |
| Besiktningsbilder       | —                                                    | `AI_MODELS.VISION_INSPECTION` konfigurerad men **oanvänd** (död konfig) |

→ **"Skicka bild/dokument" kräver backend-arbete, inte bara UI.**

### 4. Filuppladdning idag

`StorageService` (Cloudflare R2 via S3-klient): `uploadFile(buffer, key, mimeType)`,
`getPresignedUrl(key, 3600)`, `getFileBuffer(key)`, `deleteFile(key)`.
Fastify-multipart-tak: 20 MB (`main.ts:91`).

Magic-byte-validering finns som delad modul — `common/utils/file-validation.ts`
(`detectMimeFromMagicBytes` + `validateUploadedFile`, per-typ-tak: PDF 20 MB, kontrakt 10 MB,
dokument 20 MB).

| väg                                                               | magic bytes                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| dokument, bankavstämning (×2), bankimport, kontraktsskanning (×2) | ✅                                                                                |
| hyresgästportalen                                                 | ❌                                                                                |
| besiktningar                                                      | ❌                                                                                |
| felanmälan                                                        | ❌ — validerar bara klientens egen `file.mimetype` (`maintenance.service.ts:408`) |
| org-logga                                                         | ❌                                                                                |

**Anthropic-sidans gränser:** PDF som base64 ryms i 32 MB request, max 600 sidor. Bilder som
base64 eller URL. Files API (beta `files-api-2025-04-14`) låter en fil laddas upp en gång och
refereras med `file_id` över flera turer. Chatten kör `claude-sonnet-4-5` = **lägre**
vision-upplösningsklass (1568 px); högupplöst (2576 px) kräver Sonnet 5 / Opus 4.7+.

---

## PR-sekvens

**Arkitektonisk nyckel:** låt bilagor laddas upp i ett **eget POST-anrop** som returnerar id:n,
och skicka bara id:na som query-param till den befintliga SSE-strömmen. Då behöver
strömtransporten **inte** byggas om till POST — bilagebytes rör aldrig URL:en.

### Spår A — frontend

| PR     | innehåll                                                                                                                                                                                                                                                                       | status       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **A1** | Bryt upp `AiPage.tsx` (912 rader) i `Composer`, `MessageList`, `WelcomeState`, `ConversationSidebar` (+ `MessageBubble`, `ConfirmationCard`, `LoadingDots`, `useVoiceInput`). Noll visuell ändring.                                                                            | ← pågår      |
| **A2** | Kompositören blir huvudperson: stor rundad inmatning, grön skicka-knapp, glider ner när konversationen börjar. Välkomstläget skrivs om till hälsning + 4 chips.                                                                                                                |              |
| **A3** | _(backend, litet)_ `GET /v1/ai/tools` → `{ name, label, group, binding }` härlett ur `TOOLS` + `ACTION_TOOLS`. Etiketter och grupper flyttar till backend som enda sanningskälla; `TOOL_LABELS` tas bort ur frontend. Stänger de 10 etikettluckorna och de 2 döda etiketterna. | blockerar A4 |
| **A4** | Verktygsmenyn i kompositören — grupperad, "bekräftas"-tagg, alla verktyg synliga. Konsumerar A3.                                                                                                                                                                               |              |

### Spår B — bild/dokument (backend före frontend)

| PR     | sida     | innehåll                                                                                                                                                                                                                                                    |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | backend  | `POST /v1/ai/attachments` (multipart) → `validateUploadedFile` (ny `DETECTED_CHAT_TYPES`: PDF + jpeg/png/webp) → R2 under `ai-chat/{orgId}/{uuid}` → `{ id, kind, filename, sizeBytes }`. Org-scopad, kvot per konversation. Rör inte chatten än.           |
| **B2** | backend  | Multimodal input: `ChatDto` får `attachmentIds?: string[]`, SSE får `?attachmentIds=`, och `content` byggs som **content-block-array** (`document`/`image` + `text`) i stället för sträng. Tokenkostnad, sid-/storlekstak, persistens i `AiMessage.blocks`. |
| **B3** | backend  | Hårdning: request-tak mot Anthropics 32 MB, sidräkning för PDF, beslut base64 vs Files API när samma bilaga används över flera turer.                                                                                                                       |
| **B4** | frontend | Bilage-UI i kompositören: klistra in, dra-och-släpp, filväljare, miniatyrer med filnamn/storlek, ta bort före sändning.                                                                                                                                     |

### Flaggat, utanför serien

- **Magic-byte-hålet** i portal / besiktning / felanmälan / org-logga — egen säkerhets-PR.
- **Modellvalet** `claude-sonnet-4-5` ger lägre vision-upplösning. Eget beslut, bör tas före B2 om
  kontoutdrag och kontraktsfoton ska läsas i chatten.
- **`AI_MODELS.VISION_INSPECTION`** är död konfig — koppla in eller ta bort.
