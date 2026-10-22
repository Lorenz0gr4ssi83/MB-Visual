# Modelli delle pratiche edilizie: fonti e licenze

I file `*.mbm` di questa cartella sono trascrizioni (nel linguaggio a righe di `mbvisual/edilizia.py`) dei moduli
unificati e standardizzati nazionali per l'edilizia, piu' alcuni schemi redatti per MB Visual dove un modulo nazionale
non esiste. I file che iniziano con `_` sono parti comuni incluse dai moduli.

## Licenza e riutilizzo

- I moduli sono allegati ad Accordi tra Governo, Regioni ed enti locali in Conferenza Unificata pubblicati in Gazzetta
  Ufficiale: sono atti ufficiali dell'amministrazione pubblica, esclusi dalla protezione del diritto d'autore
  (art. 5 della legge 22 aprile 1941, n. 633).
- Il portale del Dipartimento della Funzione Pubblica che li distribuisce (www.italiasemplice.gov.it) pubblica i contenuti
  con licenza **Creative Commons Attribuzione 3.0 Italia (CC BY 3.0 IT)** "salvo diversa indicazione"
  (pagina "Note legali", verificata il 22/10/2026: https://www.italiasemplice.gov.it/portale/note-legali). L'attribuzione
  e' data qui e nell'intestazione di ogni pagina generata ("Modulo unificato - Accordi C.U. ...").
- Nessun marchio o logo istituzionale e' riprodotto nei moduli generati.

## Fonti dei testi

| Modello | Fonte |
| --- | --- |
| `cila.mbm` | CILA, modulo unificato nazionale (Accordo C.U. 4 maggio 2017, G.U. n. 128 del 5/6/2017, S.O. n. 26), file `comunicazione-di-inizio-lavori-asseverata-cila.docx` del portale Italia Semplice; modifiche dell'Accordo C.U. 27 marzo 2025 (G.U. n. 85 dell'11/4/2025), sezione D dell'allegato: quadro "Dichiarazione di tolleranze" e quadro riepilogativo sostituito |
| `scia.mbm`, `_asseverazione_scia.mbm`, `_regolarita.mbm`, `_riepilogo_scia.mbm`, `_riepilogo_tecnico.mbm`, `_quadri_tecnici.mbm` | SCIA, Relazione tecnica di asseverazione e Quadro riepilogativo (Accordo C.U. 4/5/2017: `scia.docx`, `scia-asseverazione.docx`, `scia-quadro-riepilogativo-della-documentazione.docx`) con le modifiche dell'Accordo C.U. 27/3/2025, sezione A (qualificazione dell'intervento, sanatoria e regolarizzazioni, regolarita' urbanistica, tipologia di intervento, stato legittimo, tolleranze, punti 11.3 e 13.3.3, quadro riepilogativo) |
| `scia_alternativa.mbm` | SCIA alternativa al permesso di costruire (Accordo C.U. 4/5/2017: `scia-alternativa-al-pdc.docx`, `scia-alternativa-asseverazione.docx`, `scia-alternativa-quadro-riepilogativo.docx`) con le modifiche dell'Accordo C.U. 27/3/2025, sezione C |
| `cilas.mbm` | CILA-Superbonus, modulo unificato nazionale (Accordo C.U. 4 agosto 2021, Rep. n. 88/CU, G.U. n. 201 del 23/8/2021), testo preso dal modello Word distribuito dalla Regione Emilia-Romagna (`modello-cila-s.docx`, l'Accordo e' immediatamente efficace senza adattamenti regionali); tolto il riferimento alla LR ER 15/2013 nell'informativa |
| `fine_lavori.mbm` | Comunicazione di fine lavori (Accordo C.U. 4/5/2017, `comunicazione-fine-lavori.docx`; non modificata nel 2025) |
| `soggetti_coinvolti.mbm`, `_tecnico.mbm`, `_titolare.mbm` | Allegato "Soggetti coinvolti" e quadri dei dati del titolare/ditta/procuratore (Accordo C.U. 4/5/2017, `soggetti-coinvolti.docx`) |
| `_sicurezza.mbm` | Quadro "Rispetto degli obblighi in materia di salute e sicurezza nei luoghi di lavoro" dei moduli CILA/SCIA 2017 |
| `_privacy.mbm` | Informativa art. 13 Regolamento UE 2016/679 nella forma del modulo CILA-Superbonus 2021 (i moduli 2017 citavano ancora l'art. 13 del d.lgs. 196/2003) |
| `inizio_lavori.mbm` | **Schema MB Visual**: non esiste un modulo unificato nazionale per la comunicazione di inizio lavori dei titoli gia' efficaci (permesso di costruire, SCIA condizionata o alternativa). Usa i quadri dei moduli unificati (titolare, localizzazione, sicurezza) e i riferimenti all'art. 15 d.P.R. 380/2001 e all'art. 90, comma 9, d.lgs. 81/2008 |
| `procura_speciale.mbm`, `delega.mbm` | **Schemi MB Visual** (non sono moduli unificati): art. 1392 c.c., art. 38 d.P.R. 445/2000, art. 65 d.lgs. 82/2005; artt. 22 e seguenti l. 241/1990 |
| `relazione_tecnica.mbm`, `dichiarazione_conformita.mbm` | **Schemi MB Visual** in Word: indice ricavato dai quadri della relazione di asseverazione unificata; dichiarazione su art. 6-bis c.5, art. 23 c.7 e art. 24 d.P.R. 380/2001 |

Copie dei moduli nazionali 2017: archivio del portale Italia Semplice,
https://web.archive.org/web/20240224063356/http://www.italiasemplice.gov.it/modulistica/modulistica-unificata-e-standardizzata/
(pagina non piu' presente nel nuovo portale). Modifiche 2025: "Istruzioni per l'adeguamento della modulistica Edilizia -
DL 69-2024" (allegato all'Accordo, 50 pagine), https://www.italiasemplice.gov.it/portale/w/modulistica-salva-casa.

## Modulistica regionale

Le Regioni possono adattare i quadri contrassegnati con (*). L'elenco in `mbvisual/edilizia.py` (REGIONI) riporta gli
atti di adozione noti al 22/10/2026 (fonte: ricognizione BibLus-net/ACCA, aggiornata a dicembre 2025, da verificare sui
siti regionali). MB Visual genera sempre i moduli nazionali e, se la regione scelta ha modulistica propria, lo segnala.
Da aggiungere come modelli regionali dedicati: tutte le regioni dell'elenco (Abruzzo, Basilicata, Calabria, Campania,
Emilia-Romagna, Lazio, Liguria, Lombardia, Marche, Molise, Piemonte, Puglia, Sardegna/SUAPE, Sicilia, Toscana, Umbria)
e Friuli Venezia Giulia, Veneto, Valle d'Aosta, Province autonome di Trento e Bolzano (modulistica propria di anni precedenti).
Non trascritti (fuori dalla richiesta): permesso di costruire, CIL, segnalazione certificata per l'agibilita'.
