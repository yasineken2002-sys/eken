// Routningstypen för Eveno-webben.
//
// Den faktiska routningen bor i `app/router.tsx` (TanStack Router, URL-baserad).
// `Route` behålls här eftersom ett flertal sidkomponenter importerar typen för
// sina `onNavigate`-props. Etapp 2 av FIX 4 konverterar konsumenterna till
// <Link>/useNavigate och kan då flytta eller ta bort den här typen.

export type Route =
  | 'login'
  | 'register'
  | 'change-password'
  | 'forgot-password'
  | 'reset-password'
  | 'accept-invite'
  | 'privacy'
  | 'legal-villkor'
  | 'legal-integritet'
  | 'legal-cookies'
  | 'dashboard'
  | 'properties'
  | 'units'
  | 'tenants'
  | 'customers'
  | 'leases'
  | 'invoices'
  | 'deposits'
  | 'rent-increases'
  | 'accounting'
  | 'reconciliation'
  | 'collections'
  | 'documents'
  | 'import'
  | 'ai'
  | 'maintenance'
  | 'avisering'
  | 'inspections'
  | 'maintenance-plan'
  | 'settings'
  | 'overview'
  | 'notifications'
  | 'news'
  | 'messages'
