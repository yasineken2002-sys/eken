/**
 * Kontraktsspec för bank-data-porten. Stub MÅSTE vara strukturellt oförmögen
 * (503 på varje väg); Mock MÅSTE implementera hela porten så att sync-kedjan kan
 * testas utan nycklar. Skarp adapter (P3) ska passera samma kontrakt.
 */

import { StubBankDataProvider } from './providers/stub-bank-data.provider'
import { MockBankDataProvider } from './providers/mock-bank-data.provider'

describe('StubBankDataProvider — strukturellt inert', () => {
  const stub = new StubBankDataProvider()

  it('namn = STUB', () => expect(stub.name).toBe('STUB'))

  it.each([
    [
      'beginConsent',
      () => stub.beginConsent({ organizationId: 'o', state: 's', redirectUri: 'r' }),
    ],
    ['exchangeCallback', () => stub.exchangeCallback({ code: 'c', state: 's' })],
    ['getConsentStatus', () => stub.getConsentStatus({ consentId: 'c', accessToken: 't' })],
    ['listAccounts', () => stub.listAccounts({ consentId: 'c', accessToken: 't' })],
    [
      'fetchTransactions',
      () => stub.fetchTransactions({ consentId: 'c', accessToken: 't', accountId: 'a' }),
    ],
    ['revokeConsent', () => stub.revokeConsent({ consentId: 'c', accessToken: 't' })],
  ])('%s kastar 503 (kan aldrig signera/hämta)', async (_name, call) => {
    await expect(call()).rejects.toThrow(/inte aktiverad/i)
  })
})

describe('MockBankDataProvider — kontrakt uppfyllt', () => {
  it('kör hela kedjan begin → callback → accounts → fetch → revoke', async () => {
    const mock = new MockBankDataProvider()
    mock.transactions = [
      {
        externalId: 'ext-1',
        bookingDate: new Date('2026-05-01'),
        booked: true,
        currency: 'SEK',
        amount: 8500,
        description: 'Hyra',
        ocr: '00123459',
      },
    ]

    const begin = await mock.beginConsent({
      organizationId: 'org-1',
      state: 'st',
      redirectUri: 'r',
    })
    expect(begin.authUrl).toContain('state=st')

    const tokens = await mock.exchangeCallback({ code: 'code-1', state: 'st' })
    expect(tokens.accessToken).toBeTruthy()

    const accounts = await mock.listAccounts({
      consentId: tokens.consentId,
      accessToken: tokens.accessToken,
    })
    expect(accounts.length).toBeGreaterThan(0)

    const page = await mock.fetchTransactions({
      consentId: tokens.consentId,
      accessToken: tokens.accessToken,
      accountId: accounts[0]!.accountId,
    })
    expect(page.transactions).toHaveLength(1)
    expect(page.transactions[0]!.externalId).toBe('ext-1')

    await mock.revokeConsent({ consentId: tokens.consentId, accessToken: tokens.accessToken })
    expect(mock.revoked).toContain(tokens.consentId)
  })
})
