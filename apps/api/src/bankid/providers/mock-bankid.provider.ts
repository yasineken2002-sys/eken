import type {
  BankIdCollectResult,
  BankIdCompletionData,
  BankIdProvider,
  BankIdStartInput,
  BankIdStartResult,
} from '../bankid.types'

export interface MockBankIdOptions {
  /**
   * Hur många `collect` som svarar `pending` innan utfallet levereras.
   * 0 = utfallet direkt på första anropet.
   */
  pendingCollects?: number
  /** Identiteten ett `complete` intygar. Utelämnad → en default-fixtur. */
  completionData?: Partial<BankIdCompletionData>
  /** Sätt för att låta ordern dö i stället för att fullbordas. */
  failWith?: string
  /** Fast orderRef, så prov kan assertera på handtaget. */
  orderRef?: string
}

const DEFAULT_COMPLETION: BankIdCompletionData = {
  // Testpersonnummer ur Skatteverkets officiella testdatamängd — aldrig en
  // riktig person. Kontrollsiffran stämmer, så en framtida validering inte
  // fäller fixturen och tvingar fram ett "riktigt" nummer i ett prov.
  personalNumber: '199001019802',
  givenName: 'Test',
  surname: 'Testsson',
}

/**
 * Deterministisk BankID-provider för PROV — aldrig för drift.
 *
 * ── VARFÖR EN EGEN MOCK OCH INTE JEST-ATTRAPPER PER PROV ──────────────────
 *
 * Flödet är en SEKVENS (`pending` … `pending` → `complete`), och det är
 * sekvensen som gör det svårt att prova: en attrapp som returnerar samma svar
 * varje gång kan inte skilja "vi pollade en gång" från "vi pollade tills det
 * var klart". Varje prov som byggde sin egen `mockResolvedValueOnce`-kedja hade
 * dessutom blivit sin egen tolkning av vad porten lovar.
 *
 * Mocken är därför STATEFULL med flit: den räknar sina `collect`-anrop. Den är
 * inte en attrapp för ETT prov utan en referensimplementation av porten.
 *
 * ── DEN KAN INTE HAMNA I DRIFT ────────────────────────────────────────────
 *
 * Modulens factory väljer aldrig den här — bara Stub eller (från S3) en skarp
 * adapter. Mocken instansieras uteslutande av prov, som skickar in den själva.
 */
export class MockBankIdProvider implements BankIdProvider {
  readonly name = 'MOCK'

  private collectCount = 0
  private readonly opts: MockBankIdOptions

  constructor(opts: MockBankIdOptions = {}) {
    this.opts = opts
  }

  /** Antal `collect` hittills — för prov som mäter att pollningen skedde. */
  get calls(): number {
    return this.collectCount
  }

  async start(_input: BankIdStartInput): Promise<BankIdStartResult> {
    this.collectCount = 0
    return {
      orderRef: this.opts.orderRef ?? 'mock-order-ref',
      autoStartToken: 'mock-autostart-token',
      qrData: 'mock-qr-data',
    }
  }

  async collect(_orderRef: string): Promise<BankIdCollectResult> {
    this.collectCount += 1
    const pendingWanted = this.opts.pendingCollects ?? 0
    if (this.collectCount <= pendingWanted) {
      return { status: 'pending', hintCode: 'outstandingTransaction' }
    }
    if (this.opts.failWith) {
      return { status: 'failed', reason: this.opts.failWith }
    }
    return {
      status: 'complete',
      completionData: { ...DEFAULT_COMPLETION, ...this.opts.completionData },
    }
  }
}
