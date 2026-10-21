# File di esempio pubblici (solo per le prove)

Non generati da MB Visual: servono a collaudare i lettori con file prodotti dai programmi originali.
Si riscaricano con `python tools/make_fx_samples.py --pubblici`.

| File | Fonte | Licenza |
|---|---|---|
| testPages.pages, testPages2013.pages, testNumbers.numbers, testNumbers2013.numbers, testKeynote2013.key, testKeynote2018.key | Apache Tika, `tika-parser-apple-module/src/test/resources/test-documents` (github.com/apache/tika) | Apache-2.0 |
| testICalendar.ics | Apache Tika, `tika-parsers-standard-integration-tests/src/test/resources/test-documents` | Apache-2.0 |
| testRSAKEYandCERT.p12 | Apache Tika, `tika-parser-crypto-module/src/test/resources/test-documents` (password non nota: serve a provare la richiesta della password) | Apache-2.0 |
| Empty-Metric.rvt, withModelText.rfa | Dynamo for Revit, `test/System` (github.com/DynamoDS/DynamoRevit) | Apache-2.0 |
| sresa1b.nc (non nel repository, 2,7 MB) | Apache Tika, `tika-parser-scientific-module`; in origine esempio NetCDF di Unidata | Apache-2.0 |

Gli altri file di `tests/samples/fx` sono generati da `tools/make_fx_samples.py` (dati inventati); `CT_small.dcm` ed
`emri_small.dcm` sono copiati dai file di prova di pydicom (licenza MIT).
