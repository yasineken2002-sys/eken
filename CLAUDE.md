# Eken – Claude-instruktioner

## Projektöversikt

**Eken** är ett "Fortnox för fastigheter" – ett enterprise-grade fastighetssystem byggt i ett pnpm-monorepo med Turborepo.

- `apps/api` – NestJS (Fastify) backend
- `apps/web` – React 18 + Vite frontend
- `packages/shared` – Delade TypeScript-typer, Zod-scheman, utils

---

## Designsystem – ALLTID följ detta

Varje sida, komponent och modal som skapas **måste** följa designsystemet nedan utan undantag. Fråga alltid dig själv: **"Hade Fortnox godkänt detta?"** – om svaret är något annat än ja, fortsätt koda tills svaret är ja.

### Färgpalett

```
Bakgrund (app):   #F7F8FA
Yta (kort/panel): #FFFFFF
Border:           #EAEDF0
Border (input):   #DDDFE4

Text primär:      #111827
Text sekundär:    #6B7280
Text tertiär:     #9CA3AF

Primary:          #2563EB  (blue-600)
Primary hover:    #1D4ED8  (blue-700)

Success:          emerald-600 / bg emerald-50
Warning:          amber-600  / bg amber-50
Danger:           red-600    / bg red-50
Info:             blue-600   / bg blue-50
```

### Typografi (Inter var)

```
Sidtitel (PageHeader):    text-[22px] font-semibold tracking-tight
Sektionsrubrik:           text-[14px] font-semibold
Kortinnehåll primärt:     text-[13.5px] font-medium
Brödtext:                 text-[13px]
Etikett / caption:        text-[12px]
Mikro / badge-text:       text-[11px]
KPI-värde:                text-[26px] font-semibold tracking-tight
```

### Komponenter – regler

**Kort (cards)**

```
bg-white rounded-2xl border border-[#EAEDF0]
hover: shadow-sm transition-shadow
whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
padding: p-4 (kompakt) eller p-5 (standard)
```

**Tabeller**

```
Wrapper: overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white
Rubrik: text-[12px] font-semibold text-gray-400 uppercase tracking-wide
Rad-hover: hover:bg-gray-50/80
Border mellan rader: border-b border-[#EAEDF0] last:border-0
```

**Knappar**

```
Primary:   bg-blue-600 text-white rounded-lg h-9 px-4 text-[13.5px] shadow-sm
Secondary: bg-white border border-[#DDDFE4] text-gray-700 rounded-lg h-9 px-4
Small:     h-8 px-3 text-[13px]
active:    active:scale-[0.97] (CSS transform, inte framer-motion på knappar)
```

**Input / Select**

```
h-9 rounded-lg border border-[#DDDFE4]
focus: ring-2 ring-blue-500 border-blue-500
text-[13.5px]
Label: text-[13px] font-medium text-gray-700
```

**Modals**

```
Backdrop: bg-black/25 backdrop-blur-[2px]
Panel: bg-white rounded-2xl shadow-xl border border-[#EAEDF0]
Animation: scale 0.96→1 + y 8→0, spring stiffness 400 damping 30
Rubrik: text-[17px] font-semibold
Stäng-knapp: h-7 w-7 rounded-lg top-right
Footer: border-t border-[#EAEDF0] pt-5 mt-5 flex justify-end gap-2
```

**Badges**

```
Alla: rounded-full px-2.5 py-0.5 text-[12px] font-medium
Dot-variant: h-1.5 w-1.5 rounded-full inline före text
Success:  bg-emerald-50  text-emerald-700
Warning:  bg-amber-50    text-amber-700
Danger:   bg-red-50      text-red-600
Info:     bg-blue-50     text-blue-700
Default:  bg-gray-100    text-gray-700
Ghost:    border border-gray-200 text-gray-500
```

**Filterflikar (tabs)**

```
Wrapper: bg-gray-100 rounded-xl p-1 w-fit flex gap-1
Aktiv:   bg-white shadow-sm text-gray-900 rounded-lg h-8 px-3
Inaktiv: text-gray-500 hover:text-gray-700 rounded-lg h-8 px-3
Text:    text-[13px] font-medium
```

**Sidans struktur**

```
PageWrapper: px-6 py-6 max-w-[1200px] mx-auto
PageHeader: title + optional description + optional action (knapp top-right)
Avstånd under PageHeader till innehåll: mt-6
Avstånd mellan sektioner: mt-6 eller space-y-5/space-y-4
```

