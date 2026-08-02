/**
 * R3 — EN LISTA ÖVER VILKA ROLLER SOM KAN TILLDELAS.
 *
 * Före: `INVITABLE_ROLES` = ADMIN, MANAGER medan `ASSIGNABLE_ROLES` = ADMIN,
 * MANAGER, ACCOUNTANT, VIEWER. Skillnaden var aldrig ett säkerhetsbeslut —
 * kommentaren i koden sa "för att hålla UI:t enkelt" — men den gav en
 * ekonomiansvarig en omväg i två steg: bjud in som förvaltare, låt sedan ägaren
 * byta rollen till ekonomi. Samma slutresultat, fler steg, och två listor som
 * motsade varandra utan att någon skrivit ner varför.
 *
 * Testet bevakar tre saker som annars kan glida isär igen:
 *   1. att inbjudan och rollbytet accepterar SAMMA roller,
 *   2. att OWNER inte går att tilldela via någon av vägarna,
 *   3. att valideringen faktiskt nekar — inte bara att listan ser rätt ut.
 *
 * Punkt 3 är poängen med att köra `validate()` i stället för att jämföra
 * konstanter: `@IsIn` sitter på DTO:n, och en lista som stämmer hjälper inte om
 * dekoratorn pekar på fel array.
 */

