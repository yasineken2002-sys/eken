import { randomUUID } from 'node:crypto'

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
  /**
   * Prefix för AUTOGENERERADE orderRef, när `orderRef` inte är satt.
   *
   * Finns därför att providern numera kan leva i en riktig process (dev/E2E, se
   * `bankid-provider-mode.ts`), och `BankIdOrder.orderRef` är `@unique`: ett
   * fast handtag hade gjort den ANDRA inloggningen till en P2002 i stället för
   * ett flöde. Prov som vill assertera på handtaget sätter `orderRef` och får
   * det fasta beteendet oförändrat.
   */
  orderRefPrefix?: string
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
 * ── DEN KAN INTE HAMNA I PRODUKTION ───────────────────────────────────────
 *
 * Raden ovan sa tidigare att factoryn aldrig väljer den här. Det stämmer inte
 * längre: `BANKID_PROVIDER=mock` väljer den i dev och E2E. Det som gäller — och
 * som är det verkliga skyddet — är att kombinationen `BANKID_PROVIDER=mock` +
 * `NODE_ENV=production` får appen att VÄGRA STARTA, kontrollerat både i
 * `validateEnv` och i factoryn. Se `bankid-provider-mode.ts` för varför valet är
 * bundet till körningsläget i stället för till ett värde.
 *
 * ── DÄRFÖR RÄKNAS PENDING PER ORDER ───────────────────────────────────────
 *
 * En global räknare räckte så länge varje prov hade sin egen instans. I en
 * levande process är providern en singleton, och två samtidiga flöden hade då
 * ätit av varandras sekvens — ett `complete` för fel order. Räkningen ligger
 * därför på orderRef. `calls` är fortfarande SUMMAN, vilket är vad de befintliga
 * proven mäter.
 */
export class MockBankIdProvider implements BankIdProvider {
  readonly name = 'MOCK'

  private readonly collectsByOrder = new Map<string, number>()
  private started = 0
  private readonly opts: MockBankIdOptions

  constructor(opts: MockBankIdOptions = {}) {
    this.opts = opts
  }

  /** Antal `collect` hittills, över alla ordrar — prov mäter att pollningen skedde. */
  get calls(): number {
    let sum = 0
    for (const n of this.collectsByOrder.values()) sum += n
    return sum
  }

  async start(_input: BankIdStartInput): Promise<BankIdStartResult> {
    this.started += 1
    // UUID OCH INTE EN RÄKNARE. Första försöket var `…-order-${n}`, vilket är
    // unikt inom EN process — och tabellen är inte processens. En omstartad
    // dev-server började om på 1 och krockade med rader från förra körningen:
    // P2002 på `BankIdOrder.orderRef`, alltså ett 500 på login/start. Uppmätt,
    // inte befarat — E2E föll på "Internal server error" efter en omstart.
    // Räknaren `started` finns kvar bara som en läsbar signal i loggar.
    const orderRef =
      this.opts.orderRef ?? `${this.opts.orderRefPrefix ?? 'mock'}-order-${randomUUID()}`
    this.collectsByOrder.set(orderRef, 0)
    return {
      orderRef,
      autoStartToken: 'mock-autostart-token',
      qrData: `mock-qr-data-${orderRef}`,
    }
  }

  async collect(orderRef: string): Promise<BankIdCollectResult> {
    const n = (this.collectsByOrder.get(orderRef) ?? 0) + 1
    this.collectsByOrder.set(orderRef, n)
    const pendingWanted = this.opts.pendingCollects ?? 0
    if (n <= pendingWanted) {
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
