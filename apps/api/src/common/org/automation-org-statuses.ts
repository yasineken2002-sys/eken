/**
 * FORTNOX-100 G17/FS-4: de organisationsstatusar där Evenos AUTOMATISKA kundeffekter körs —
 * månadsavisering, hyres- och fakturapåminnelse, påminnelseavgift, ränta och automatisk
 * kundförlust. EN lista, så att aviseringen och kravtrappan inte kan glida isär.
 *
 * Schemats egen definition (enum OrgStatus): TRIAL är signupstandard, PAST_DUE är "varning
 * men ej blockerad". SUSPENDED och CANCELLED "blockerar alla autentiserade endpoints" —
 * hyresvärden kan då varken logga in, importera bankfiler eller registrera betalningar.
 * Att då fortsätta skicka påminnelser och ta ut avgifter av hyresgästerna vore krav som
 * ingen kan stämma av mot inbetalningar. De ingår därför inte.
 */
export const AUTOMATISKA_KUNDEFFEKTER_ORG_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE'] as const
