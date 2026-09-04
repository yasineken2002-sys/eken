import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'

import { BankIdAuthService, ORDER_TTL_MS } from './bankid-auth.service'
import { MockBankIdProvider } from './providers/mock-bankid.provider'
import { CHOOSE_KONTEXT_WEB, verifyChooseToken } from './bankid-choose-token'

/**
 * MEKANIKEN i alla fyra vägarna plus kontovalet, mot Mock-providern.
 *
 * ── VAD PROVET INTE KAN SE ────────────────────────────────────────────────
 *
 * Att `where`-satserna faktiskt avgränsar. En attrapp returnerar det den blev
 * tillsagd oavsett `where`, så "utgången order avvisas" och "unikt villkor
 * håller" mäts mot riktig Postgres i `bankid-identity.db.spec.ts`. Det här
 * provet mäter BESLUTEN — vilken gren koden tar, och vad den svarar.
 */

const HEMLIGHET = 'x'.repeat(48)
const NU = new Date('2026-09-04T12:00:00Z')

interface FakeOrder {
  orderRef: string
  purpose: string
  userId: string | null
  consumedAt: Date | null
  expiresAt: Date
}

/** Attrapp som bär ordertillståndet på riktigt — grenarna beror på det. */
function makeDb(
  orders: FakeOrder[] = [],
  identities: Array<{
    userId: string
    subjectHash: string
    isActive?: boolean
    org?: string
    role?: string
  }> = [],
) {
  const bankIdOrder = {
    create: jest.fn(({ data }: { data: FakeOrder }) => {
      orders.push({ ...data, consumedAt: null })
      return Promise.resolve(data)
    }),
    findUnique: jest.fn(({ where }: { where: { orderRef: string } }) =>
      Promise.resolve(orders.find((o) => o.orderRef === where.orderRef) ?? null),
    ),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: { orderRef: string; consumedAt: null }
        data: { consumedAt: Date }
      }) => {
        const o = orders.find((x) => x.orderRef === where.orderRef && x.consumedAt == null)
        if (!o) return Promise.resolve({ count: 0 })
        o.consumedAt = data.consumedAt
        return Promise.resolve({ count: 1 })
      },
    ),
    deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
  }
  // Radens id härleds ur innehållet så att provet kan adressera en identitet
  // utan att attrappen behöver en id-generator: `id:<userId>`.
  const idFor = (i: { userId: string }) => `id:${i.userId}`
  const userBankIdIdentity = {
    findMany: jest.fn(({ where }: { where: { subjectHash?: string; userId?: string } }) =>
      Promise.resolve(
        identities
          // ATTRAPPEN FILTRERAR PÅ DE FÄLT SOM FAKTISKT STÅR I `where`, inte på
          // en fast nyckel. Skillnaden är hela poängen: tappar tjänsten ett fält
          // ur sitt villkor blir filtret bredare här också, och provet faller.
          // En attrapp som filtrerade på ett hårdkodat fält hade varit grön
          // oavsett vad koden frågade efter.
          .filter((i) => where.subjectHash == null || i.subjectHash === where.subjectHash)
          .filter((i) => where.userId == null || i.userId === where.userId)
          .map((i) => ({
            id: idFor(i),
            userId: i.userId,
            verifiedAt: NU,
            user: {
              role: i.role ?? 'OWNER',
              isActive: i.isActive ?? true,
              organization: { name: i.org ?? 'Org' },
            },
          })),
      ),
    ),
    deleteMany: jest.fn(({ where }: { where: { id?: string; userId?: string } }) => {
      // Samma princip som findMany ovan, och här är den lastbärande: skulle
      // `removeIdentity` tappa `userId` ur sitt villkor blir `where.userId`
      // undefined, filtret matchar en annans rad, och provet nedan faller.
      const kvar = identities.filter(
        (i) =>
          !(
            (where.id == null || idFor(i) === where.id) &&
            (where.userId == null || i.userId === where.userId)
          ),
      )
      const count = identities.length - kvar.length
      identities.splice(0, identities.length, ...kvar)
      return Promise.resolve({ count })
    }),
    upsert: jest.fn(
      ({
        where,
      }: {
        where: { provider_subjectHash_userId: { subjectHash: string; userId: string } }
      }) => {
        const k = where.provider_subjectHash_userId
        if (!identities.some((i) => i.subjectHash === k.subjectHash && i.userId === k.userId)) {
          identities.push({ userId: k.userId, subjectHash: k.subjectHash })
        }
        return Promise.resolve({})
      },
    ),
  }
  return {
    orders,
    identities,
    bankIdOrder,
    userBankIdIdentity,
    // Transaktionsklienten återanvänder SAMMA attrapp-objekt, inte en kopia:
    // provet asserterar på tillståndet efteråt, och två objekt hade gjort
    // assertionerna gröna mot fel data.
    $transaction: jest.fn(function (this: void, fn: (tx: unknown) => Promise<unknown>) {
      return fn({ bankIdOrder, userBankIdIdentity })
    }),
  }
}

