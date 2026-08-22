/**
 * Turtaket för cron-lås — ETT värde, delat av alla låsta jobb.
 *
 * 30 minuter är valt för att vara längre än det längsta låsta jobbets körtid och
 * kortare än det tätaste låsta jobbets intervall (dagligen). Se
 * `lock.service.ts` för varför TTL:n inte är en detalj: släpps låset för tidigt
 * kan nästa replik börja innan den första är klar; för sent hoppas nästa
 * schemalagda körning över.
 *
 * Konstanten bodde tidigare privat i `notifications.service.ts`. Den flyttades
 * hit när tre jobb till låstes — tre kopior av ett tidsvärde är tre chanser att
 * de glider isär, och ett cron-lås vars TTL inte längre matchar jobbets körtid
 * är ett lås som antingen släpper för tidigt eller stänger av jobbet.
 */
export const CRON_LOCK_TTL_SEC = 30 * 60
