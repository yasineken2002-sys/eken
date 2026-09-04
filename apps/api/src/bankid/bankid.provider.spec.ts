import { ServiceUnavailableException } from '@nestjs/common'

import { MockBankIdProvider } from './providers/mock-bankid.provider'
import { StubBankIdProvider } from './providers/stub-bankid.provider'

/**
 * De två providrarna i S1 — den inerta och referensimplementationen.
 *
 * VAD DE HÄR PROVEN INTE KAN SE: att flaggan faktiskt VÄLJER rätt provider. Det
 * ägs av `bankid.module.spec.ts`, som bygger factoryn. Att en Stub kastar är
 * meningslöst om ingen kodväg leder till den.
 */
describe('StubBankIdProvider — strukturellt inert', () => {
  const stub = new StubBankIdProvider()

  it('heter STUB', () => {
    expect(stub.name).toBe('STUB')
  })

  it('start kastar 503', async () => {
    await expect(stub.start({ endUserIp: '127.0.0.1' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    )
  })

  it('collect kastar 503 — inte "failed"', async () => {
    // Skillnaden är inte kosmetisk. `failed` betyder "BankID-ordern dog", vilket
    // förutsätter att en order fanns. Med Stub finns ingen, och att svara
    // `failed` hade beskrivit ett annat tillstånd än det verkliga — och sett ut
    // som ett normalt avbrott i anroparens felhantering.
    await expect(stub.collect('vad-som-helst')).rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('BÅDA vägarna kastar — det finns ingen väg till ett complete', async () => {
    const utfall = await Promise.allSettled([
      stub.start({ endUserIp: '127.0.0.1' }),
      stub.collect('x'),
    ])
    expect(utfall.every((u) => u.status === 'rejected')).toBe(true)
  })
})

describe('MockBankIdProvider — deterministisk sekvens', () => {
  it('utan pending: complete direkt, med default-identiteten', async () => {
    const mock = new MockBankIdProvider()
    const { orderRef } = await mock.start({ endUserIp: '127.0.0.1' })
    const res = await mock.collect(orderRef)

    expect(res.status).toBe('complete')
    if (res.status !== 'complete') throw new Error('otillräcklig avsmalning')
    expect(res.completionData.personalNumber).toBe('199001019802')
    expect(res.completionData.givenName).toBe('Test')
    expect(res.completionData.surname).toBe('Testsson')
  })

  it('pendingCollects=2 ger pending, pending, complete — i den ordningen', async () => {
    const mock = new MockBankIdProvider({ pendingCollects: 2 })
    const { orderRef } = await mock.start({ endUserIp: '127.0.0.1' })

    const sekvens = [
      (await mock.collect(orderRef)).status,
      (await mock.collect(orderRef)).status,
      (await mock.collect(orderRef)).status,
    ]
    expect(sekvens).toEqual(['pending', 'pending', 'complete'])
    expect(mock.calls).toBe(3)
  })

  it('valfritt personnummer — det är det matchningen ska prövas mot', async () => {
    const mock = new MockBankIdProvider({
      completionData: { personalNumber: '198001019876', givenName: 'Anna' },
    })
    const res = await mock.collect('x')
    if (res.status !== 'complete') throw new Error('otillräcklig avsmalning')
    expect(res.completionData.personalNumber).toBe('198001019876')
    expect(res.completionData.givenName).toBe('Anna')
    // Utelämnat fält ärver defaulten — proven ska slippa fylla i allt.
    expect(res.completionData.surname).toBe('Testsson')
  })

  it('failWith ger failed med maskinläsbar orsak, aldrig personuppgifter', async () => {
    const mock = new MockBankIdProvider({ pendingCollects: 1, failWith: 'userCancel' })
    expect((await mock.collect('x')).status).toBe('pending')
    const res = await mock.collect('x')
    expect(res).toEqual({ status: 'failed', reason: 'userCancel' })
  })

  it('start NOLLSTÄLLER räknaren FÖR SIN ORDER — ett omtag börjar om', async () => {
    // Provet mätte tidigare `mock.calls === 0` efter en ny start, alltså att en
    // GLOBAL räknare nollställdes. Räkningen ligger sedan mock-vägen (#745 PR 3)
    // per orderRef, och `calls` är summan över alla ordrar — den kan inte längre
    // gå bakåt. Invarianten provet faktiskt skyddar är oförändrad och prövas nu
    // direkt: samma order startad om ger om sekvensen.
    const mock = new MockBankIdProvider({ orderRef: 'fix', pendingCollects: 1 })
    await mock.start({ endUserIp: '127.0.0.1' })
    expect((await mock.collect('fix')).status).toBe('pending')
    expect((await mock.collect('fix')).status).toBe('complete')

    await mock.start({ endUserIp: '127.0.0.1' })
    expect((await mock.collect('fix')).status).toBe('pending')
  })

  it('TVÅ SAMTIDIGA ORDRAR äter inte av varandras sekvens', async () => {
    // Det här kunde inte prövas alls med en global räknare, och det är precis
    // vad som går sönder när providern slutar vara en per-prov-instans och blir
    // en singleton i en levande process: två inloggningar i två flikar hade gett
    // ett `complete` för fel order.
    const mock = new MockBankIdProvider({ pendingCollects: 1 })
    const a = await mock.start({ endUserIp: '127.0.0.1' })
    const b = await mock.start({ endUserIp: '127.0.0.1' })
    expect(a.orderRef).not.toBe(b.orderRef)

    expect((await mock.collect(a.orderRef)).status).toBe('pending')
    expect((await mock.collect(b.orderRef)).status).toBe('pending')
    expect((await mock.collect(a.orderRef)).status).toBe('complete')
    expect((await mock.collect(b.orderRef)).status).toBe('complete')
    expect(mock.calls).toBe(4)
  })

  it('start ger orderRef och båda starthandtagen', async () => {
    const mock = new MockBankIdProvider({ orderRef: 'fixt-1' })
    const res = await mock.start({ endUserIp: '127.0.0.1' })
    expect(res.orderRef).toBe('fixt-1')
    expect(res.autoStartToken).toBeTruthy()
    expect(res.qrData).toBeTruthy()
  })
})
