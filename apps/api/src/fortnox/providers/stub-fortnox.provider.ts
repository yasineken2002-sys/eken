import { ServiceUnavailableException } from '@nestjs/common'

import type {
  FortnoxCommand,
  FortnoxLedgerPort,
  FortnoxLookupResult,
  FortnoxSendResult,
  FortnoxTrustedContext,
} from '../fortnox.types'

/**
 * Inaktiv Fortnox-provider — modulens ENDA default i skiva 01.
 *
 * STRUKTURELLT oförmögen: båda metoderna kastar 503 innan något annat händer.
 * Den har ingen HTTP-klient, läser ingen env och kan inte nå Fortnox ens vid
 * felkonfiguration. Formen är `StubBankDataProvider` (PSD2).
 */
export class StubFortnoxProvider implements FortnoxLedgerPort {
  readonly name = 'STUB'

  private unavailable(): never {
    throw new ServiceUnavailableException('Fortnox-koppling är inte aktiverad')
  }

  async send(_ctx: FortnoxTrustedContext, _cmd: FortnoxCommand): Promise<FortnoxSendResult> {
    return this.unavailable()
  }

  async lookup(_ctx: FortnoxTrustedContext, _cmd: FortnoxCommand): Promise<FortnoxLookupResult> {
    return this.unavailable()
  }
}
