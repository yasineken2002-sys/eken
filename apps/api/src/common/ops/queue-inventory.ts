/**
 * KÖINVENTERINGEN — härledd ur könamnens egna hem, inte avskriven.
 *
 * ── VARFÖR FILEN INTE INNEHÅLLER EN ENDA STRÄNGLITTERAL ─────────────────────
 *
 * Avskärmningsordningen namnger `psd2-sync`, `mail:high`, `mail:normal` och
 * `mail:low` som "kända relevanta köer" och säger uttryckligen att den fulla
 * mängden ska HÄRLEDAS. Fyra av elva är inte mängden, och en handskriven lista
 * av de övriga sju hade haft exakt den egenskap en driftpaus inte får ha: den
 * ser komplett ut.
 *
 * Varje namn nedan importeras därför från den konstant appens egen kod använder
 * när kön registreras. Byter ett könamn följer verktyget med; läggs en tolfte kö
 * till syns den INTE här automatiskt — och just den riktningen bärs av
 * `apps/api/scripts/check-automation-pause.mjs`, som härleder mängden
 * `BullModule.registerQueue`-namn UR KODEN och fäller om den och den här filen
 * går isär. Två uppräkningar som ska vara lika är inte en uppräkning; guarden är
 * det som gör dem till en.
 *
 * ── VAD "RELEVANT" BETYDER HÄR ──────────────────────────────────────────────
 *
 * Alla elva, utan urval. Frestelsen är att plocka ut "de som rör bank" — men
 * `pdf`-kön renderar och skickar avier, `lease-activation` skapar initiala avier
 * och välkomstmejl, och `mail:*` bär allt utskick. En kö som inte rör
 * bankavstämningen kan alltså ändå skapa en fordran, ett mejl eller en
 * bokföringspost under ett underhållsfönster. Urvalet görs av operatören vid
 * åtgärdstillfället, inte av den här filen.
 */

import { CONTRACT_SCAN_BATCH_QUEUE } from '../../import/contract-scan-batch.queue'
import { LEASE_ACTIVATION_QUEUE } from '../../leases/lease-activation.queue'
import { QUEUE_AI_AGENT_EXECUTION } from '../../ai/execution/execution.types'
import { QUEUE_AI_EXECUTION_DRYRUN } from '../../ai/execution-dryrun/dryrun.types'
import { QUEUE_AI_PAYMENT_SHADOW } from '../../ai/shadow/payment/payment-shadow.types'
import { QUEUE_AI_SHADOW } from '../../ai/shadow/shadow.types'
import { QUEUE_HIGH, QUEUE_LOW, QUEUE_NORMAL } from '../../mail/mail.types'
import { QUEUE_PDF } from '../../pdf-jobs/pdf.types'
import { PSD2_SYNC_QUEUE } from '../../psd2/psd2-sync.queue'

/**
 * Varje Bull-kö appen registrerar. Sorterad för att utskriften ska vara
 * jämförbar mellan körningar — ordningen bär ingen prioritet.
 */
export const ALLA_KONAMN: readonly string[] = [
  CONTRACT_SCAN_BATCH_QUEUE,
  LEASE_ACTIVATION_QUEUE,
  PSD2_SYNC_QUEUE,
  QUEUE_AI_AGENT_EXECUTION,
  QUEUE_AI_EXECUTION_DRYRUN,
  QUEUE_AI_PAYMENT_SHADOW,
  QUEUE_AI_SHADOW,
  QUEUE_HIGH,
  QUEUE_LOW,
  QUEUE_NORMAL,
  QUEUE_PDF,
].sort()
