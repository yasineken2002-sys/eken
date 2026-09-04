// Mappar en notis till en app-URL.
//
// Notiser kan bära antingen en strukturerad referens (relatedEntityType) eller
// ett äldre fritext-`link`-fält. Båda översätts här till kända app-routes så
// att NotificationBell och NotificationsPage kan navigera med TanStack Router.

import type { RelatedEntityType } from '../api/notifications.api'

// Strukturerad entitetstyp → app-URL. Detaljvyn öppnas av mottagarsidan via
// useFocusStore (se MaintenancePage m.fl.).
const ENTITY_PATH = {
  MAINTENANCE_TICKET: '/maintenance',
  INVOICE: '/invoices',
  LEASE: '/leases',
  TENANT: '/tenants',
  DEPOSIT: '/deposits',
  RENT_INCREASE: '/rent-increases',
  TERMINATION_REQUEST: '/terminations',
  AI_ASSIGNMENT: '/uppdrag',
  RENT_NOTICE: '/avisering',
} as const

// Typer som har en egen DETALJRUTT, alltså där id:t hör hemma i URL:en i
// stället för i useFocusStore. Skillnaden mot focus-vägen är inte kosmetisk:
// en URL överlever omladdning, kan delas, och fungerar när notisen öppnas från
// ett mejl — focus-signalen finns bara i minnet hos den flik som klickade.
//
// Listan är avsiktligt en UPPRÄKNING och inte "alla typer": en typ får stå här
// först när `router.tsx` faktiskt registrerar `<listpath>/$id`. Står en typ här
// utan sin rutt landar notisen på catch-all-rutten, som redirectar till
// dashboarden — alltså tyst fel sida, inte ett synligt 404.
const HAS_DETAIL_ROUTE: ReadonlySet<RelatedEntityType> = new Set<RelatedEntityType>(['RENT_NOTICE'])

// `id` är valfritt: anropare som inte har något id får listsidan, precis som
// förut. Bär notisen ett id OCH typen har en detaljrutt blir svaret en djuplänk.
export function entityTypeToPath(type: RelatedEntityType, id?: string) {
  const base: string | undefined = ENTITY_PATH[type]
  if (base === undefined) return null
  if (id && HAS_DETAIL_ROUTE.has(type)) return `${base}/${id}`
  return base
}

// Bakåtkompatibel fallback: äldre rader bär bara ett URL-likt `link`-fält.
// Första segmentet avgör vilken listsida som öppnas.
const LINK_SEGMENT_PATH = {
  maintenance: '/maintenance',
  invoices: '/invoices',
  leases: '/leases',
  tenants: '/tenants',
  deposits: '/deposits',
  'rent-increases': '/rent-increases',
  uppdrag: '/uppdrag',
  collections: '/collections',
  // #648 — hyresavi. Segmentet saknades, så en notis om en avi som fastnat
  // föll på `default: null` och blev en notis utan väg vidare — samma
  // återvändsgränd som studsnotisen i #654 hamnade i.
  avisering: '/avisering',
} as const

// Segment vars ANDRA led är ett entitets-id som har en detaljrutt. Skrivaren i
// rent-reminder.service.ts skickar redan `avisering/<noticeId>`, så id:t fanns
// hela tiden i fältet — det var den här funktionen som kastade bort det.
const LINK_SEGMENT_WITH_DETAIL: ReadonlySet<string> = new Set(['avisering'])

export function notificationLinkToPath(link: string) {
  const segments = link.replace(/^\/+/, '').split('/')
  const head = segments[0]
  if (head === undefined) return null
  const base: string | undefined = LINK_SEGMENT_PATH[head as keyof typeof LINK_SEGMENT_PATH]
  if (base === undefined) return null

  // Andra ledet tas bara med när segmentet har en detaljrutt OCH ledet ser ut
  // som ett id. Formkontrollen är avsiktligt lös (inte UUID-strikt): sidan
  // faller ändå tillbaka på listan när hämtningen misslyckas, och en för snäv
  // kontroll här hade tyst tappat id:t igen den dag nyckelformen ändras.
  const tail = segments[1]
  if (tail && tail.length > 0 && LINK_SEGMENT_WITH_DETAIL.has(head)) {
    return `${base}/${tail}`
  }
  return base
}
