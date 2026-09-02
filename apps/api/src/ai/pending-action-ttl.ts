/**
 * HUR LÄNGE EN AI-AVSIKT ÄR GILTIG.
 *
 * Talet bodde tidigare i `ai-assistant.service.ts`. Det flyttades hit när
 * återupptagningsmotorn fick behov av det, av ett skäl som är värt att skriva
 * ut: motorn behövde SAMMA gräns, och alternativet var att kopiera fem minuter
 * till en andra fil. Två tal som ska vara lika men kan ändras var för sig är
 * inte en gräns, det är två gränser som råkar stämma överens just nu.
 *
 * Betydelsen är oförändrad: en bekräftelse måste ske i rimlig anslutning till
 * att AI:n föreslog åtgärden.
 */
export const PENDING_ACTION_TTL_MS = 5 * 60 * 1000