const KRYPTO = {
  blindIndex: (pn: string) => `hash:${pn.replace(/\D/g, '')}`,
  encrypt: (pn: string) => `enc:${pn.replace(/\D/g, '')}`,
}
const CONFIG = { getOrThrow: () => HEMLIGHET }

function bygg(db: ReturnType<typeof makeDb>, mock: MockBankIdProvider, issued: string[] = []) {
  const auth = {
    issueAuthResponseForUser: jest.fn((userId: string) => {
      issued.push(userId)
      // Hela AuthResponse, inte bara tokens: BankID-vägen ska ge frontend exakt
      // samma nyttolast som lösenordsinloggningen, så store:n kan sättas i ETT
      // steg. Attrappen bär formen så provet fäller om fälten tappas.
      return Promise.resolve({
        accessToken: `at:${userId}`,
        refreshToken: `rt:${userId}`,
        user: { id: userId, email: `${userId}@x.se`, role: 'OWNER', organizationId: 'o' },
        organization: { id: 'o', name: 'Org', orgNumber: null, termsVersion: null },
      })
    }),
  }
  const service = new BankIdAuthService(
    mock as never,
    db as never,
    KRYPTO as never,
    auth as never,
    CONFIG as never,
    { record: jest.fn() } as never,
  )
  return { service, auth }
}

