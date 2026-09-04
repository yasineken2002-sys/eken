import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Separat config för Vitest, samma uppdelning som apps/portal: vite.config.ts
// äger dev/build, den här filen äger proven. Aliasen speglar vite.config.ts så
// att `@/...` och `@eken/shared` fungerar likadant i prov som i appen.
//
// TVÅ MEDVETNA SKILLNADER MOT PORTALS CONFIG, båda för att de inte behövs ännu:
//
//   environment: 'node'   Portal kör jsdom därför att dess prov renderar en
//                         React-komponent. Webs första prov är RENA FUNKTIONER
//                         (#719) — de rör varken DOM eller webbläsar-API:er.
//                         Behöver ett framtida prov en DOM är rätt åtgärd att
//                         sätta `environment: 'jsdom'` här och lägga till
//                         jsdom som devDependency, inte att göra det i förväg:
//                         en jsdom-miljö döljer att `document` saknas i node
//                         och kan därför göra ett prov grönt av fel skäl.
//   inget react-plugin    Ingen JSX transformeras; inget prov renderar.
//
// `include` är samma form som portals, så en spec hittas på samma villkor i
// båda paketen. E2E ligger i apps/web/e2e och matchas INTE — den sviten körs
// av Playwright i sitt eget CI-jobb, med en egen kanariefågel på antalet.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@eken/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
