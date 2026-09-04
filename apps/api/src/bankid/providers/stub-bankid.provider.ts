import { ServiceUnavailableException } from '@nestjs/common'
import type {
  BankIdCollectResult,
  BankIdProvider,
  BankIdStartInput,
  BankIdStartResult,
} from '../bankid.types'

/**
 * Inaktiv BankID-provider — används när `BANKID_ENABLED` != 'true' (default).
 *
 * STRUKTURELLT oförmögen att autentisera någon: BÅDA metoderna kastar 503, och
 * det finns ingen kodväg härifrån som kan returnera ett `complete`. Det är
 * skillnaden mot en flagg-check spridd i tjänstelagret — den kan glömmas på ett
 * ställe; den här providern kan inte lyckas ens vid felkonfiguration.
 *
 * Att `collect` också kastar (och inte returnerar `failed`) är avsiktligt:
 * `failed` betyder "BankID-ordern dog", vilket förutsätter att en order fanns.
 * Med Stub finns ingen order, och att svara `failed` hade beskrivit ett annat
 * tillstånd än det verkliga.
 */
export class StubBankIdProvider implements BankIdProvider {
  readonly name = 'STUB'

  private unavailable(): never {
    throw new ServiceUnavailableException('BankID-inloggning är inte aktiverad')
  }

  async start(_input: BankIdStartInput): Promise<BankIdStartResult> {
    return this.unavailable()
  }

  async collect(_orderRef: string): Promise<BankIdCollectResult> {
    return this.unavailable()
  }
}
