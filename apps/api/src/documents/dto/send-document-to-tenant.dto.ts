import { IsBoolean, IsOptional, IsUUID } from 'class-validator'

/**
 * Kroppen till POST /documents/:id/send-to-tenant.
 *
 * VÄRDE-import i controllern, aldrig `import type`: NestJS läser
 * reflect-metadata i runtime och en typ-import raderar klassen, varpå
 * ValidationPipe tappar all metadata.
 *
 * `tenantId` valideras bara till FORM här. Att hyresgästen finns i anroparens
 * organisation avgörs av `deliverToTenant`, som slår upp den med
 * `{ id, organizationId }` och kastar NotFound annars — org-scopingen ska bo på
 * ETT ställe, och det stället är den delade primitiven.
 */
export class SendDocumentToTenantDto {
  @IsUUID(undefined, { message: 'Välj vilken hyresgäst dokumentet ska skickas till' })
  tenantId!: string

  /**
   * Skicka även en e-postnotis ("nytt dokument i din portal").
   *
   * UTELÄMNAD BETYDER JA, och det är ett aktivt val i controllern — inte
   * leveranstjänstens beteende. `deliverToTenant` gör `if (input.notify && …)`,
   * så ett `undefined` där betyder NEJ. AI-verktyget sätter i stället
   * `notifyTenant !== false`, alltså ja när fältet saknas.
   *
   * De två vägarna hade därmed gjort olika saker för samma utelämnade fält:
   * hyresgästen hade fått ett mejl när AI:n skickade och inget när hyresvärden
   * gjorde det. Controllern normaliserar därför till verktygets default, och
   * skillnaden står här i stället för att upptäckas av en hyresgäst som undrar
   * varför hen inte fick veta.
   */
  @IsOptional()
  @IsBoolean()
  notify?: boolean
}
