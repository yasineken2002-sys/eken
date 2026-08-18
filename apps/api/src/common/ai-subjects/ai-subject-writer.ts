/**
 * DEN ENDA VÄGEN ATT SKAPA `AiMessage` OCH `AiMemory` (#510).
 *
 * Rader och ämneskoppling skrivs på ETT ställe, av exakt samma skäl som
 * `resolveActorType` finns i ett exemplar (#506): en lista över anropare kan
 * glömmas, en chokepoint kan inte. Formvakten i specen bredvid sveper `src/`
 * och fäller varje `aiMessage.create` / `aiMemory.upsert` som inte går genom
 * den här filen — och den behöver därför inte veta vilka vägar som finns.
 *
 * ── DEN HÄR MODULEN RADERAR INGENTING ──────────────────────────────────────
 *
 * Den bygger BARA kopplingen. Vad som ska hända med en träffad rad vid en
 * raderingsbegäran är ett öppet beslut (#494) och besvaras inte här. Det finns
 * med flit ingen funktion i den här filen som tar bort något.
 */

import type { AiMemoryType, Prisma, PrismaClient } from '@prisma/client'
import { currentSubjectCollector } from './ai-subjects.context'

/** Minsta Prisma-yta skrivaren behöver. Gör den testbar utan hel klient. */
type Db = Pick<
  PrismaClient,
  'aiMessage' | 'aiMemory' | 'tenant' | 'aiMessageTenant' | 'aiMemoryTenant'
>

/**
 * Kandidat-UUID:n → verkliga hyresgäst-id i TURENS organisation.
 *
 * Frågan gör två saker samtidigt, och båda är nödvändiga:
 *  1. VALIDERAR — bara id:n som faktiskt är hyresgäster överlever, så
 *     fastighets- och avtals-id ur samma verktygsresultat faller bort.
 *  2. ORG-SCOPAR — `organizationId` kommer från turen, inte från datan. Ett id
 *     som på något vis läckt in från en annan organisation kan därför aldrig
 *     bli en koppling.
 *
 * EN fråga per skriven rad, och bara när det finns kandidater.
 */
async function resolveTenantSubjects(db: Db): Promise<string[]> {
  const collector = currentSubjectCollector()
  if (!collector || collector.candidates.size === 0) return []

  const rows = await db.tenant.findMany({
    where: { organizationId: collector.organizationId, id: { in: [...collector.candidates] } },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/**
 * Skapar en `AiMessage` och dess ämneskopplingar.
 *
 * Kopplingarna skrivs med `skipDuplicates`, så en tur som nämner samma
 * hyresgäst i flera verktyg ger en rad — inte fem. Att skrivningen är
 * `createMany` och inte nästlad i `create` är avsiktligt: kopplingen är
 * metadata och får aldrig kunna fälla själva meddelandet.
 */
export async function createAiMessageWithSubjects(
  db: Db,
  data: Prisma.AiMessageUncheckedCreateInput,
): Promise<{ id: string }> {
  const message = await db.aiMessage.create({ data, select: { id: true } })

  const tenantIds = await resolveTenantSubjects(db)
  if (tenantIds.length > 0) {
    // SCOPAD, men inte på ett sätt det statiska verktyget känner igen:
    // `tenantIds` kommer från `resolveTenantSubjects`, vars enda fråga är
    // `tenant.findMany({ where: { organizationId: <turens org>, id: { in: … } } })`.
    // Bara id:n som FAKTISKT är hyresgäster i turens organisation överlever den —
    // org-scopningen ligger alltså i valideringen, ett anrop bort, och heuristiken
    // ser den inte. `messageId` är raden vi själva just skapade i samma funktion.
    // Ingen av kolumnerna kan därför adressera en annan organisations data.
    // (object-scope-heuristiken rapporterar "INGEN UPPTÄCKT" för den här formen;
    // se golden-filen och #308 för samma mönster i collection-export.)
    await db.aiMessageTenant.createMany({
      data: tenantIds.map((tenantId) => ({ messageId: message.id, tenantId })),
      skipDuplicates: true,
    })
  }
  return message
}

/**
 * Upsertar en `AiMemory` och dess ämneskopplingar.
 *
 * DET HÄR ÄR DEN STORA VINSTEN. Ett minne handlar nästan alltid om EN
 * hyresgäst ("Anna vill ha avierna på papper"), till skillnad från ett
 * chattsvar som kan räkna upp fem. För `AiMemory` blir en riktad radering
 * därför faktiskt meningsfull — raden ÄR om den personen och har inget
 * bevarandeskäl.
 *
 * `upsert` och inte `create`: nyckeln är unik per (org, user, key) och samma
 * faktum extraheras om. Kopplingarna skrivs vid varje körning med
 * `skipDuplicates`, så ett minne som förnyas och då rör en ny hyresgäst får
 * kopplingen tillagd i stället för att den första låses fast.
 */
export async function upsertAiMemoryWithSubjects(
  db: Db,
  args: {
    organizationId: string
    userId: string
    key: string
    value: string
    type: AiMemoryType
  },
): Promise<{ id: string }> {
  const { organizationId, userId, key, value, type } = args
  const memory = await db.aiMemory.upsert({
    where: { organizationId_userId_key: { organizationId, userId, key } },
    create: { organizationId, userId, key, value, type },
    update: { value, type },
    select: { id: true },
  })

  const tenantIds = await resolveTenantSubjects(db)
  if (tenantIds.length > 0) {
    // SCOPAD, men inte på ett sätt det statiska verktyget känner igen:
    // `tenantIds` kommer från `resolveTenantSubjects`, vars enda fråga är
    // `tenant.findMany({ where: { organizationId: <turens org>, id: { in: … } } })`.
    // Bara id:n som FAKTISKT är hyresgäster i turens organisation överlever den —
    // org-scopningen ligger alltså i valideringen, ett anrop bort, och heuristiken
    // ser den inte. `memoryId` är raden vi själva just skapade i samma funktion.
    // Ingen av kolumnerna kan därför adressera en annan organisations data.
    // (object-scope-heuristiken rapporterar "INGEN UPPTÄCKT" för den här formen;
    // se golden-filen och #308 för samma mönster i collection-export.)
    await db.aiMemoryTenant.createMany({
      data: tenantIds.map((tenantId) => ({ memoryId: memory.id, tenantId })),
      skipDuplicates: true,
    })
  }
  return memory
}
