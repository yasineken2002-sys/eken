import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Separat config för Vitest, samma uppdelning som apps/portal: vite.config.ts
// äger dev/build, den här filen äger proven. Aliasen speglar vite.config.ts så
// att `@/...` och `@eken/shared` fungerar likadant i prov som i appen.
//
// TVÅ MEDVETNA SKILLNADER MOT PORTALS CONFIG, båda för att de inte behövs ännu:
//
//   environment: 'jsdom'  Stod på 'node' till 2026-09-05 med motiveringen att
//                         webs prov var RENA FUNKTIONER (#719) och att en
//                         jsdom-miljö i förväg hade dolt att `document` saknas.
//                         Villkoret i den noten — "behöver ett framtida prov en
//                         DOM är rätt åtgärd att sätta jsdom HÄR och lägga till
//                         beroendet" — är nu uppfyllt: inkorgen (etapp 6)
//                         renderar en React-komponent och prövar att KPI-korten
//                         läser summary, att flikarna filtrerar och att Godkänn
//                         utan bekräftelse inte anropar något.
//   react-plugin          Krävs för att JSX ska transformeras i proven. Samma
//                         plugin och samma version som appens vite.config.ts,
//                         så ett prov och en körning ser samma kod.
//
// `include` är samma form som portals, så en spec hittas på samma villkor i
// båda paketen. E2E ligger i apps/web/e2e och matchas INTE — den sviten körs
// av Playwright i sitt eget CI-jobb, med en egen kanariefågel på antalet.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@eken/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