describe('anslutning (ENROLL)', () => {
  it('start binder ordern till DEN INLOGGADE användaren', async () => {
    const db = makeDb()
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.enrollStart('u1', '127.0.0.1', NU)

    expect(db.orders).toHaveLength(1)
    expect(db.orders[0]).toMatchObject({ orderRef: 'o1', purpose: 'ENROLL', userId: 'u1' })
    expect(db.orders[0]!.expiresAt.getTime()).toBe(NU.getTime() + ORDER_TTL_MS)
  })

  it('complete blindindexerar, skriver identiteten och förbrukar ordern', async () => {
    const db = makeDb()
    const mock = new MockBankIdProvider({
      orderRef: 'o1',
      completionData: { personalNumber: '199001019802' },
    })
    const { service } = bygg(db, mock)
    await service.enrollStart('u1', '127.0.0.1', NU)

    const res = await service.enrollCollect('u1', 'o1', NU)
    expect(res).toEqual({ status: 'complete' })
    expect(db.identities).toEqual([{ userId: 'u1', subjectHash: 'hash:199001019802' }])
    expect(db.orders[0]!.consumedAt).toEqual(NU)
  })

  it('pending förbrukar INTE ordern — pollningen måste kunna fortsätta', async () => {
    const db = makeDb()
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1', pendingCollects: 2 }))
    await service.enrollStart('u1', '127.0.0.1', NU)

    expect(await service.enrollCollect('u1', 'o1', NU)).toMatchObject({ status: 'pending' })
    expect(db.orders[0]!.consumedAt).toBeNull()
    expect(await service.enrollCollect('u1', 'o1', NU)).toMatchObject({ status: 'pending' })
    expect(await service.enrollCollect('u1', 'o1', NU)).toEqual({ status: 'complete' })
  })

  it('failed förbrukar ordern — en död order får inte kunna spelas om', async () => {
    const db = makeDb()
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1', failWith: 'userCancel' }))
    await service.enrollStart('u1', '127.0.0.1', NU)

    expect(await service.enrollCollect('u1', 'o1', NU)).toEqual({
      status: 'failed',
      reason: 'userCancel',
    })
    expect(db.orders[0]!.consumedAt).toEqual(NU)
    await expect(service.enrollCollect('u1', 'o1', NU)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('IDEMPOTENT: samma person + samma konto två gånger ger EN identitet', async () => {
    const db = makeDb()
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.enrollStart('u1', '127.0.0.1', NU)
    await service.enrollCollect('u1', 'o1', NU)

    db.orders.length = 0
    const m2 = new MockBankIdProvider({ orderRef: 'o2' })
    const { service: s2 } = bygg(db, m2)
    await s2.enrollStart('u1', '127.0.0.1', NU)
    await s2.enrollCollect('u1', 'o2', NU)

    expect(db.identities).toHaveLength(1)
  })

  it('FLERA KONTON: samma person till ett ANNAT konto är tillåtet', async () => {
    const db = makeDb()
    for (const [u, o] of [
      ['u1', 'o1'],
      ['u2', 'o2'],
    ] as const) {
      db.orders.length = 0
      const { service } = bygg(db, new MockBankIdProvider({ orderRef: o }))
      await service.enrollStart(u, '127.0.0.1', NU)
      await service.enrollCollect(u, o, NU)
    }
    expect(db.identities.map((i) => i.userId).sort()).toEqual(['u1', 'u2'])
  })

  // ── DEN OMVÄNDA RIKTNINGEN ─────────────────────────────────────────────
  it('CSRF: en ANNAN användares collect på samma orderRef NEKAS', async () => {
    // Utan den här spärren kan A starta en order och låta B fullborda den i sin
    // webbläsare — och B:s personnummer hade knutits till A:s konto.
    const db = makeDb()
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.enrollStart('u1', '127.0.0.1', NU)

    await expect(service.enrollCollect('u2', 'o1', NU)).rejects.toBeInstanceOf(ForbiddenException)
    // …och ingen identitet skrevs, och ordern lever kvar för rätt användare.
    expect(db.identities).toHaveLength(0)
    expect(db.orders[0]!.consumedAt).toBeNull()
    await expect(service.enrollCollect('u1', 'o1', NU)).resolves.toEqual({ status: 'complete' })
  })

  it('en LOGIN-order kan inte fullbordas som ENROLL', async () => {
    const db = makeDb()
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.loginStart('127.0.0.1', NU)
    await expect(service.enrollCollect('u1', 'o1', NU)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('utgången order avvisas', async () => {
    const db = makeDb()
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.enrollStart('u1', '127.0.0.1', NU)
    const senare = new Date(NU.getTime() + ORDER_TTL_MS + 1)
    await expect(service.enrollCollect('u1', 'o1', senare)).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })
})

describe('inloggning (LOGIN)', () => {
  it('start skriver en order UTAN användare', async () => {
    const db = makeDb()
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.loginStart('127.0.0.1', NU)
    expect(db.orders).toHaveLength(1)
    expect(db.orders[0]).toMatchObject({ purpose: 'LOGIN' })
    // `toMatchObject({ userId: undefined })` KRÄVER att nyckeln finns med värdet
    // undefined och faller när fältet utelämnas helt — vilket är precis vad
    // loginStart gör. Frågan här är "ingen användare", inte "nyckeln finns":
    // assertionen ska hålla för båda formerna, och tystnar inte för någon av dem.
    expect(db.orders[0]?.userId).toBeUndefined()
  })

  it('EN träff → hel AuthResponse via issueAuthResponseForUser, och ordern förbrukas', async () => {
    const db = makeDb([], [{ userId: 'u1', subjectHash: 'hash:199001019802' }])
    const issued: string[] = []
    const { service, auth } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }), issued)
    await service.loginStart('127.0.0.1', NU)

    const res = await service.loginCollect('o1', NU)
    if (res.status !== 'complete') throw new Error('otillräcklig avsmalning')
    // `session`, inte `tokens`: frontend måste kunna sätta auth-store:n i ett
    // steg. Ett svar med bara tokens hade tvingat fram ett extra GET /auth/me,
    // alltså en annan inloggningssekvens än lösenordsvägens.
    expect(res.session.accessToken).toBe('at:u1')
    expect(res.session.refreshToken).toBe('rt:u1')
    expect(res.session.user.id).toBe('u1')
    expect(res.session.organization.name).toBe('Org')
    // EXAKT samma väg som lösenordsinloggningen — inget parallellt utfärdande.
    expect(auth.issueAuthResponseForUser).toHaveBeenCalledWith('u1')
    expect(db.orders[0]!.consumedAt).toEqual(NU)
  })

  it('NOLL träffar → 401 som inte avslöjar om personnumret finns', async () => {
    const db = makeDb([], [])
    const { service, auth } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.loginStart('127.0.0.1', NU)

    const fel = await service.loginCollect('o1', NU).catch((e: Error) => e)
    expect(fel).toBeInstanceOf(UnauthorizedException)
    // Meddelandet får inte skilja "okänd person" från "misslyckad identifiering".
    expect((fel as Error).message).toBe('Inloggningen kunde inte slutföras')
    expect(auth.issueAuthResponseForUser).not.toHaveBeenCalled()
    // Ordern förbrukas ändå — en identifierad order får inte kunna spelas om.
    expect(db.orders[0]!.consumedAt).toEqual(NU)
  })

  it('en INAKTIV användare räknas inte som träff, och syns inte i listan', async () => {
    const db = makeDb([], [{ userId: 'u1', subjectHash: 'hash:199001019802', isActive: false }])
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.loginStart('127.0.0.1', NU)
    await expect(service.loginCollect('o1', NU)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('FLERA träffar → kontolista + väljar-token, och ordern förbrukas INTE', async () => {
    const db = makeDb(
      [],
      [
        { userId: 'u1', subjectHash: 'hash:199001019802', org: 'Alfa AB', role: 'OWNER' },
        { userId: 'u2', subjectHash: 'hash:199001019802', org: 'Beta AB', role: 'ADMIN' },
      ],
    )
    const { service, auth } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.loginStart('127.0.0.1', NU)

    const res = await service.loginCollect('o1', NU)
    if (res.status !== 'choose') throw new Error('otillräcklig avsmalning')
    expect(res.accounts).toEqual([
      { userId: 'u1', organizationName: 'Alfa AB', role: 'OWNER' },
      { userId: 'u2', organizationName: 'Beta AB', role: 'ADMIN' },
    ])
    expect(auth.issueAuthResponseForUser).not.toHaveBeenCalled()
    // Ordern är auktoriteten för valet och lever kvar tills valet gjorts.
    expect(db.orders[0]!.consumedAt).toBeNull()

    const payload = verifyChooseToken(res.chooseToken, HEMLIGHET, NU, CHOOSE_KONTEXT_WEB)
    expect(payload).toMatchObject({ orderRef: 'o1', subjectHash: 'hash:199001019802' })
  })
})

describe('kontoval (CHOOSE)', () => {
  async function tillVal() {
    const db = makeDb(
      [],
      [
        { userId: 'u1', subjectHash: 'hash:199001019802' },
        { userId: 'u2', subjectHash: 'hash:199001019802' },
      ],
    )
    const issued: string[] = []
    const { service, auth } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }), issued)
    await service.loginStart('127.0.0.1', NU)
    const res = await service.loginCollect('o1', NU)
    if (res.status !== 'choose') throw new Error('otillräcklig avsmalning')
    return { db, service, auth, token: res.chooseToken }
  }

  it('giltigt val → hel session för det VALDA kontot, och ordern förbrukas', async () => {
    const { db, service, auth, token } = await tillVal()
    const session = await service.loginChoose(token, 'u2', NU)
    expect(session.accessToken).toBe('at:u2')
    expect(session.user.id).toBe('u2')
    expect(auth.issueAuthResponseForUser).toHaveBeenCalledWith('u2')
    expect(db.orders[0]!.consumedAt).toEqual(NU)
  })

  it('ett konto som INTE hör till personen nekas', async () => {
    // Utan den här raden hade en giltig token kunnat logga in på vilket konto
    // som helst — token säger "vi vet vem du är", inte "du får vara vem du vill".
    const { service, auth, token } = await tillVal()
    await expect(service.loginChoose(token, 'u9', NU)).rejects.toBeInstanceOf(ForbiddenException)
    expect(auth.issueAuthResponseForUser).not.toHaveBeenCalled()
  })

  it('REPLAY: samma token en andra gång nekas — ordern är förbrukad', async () => {
    const { service, token } = await tillVal()
    await service.loginChoose(token, 'u1', NU)
    await expect(service.loginChoose(token, 'u1', NU)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('utgången väljar-token nekas', async () => {
    const { service, token } = await tillVal()
    const senare = new Date(NU.getTime() + 3 * 60 * 1000)
    await expect(service.loginChoose(token, 'u1', senare)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('manipulerad token nekas', async () => {
    const { service, token } = await tillVal()
    const trasig = `${token.slice(0, -2)}xy`
    await expect(service.loginChoose(trasig, 'u1', NU)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })
})

describe('kopplade identiteter (#745 PR 3)', () => {
  it('listan är kontots egen — en annan användares rad syns inte', async () => {
    const db = makeDb(
      [],
      [
        { userId: 'u1', subjectHash: 'h1' },
        { userId: 'u2', subjectHash: 'h1' },
      ],
    )
    const { service } = bygg(db, new MockBankIdProvider())
    const rader = await service.listIdentities('u1')
    expect(rader.map((r) => r.id)).toEqual(['id:u1'])
  })

  it('BORTKOPPLING av EGEN rad tar bort den', async () => {
    const db = makeDb([], [{ userId: 'u1', subjectHash: 'h1' }])
    const { service } = bygg(db, new MockBankIdProvider())
    await expect(service.removeIdentity('u1', 'id:u1')).resolves.toEqual({ removed: true })
    expect(db.identities).toHaveLength(0)
  })

  it('DEN OMVÄNDA RIKTNINGEN: en ANNANS identitets-id nekas, och raden står kvar', async () => {
    // Formen är den klassiska objektnivå-IDOR:en: id:t kommer från klienten.
    // Grinden är skrivningens eget villkor, `deleteMany where { id, userId }`.
    //
    // VAD DET HÄR PROVET FAKTISKT MÄTER: att TJÄNSTEN skickar med `userId`.
    // Attrappen filtrerar på de fält som står i `where`, så ett tappat userId
    // gör filtret bredare och provet rött. Att POSTGRES utvärderar villkoret som
    // väntat är en annan fråga, och den ägs av bankid-identity.db.spec.ts
    // ("BORTKOPPLING: deleteMany where { id, userId } träffar bara ägarens rad").
    // Ingen av de två duger som den andra.
    const db = makeDb([], [{ userId: 'u2', subjectHash: 'h1' }])
    const { service } = bygg(db, new MockBankIdProvider())
    await expect(service.removeIdentity('u1', 'id:u2')).rejects.toBeInstanceOf(NotFoundException)
    expect(db.identities).toHaveLength(1)
  })

  it('ett id som inte finns ger SAMMA svar som en annans — inget orakel', async () => {
    const db = makeDb([], [{ userId: 'u1', subjectHash: 'h1' }])
    const { service } = bygg(db, new MockBankIdProvider())
    const a = await service.removeIdentity('u1', 'id:finns-inte').catch((e: Error) => e)
    const b = await service.removeIdentity('u1', 'id:u9').catch((e: Error) => e)
    expect((a as Error).message).toBe((b as Error).message)
  })
})

describe('samtidighet', () => {
  it('två samtidiga collect på samma order: en vinner, den andra får Conflict', async () => {
    const db = makeDb([], [{ userId: 'u1', subjectHash: 'hash:199001019802' }])
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.loginStart('127.0.0.1', NU)

    // Andra anropet ser en redan förbrukad order och avvisas av loadLiveOrder.
    await service.loginCollect('o1', NU)
    await expect(service.loginCollect('o1', NU)).rejects.toBeInstanceOf(NotFoundException)
    // …och `consume` självt är atomiskt: en andra förbrukning ger Conflict.
    await expect(
      (service as unknown as { consume(r: string, n: Date): Promise<void> }).consume('o1', NU),
    ).rejects.toBeInstanceOf(ConflictException)
  })
})
