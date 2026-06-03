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
} as const

export function entityTypeToPath(type: RelatedEntityType) {
  return ENTITY_PATH[type] ?? null
}

// Bakåtkompatibel fallback: äldre rader bär bara ett URL-likt `link`-fält.
// Första segmentet avgör vilken listsida som öppnas.
export function notificationLinkToPath(link: string) {
  const segment = link.replace(/^\/+/, '').split('/')[0]
  switch (segment) {
    case 'maintenance':
      return '/maintenance'
    case 'invoices':
      return '/invoices'
    case 'leases':
      return '/leases'
    case 'tenants':
      return '/tenants'
    case 'deposits':
      return '/deposits'
    case 'rent-increases':
      return '/rent-increases'
    case 'collections':
      return '/collections'
    default:
      return null
  }
}
