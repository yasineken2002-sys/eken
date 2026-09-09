# Slutverifiering efter separata granskningar

31 frysta fall: 11 uppfyller sina produktkrav, 20 har avvikelse. Alla 31 fallmått är identiska före/efter granskningskorrigeringarna.
5/5 Node-kontroller; 18/18 negativa omräkningsprov; Python/CJS-syntax och diffkontroll godkända. Äldre bevisformat nekas utan uttryckligt arkivläge (separat kontrollerat).
Befintliga OCR-proveniens- och testkopplingsvakter passerade med sina självtest. Detta är statiska regressionskontroller; Jest/tsc/full appsvit kördes inte.
90 hashkontrollerade filer, inklusive 67 historiska underlag och 9 produktkällor. Ursprungliga 2 000 återspelades inte.
Separat SQL-NULL-kontroll: {"nullIds": 2, "nullKeys": 2, "ore": 300, "rows": 2}. Ingår inte i bankfallens mått.
Faktiskt körd harness: ebc87b85c095e627988912e4b92c42401523570a. Senare auditförstärkning kördes på samma fångst; dess hash nedan.
`verification.json` och `diffstat-granskad.txt` avser den tidigare frysta granskningspunkten 36b046d5 och lämnas oförändrade som underlag.

| Underlag | SHA-256 |
| --- | --- |
| indata.json | `a53ac8816adc22f97ff445cd5edd10048f728a94139d6d9882587f8948961606` |
| facit.json | `98f50388588c7f76320fa6001b619e595ce76fcfd443456194c4f1fe299fc4bb` |
| tillagg-indata.json | `14590107f70af891896b6ffc6101e0f417030ba4bd66f6bf8e30520ec1a9f4c2` |
| tillagg-facit.json | `c16793e23c86a1332785f8e0b151e0fe67bcd1617f5e974b3f367a0465bfe968` |
| korning-slut/observationer.json.gz | `daecf4c49c514ed02703a2a9aa63d247125b6af75115b056c2003a1528b9bdd1` |
| korning-slut/manifest.json | `92380be8846b0367ce49ab9e2a15bae4d5595cd9d2bffd8811b10806a58cda7a` |
| slutlig audit_bankimport.py | `6e73749db26860abc83ba7d2b84358a1851cb91b07bd51da82342e3a2f22c084` |

SQL-fångstens och källornas hashar verifieras av:

```sh
python3 -B apps/api/scripts/audit_bankimport.py docs/eval/bankimport-identitet/korning-slut/observationer.json.gz --evidence-commit ebc87b85
```

Den manuella diagnostiken körs inte automatiskt av vanlig CI. Grönt CI certifierar därför inte att de 20 redovisade produktavvikelserna är lösta.
