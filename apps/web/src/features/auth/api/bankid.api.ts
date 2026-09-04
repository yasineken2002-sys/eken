import { del, get, post } from '@/lib/api'
import type { AuthResponse } from '@/stores/auth.store'

/**
 * BankID-anropen. Tunt lager: ingen logik, bara formen på det som skickas.
 *
 * ── VARFÖR FUNKTIONERNA TAR EXAKT ETT ARGUMENT ────────────────────────────
 *
 * `loginCollect(orderRef)` och `enrollCollect(orderRef)` tar en STRÄNG, inte ett
 * objekt. Det är avsiktligt och det är en säkerhetsegenskap, inte stil: det finns
 * ingen plats i signaturen där ett `userId` kan smyga in. Servern avgör vem
 * ordern tillhör — vid ENROLL genom att ordern bär det userId den startades av,
 * vid LOGIN genom blindindexet — och en klient som fick skicka med ett userId
 * hade sett ut som om den bestämde det.
 *
 * Spärren i sig ligger i API:t (#745 PR 2, `enrollCollect` kastar 403 när den
 * inloggade inte är ordern ägare). Formen här ser till att klienten aldrig ens
 * försöker, och `bankid-request.spec.ts` mäter den skickade kroppen.
 */

export interface BankIdStart {
  orderRef: string
  /** Startar BankID-appen på samma enhet. Saknas hos vissa brokers. */
  autoStartToken?: string
  /** Innehållet i QR-koden för identifiering på annan enhet. */
  qrData?: string
}

export interface BankIdAccount {
  userId: string
  organizationName: string
  role: string
}

export type BankIdLoginCollect =
  | { status: 'pending'; hintCode?: string }
  | { status: 'failed'; reason: string }
  /** Hela sessionen — tokens PLUS user och organization, som lösenordsinloggningen. */
  | { status: 'complete'; session: AuthResponse }
  | { status: 'choose'; chooseToken: string; accounts: BankIdAccount[] }

export type BankIdEnrollCollect =
  | { status: 'pending'; hintCode?: string }
  | { status: 'failed'; reason: string }
  | { status: 'complete' }

export interface BankIdIdentity {
  id: string
  verifiedAt: string
}

// ── Inloggning ──────────────────────────────────────────────────────────────

export async function bankIdLoginStart(): Promise<BankIdStart> {
  return post<BankIdStart>('/auth/bankid/login/start', {})
}

export async function bankIdLoginCollect(orderRef: string): Promise<BankIdLoginCollect> {
  return post<BankIdLoginCollect>('/auth/bankid/login/collect', { orderRef })
}

export async function bankIdLoginChoose(
  chooseToken: string,
  userId: string,
): Promise<AuthResponse> {
  // Här — och bara här — skickar klienten ett userId, och det är hela
  // endpointens uppgift: användaren VÄLJER vilket av sina egna konton hen vill
  // in på. Servern kontrollerar ändå att kontot hör till den identifierade
  // personen; valet är inte ett påstående om vem man är.
  return post<AuthResponse>('/auth/bankid/login/choose', { chooseToken, userId })
}

// ── Anslutning ──────────────────────────────────────────────────────────────

export async function bankIdEnrollStart(): Promise<BankIdStart> {
  return post<BankIdStart>('/auth/bankid/enroll/start', {})
}

export async function bankIdEnrollCollect(orderRef: string): Promise<BankIdEnrollCollect> {
  return post<BankIdEnrollCollect>('/auth/bankid/enroll/collect', { orderRef })
}

export async function bankIdIdentities(): Promise<BankIdIdentity[]> {
  return get<BankIdIdentity[]>('/auth/bankid/identities')
}

export async function bankIdRemoveIdentity(id: string): Promise<void> {
  await del(`/auth/bankid/identity/${id}`)
}