### Animationer – Framer Motion

**Alltid använd på:**

- PageWrapper: `initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}`
- Listor/grids: stagger container + items
- Modals: spring scale + y
- Sidebar: spring width

**Stagger-mönster (alltid):**

```tsx
const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}
// Wrapper: <motion.div variants={container} initial="hidden" animate="show">
// Barn:    <motion.div variants={item}>
```

**Kortanimation:**

```tsx
whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
```

**Sidövergångar:** Varje sida wrappas i `<PageWrapper id="page-name">` som hanterar enter/exit.

**Timing:**

- Snabba övergångar: 0.15–0.2s duration
- Spring (modals, sidebar): stiffness 300–400, damping 28–32
- Stagger delay per barn: 0.04–0.07s

### Sidlayout-mönster

Varje feature-sida ska ha:

1. `<PageWrapper id="...">` som root
2. `<PageHeader title="..." description="..." action={<Button>}>`
3. Statistikkort om relevant (2–4 kolumner, mt-6)
4. Filter/tabbar om relevant (mt-6)
5. Datatabell eller kortgrid (mt-4 eller mt-6)
6. `<Modal>` för skapa/redigera/detalj

### Tomma tillstånd

```tsx
<EmptyState
  icon={RelevantIcon}
  title="Inget att visa"
  description="Förklaring + uppmaning"
  action={<Button variant="primary">Skapa första X</Button>}
/>
```

### Ikonbibliotek

Använd **Lucide React** konsekvent:

- strokeWidth: `1.8` standard, `2.2` på aktiva nav-items
- Storlek i sidebar-nav: `16px`
- Storlek i tabeller/kort: `12–14px`
- Storlek i tomma tillstånd: `24px`

### Domän-specifika badges (återanvänd alltid)

```tsx
<UnitStatusBadge status={unit.status} />
<InvoiceStatusBadge status={invoice.status} />
<LeaseStatusBadge status={lease.status} />
<PropertyTypeBadge type={property.type} />
```

---

## Kod-konventioner

### Komponenter

- Funktionella komponenter, aldrig klasser
- Props-interface definieras direkt ovanför komponenten
- `cn()` från `@/lib/cn` för alla className-sammanfogningar
- Aldrig inline-stilar utom i Framer Motion `whileHover`/`whileTap`

### Svenska i UI

- Alla labels, rubriker, felmeddelanden och knappar på **svenska**
- Felmeddelanden: specifika och hjälpsamma ("Personnummer måste ha formatet YYYYMMDD-XXXX")
- Valutor: `formatCurrency()` från `@eken/shared` (returnerar SEK-format)
- Datum: `formatDate()` från `@eken/shared` (sv-SE locale)

### Import-ordning

```ts
1. React-imports
2. Tredjepartsbibliotek (framer-motion, lucide-react)
3. Interna UI-komponenter (@/components/ui/*)
4. Interna layout-komponenter (@/components/layout/*)
5. Feature-specifika komponenter
6. Data / hooks (@/lib/*, @/hooks/*, @/stores/*)
7. Typer (import type ...)
```

### TypeScript

- `strict: true` + `exactOptionalPropertyTypes: true` – respektera detta
- Använd `type` imports för typer: `import type { X } from '...'`
- Undvik `any` – använd `unknown` och type guards istället
- Optionella fält: använd `Omit<T, 'field'> & { field?: Type }` för partiella mock-objekt

---

## Kvalitetskrav

Innan du anser en sida klar, kontrollera:

- [ ] PageWrapper med korrekt id och animationer
- [ ] PageHeader med titel, beskrivning och primär action-knapp
- [ ] Alla kort använder `rounded-2xl border border-[#EAEDF0]`
- [ ] Stagger-animation på listor och grids
- [ ] Modal för att skapa nytt + modal för detalj/redigera
- [ ] Tommt tillstånd om listan är tom
- [ ] Alla belopp via `formatCurrency()`, alla datum via `formatDate()`
- [ ] Svenska labels och felmeddelanden
- [ ] TypeScript utan fel (`pnpm typecheck`)
- [ ] Inga `console.log` (använd `console.warn`/`console.error`)
- [ ] Mobil-responsiv layout (grid med `grid-cols-1 sm:grid-cols-2 lg:grid-cols-X`)
