// @eken/ui — Evenos delade designfundament (tokens + Tailwind-preset).
// Delade React-komponenter (Modal PR5, DataTable PR6) exporteras MEDVETET INTE
// härifrån utan från subpath'en '@eken/ui/react' — huvud-entryn måste förbli
// React-fri, annars drar branding-kedjan @eken/shared → @eken/ui in React i API:t.

export * from './tokens'
export { evenoPreset, type EvenoTailwindPreset } from './tailwind-preset'