import { ForbiddenException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { ASSIGNABLE_ROLES, USER_ROLES } from '@eken/shared'
import { InviteUserDto } from './dto/invite-user.dto'
import { UpdateUserRoleDto } from './dto/update-user-role.dto'
import { UsersService } from './users.service'

async function rollFel(dto: object): Promise<boolean> {
  const fel = await validate(dto)
  return fel.some((f) => f.property === 'role')
}

function inbjudan(role: string): InviteUserDto {
  return plainToInstance(InviteUserDto, {
    email: 'ny@exempel.se',
    firstName: 'Ny',
    lastName: 'Användare',
    role,
  })
}

describe('R3 · roller som kan tilldelas', () => {
  it('ACCOUNTANT kan bjudas in direkt — omvägen i två steg behövs inte längre', async () => {
    expect(await rollFel(inbjudan('ACCOUNTANT'))).toBe(false)
  })

  it('alla tilldelningsbara roller går att bjuda in', async () => {
    const nekade: string[] = []
    for (const role of ASSIGNABLE_ROLES) {
      if (await rollFel(inbjudan(role))) nekade.push(role)
    }
    expect(nekade).toEqual([])
  })

  it('OWNER kan varken bjudas in eller tilldelas', async () => {
    // Ägaren är organisationens skapare. Rollen är skyddad på flera ställen i
    // users.service (kan inte ändras, kan inte inaktiveras) — ett ägarbyte är en
    // egen handling med egna spärrar, inte ett val i en rullgardin.
    expect(await rollFel(inbjudan('OWNER'))).toBe(true)
    expect(await rollFel(plainToInstance(UpdateUserRoleDto, { role: 'OWNER' }))).toBe(true)
  })

  it('inbjudan och rollbyte accepterar exakt samma roller', async () => {
    // Kärnan i R3. Skulle någon smalna av den ena vägen igen uppstår samma
    // odokumenterade omväg som fanns före.
    const utfall = await Promise.all(
      [...USER_ROLES, 'SUPERADMIN', ''].map(async (role) => ({
        role,
        inbjudan: !(await rollFel(inbjudan(role))),
        rollbyte: !(await rollFel(plainToInstance(UpdateUserRoleDto, { role }))),
      })),
    )
    const oense = utfall.filter((u) => u.inbjudan !== u.rollbyte)
    expect(oense).toEqual([])
  })

  it('okända rollsträngar nekas av båda vägarna', async () => {
    for (const skräp of ['SUPERADMIN', 'owner', 'admin', '', 'ADMIN ']) {
      expect(await rollFel(inbjudan(skräp))).toBe(true)
      expect(await rollFel(plainToInstance(UpdateUserRoleDto, { role: skräp }))).toBe(true)
    }
  })

  describe('tjänstelagret, inte bara DTO:n', () => {
    /**
     * DTO-valideringen är HTTP-lagrets skydd. Ett direkt tjänsteanrop passerar
     * den aldrig — en intern anropare, ett framtida AI-verktyg eller en
     * felkonfigurerad ValidationPipe når `invite()` med vad som helst.
     *
     * Samma läxa som R1: skyddet hör där varje anropare passerar. `updateRole`
     * och `deactivate` gjorde redan det; `invite` gör det nu också.
     */
    function tjänst(): UsersService {
      const Ctor = UsersService as unknown as new (...args: never[]) => UsersService
      // Prisma attrapperas så att ett UTEBLIVET nekande skulle gå vidare och
      // falla på något annat — testet kan alltså inte bli grönt av att
      // beroendena saknas.
      const prisma = {
        user: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn() },
      }
      return new Ctor(...([prisma, {}, {}, {}, {}] as never[]))
    }

    it('OWNER nekas av tjänsten även utan DTO-validering', async () => {
      // MEDDELANDET kontrolleras, inte bara typen. Tjänsten kastar
      // ForbiddenException på flera ställen — bland annat när inbjudaren inte
      // hittas — så ett test på enbart typen blir grönt även om rollkontrollen
      // tas bort. Det upptäcktes genom att sabotera spärren och se vad som föll.
      const anrop = tjänst().invite(
        { email: 'ny@exempel.se', firstName: 'Ny', lastName: 'Ägare', role: 'OWNER' as never },
        'org-1',
        'actor-1',
      )
      await expect(anrop).rejects.toBeInstanceOf(ForbiddenException)
      await expect(anrop).rejects.toThrow('Ägarrollen kan inte tilldelas via inbjudan')
    })

    it('nekandet sker FÖRE all annan behandling', async () => {
      // Ligger kontrollen för sent hinner tjänsten slå upp inbjudaren eller
      // e-postadressen först. Prisma-attrappen får avslöja det.
      const prisma = {
        user: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn() },
      }
      const Ctor = UsersService as unknown as new (...args: never[]) => UsersService
      const service = new Ctor(...([prisma, {}, {}, {}, {}] as never[]))

      await expect(
        service.invite(
          { email: 'ny@exempel.se', firstName: 'Ny', lastName: 'Ägare', role: 'OWNER' as never },
          'org-1',
          'actor-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.user.findFirst).not.toHaveBeenCalled()
      expect(prisma.user.findUnique).not.toHaveBeenCalled()
    })

    it('en tilldelningsbar roll stoppas INTE av samma kontroll', async () => {
      // Negativkontroll. Utan den hade testerna ovan kunnat bli gröna av att
      // tjänsten nekar ALLT — attrapperna får den ju att falla förr eller senare.
      //
      // Första utkastet av det här testet påstod bara "ingen ForbiddenException"
      // och blev rött: för ACCOUNTANT nekar tjänsten också, men av ett annat
      // skäl (attrappen hittar ingen inbjudare, rad 68 kastar "Otillräckliga
      // rättigheter"). Att skilja spärrarna åt kräver att man läser VILKET
      // nekande det är — annars mäter testet bara att något gick fel.
      const prisma = {
        user: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ firstName: 'A', lastName: 'B', email: 'a@b.se' }),
          findUnique: jest.fn().mockResolvedValue(null),
        },
      }
      const Ctor = UsersService as unknown as new (...args: never[]) => UsersService
      const service = new Ctor(...([prisma, {}, {}, {}, {}] as never[]))

      await expect(
        service.invite(
          { email: 'ny@exempel.se', firstName: 'Ny', lastName: 'Bokförare', role: 'ACCOUNTANT' },
          'org-1',
          'actor-1',
        ),
      ).rejects.not.toThrow('Ägarrollen kan inte tilldelas via inbjudan')
      // Flödet tog sig förbi rollkontrollen och fram till uppslagningarna.
      expect(prisma.user.findFirst).toHaveBeenCalled()
      expect(prisma.user.findUnique).toHaveBeenCalled()
    })
  })

  it('listan är en delmängd av USER_ROLES och saknar bara OWNER', () => {
    // Fångar både en påhittad roll och att någon råkar lägga till OWNER.
    const utanför = ASSIGNABLE_ROLES.filter((r) => !(USER_ROLES as readonly string[]).includes(r))
    const saknade = USER_ROLES.filter((r) => !(ASSIGNABLE_ROLES as readonly string[]).includes(r))
    expect({ utanför, saknade }).toEqual({ utanför: [], saknade: ['OWNER'] })
  })
})
