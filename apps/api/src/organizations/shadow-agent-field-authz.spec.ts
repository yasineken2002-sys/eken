// `OrganizationsService` importerar `StorageService`, som drar in AWS-SDK:n —
// en ESM-modul jest inte transformerar. Attrappen kapar den kedjan; provet rör
// aldrig lagringen.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { ForbiddenException } from '@nestjs/common'

import { OrganizationsService } from './organizations.service'

import type { UpdateOrganizationDto } from './dto/update-organization.dto'

/**
 * FÄLTNIVÅGRINDEN — ett OWNER-fält i en ADMIN-rutt.
 *
 * ── VARFÖR REGELN INTE KAN LIGGA I `@Roles` ─────────────────────────────────
 *
 * `@Roles` grindar RUTTEN. `PATCH /organizations/me` är ADMIN + OWNER, och det
 * ska den förbli — en admin ska kunna ändra bankgiro och fakturafärg. Att smalna
 * hela rutten till OWNER hade tagit det ifrån varje admin; att lämna den öppen
 * hade låtit en admin slå på en agent.
 *
 * Grinden ligger därför i TJÄNSTEN, som är den enda ingången alla anropare
 * passerar. Det här provet äger den regeln.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att controllern faktiskt SKICKAR rollen vidare. Gör den inte det faller
 * grinden stängt (rollen blir `undefined` → Forbidden), alltså åt rätt håll —
 * men utfallet vore att ingen kan slå på växeln, och det syns först i bruk.
 * `authz-surface.golden.txt` bevakar att rutten behåller sina roller.
 */
describe('shadowAgentEnabled är OWNER-only', () => {
  const bygg = () => {
    const update = jest.fn().mockResolvedValue({ id: 'o1', shadowAgentEnabled: true })
    const prisma = { organization: { update } }
    const service = Object.create(OrganizationsService.prototype) as OrganizationsService
    Object.assign(service, { prisma, storage: {} })
    return { service, update }
  }

  const dto = (over: Partial<UpdateOrganizationDto> = {}): UpdateOrganizationDto =>
    ({ ...over }) as UpdateOrganizationDto

  it('ADMIN får INTE slå på skuggagenten', async () => {
    const { service, update } = bygg()
    await expect(
      service.update('o1', dto({ shadowAgentEnabled: true }), 'ADMIN'),
    ).rejects.toBeInstanceOf(ForbiddenException)
    // Och ingenting skrevs — grinden ligger FÖRE skrivningen, inte efter.
    expect(update).not.toHaveBeenCalled()
  })

  it('ADMIN får inte heller slå AV den', async () => {
    // Att stänga av en agent låter ofarligt, men det är samma beslut i andra
    // riktningen: en admin ska inte kunna tysta ägarens mätning.
    const { service } = bygg()
    await expect(
      service.update('o1', dto({ shadowAgentEnabled: false }), 'ADMIN'),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it.each(['MANAGER', 'ACCOUNTANT', 'VIEWER'] as const)('%s får inte heller', async (roll) => {
    const { service } = bygg()
    await expect(
      service.update('o1', dto({ shadowAgentEnabled: true }), roll),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('OWNER får slå på den', async () => {
    const { service, update } = bygg()
    await expect(
      service.update('o1', dto({ shadowAgentEnabled: true }), 'OWNER'),
    ).resolves.toBeDefined()
    expect(update).toHaveBeenCalled()
    expect(update.mock.calls[0][0].data.shadowAgentEnabled).toBe(true)
  })

  it('FAIL-CLOSED: en anropare UTAN roll får inte sätta fältet', async () => {
    // Rollen är valfri i signaturen, så befintliga anropare inte behöver ändras.
    // Priset är att grinden måste falla STÄNGT när den saknas — annars hade
    // spärren berott på att varje framtida anropare kommer ihåg att skicka den.
    const { service } = bygg()
    await expect(service.update('o1', dto({ shadowAgentEnabled: true }))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('ADMIN får fortfarande ändra de ANDRA fälten — rutten är inte smalnad', async () => {
    // Motprovet. Utan det hade en grind som fäller ALLT för admin sett ut som
    // en fungerande fältgrind.
    const { service, update } = bygg()
    await expect(
      service.update('o1', dto({ bankgiro: '123-4567' }), 'ADMIN'),
    ).resolves.toBeDefined()
    expect(update).toHaveBeenCalled()
    expect(update.mock.calls[0][0].data.bankgiro).toBe('123-4567')
  })

  it('ett DTO utan fältet rör inte grinden ens för en okänd roll', async () => {
    const { service, update } = bygg()
    await expect(service.update('o1', dto({ bankgiro: '123-4567' }))).resolves.toBeDefined()
    expect(update).toHaveBeenCalled()
  })
})
