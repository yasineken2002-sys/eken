# Bekräftelsetext — avgränsad rättning av #867 b

Fast bas: 561b382b6cbddfccba719613a5ea3aa2f0f7e695 (#883).
Egen gren: codex/agent3-bekraftelsetext. Äldre grenar förblir frysta.

Facit, skrivet före produktionsändringen:

- En registrerad SSE-bekräftelse får exakt den samlade modelltexten före pending_action.
- En misslyckad pending-registrering lämnar ingen sådan text eller bekräftelse.
- Texten syns bredvid bekräftelsekortet även efter omhämtning av user-historik.
- Texten följer samma pågående åtgärd genom dubbelbekräftelse, men inte ett nytt samtal.
- Avbryt/bekräfta använder oförändrade verktygsindata och serverns bekräftelsevillkor.
- Delade nätverksläsningar, även mitt i JSON eller svensk UTF-8, får inte tappa texten.
- Textlösa förslag fungerar fortsatt. Inget skrivverktyg körs när förslaget visas.

UI-texten är tillfällig och ger ingen ny historik- eller återladdningsgaranti.
POST-vägens tidigare tomma pending-reply ändras inte här.
Global SSE-buffring, förbrukningsgrindens aktiveringsgräns och statuskontrakt
är separata kvarstående fynd. Denna rättning aktiverar inget Agent 3-flöde.

Inga betalda modellanrop, produktionsanrop, migrationer eller mergar ingår.
