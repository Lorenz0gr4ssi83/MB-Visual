# MB Visual per Mac - guida al collaudo

Prima prova su un Mac vero. Questa versione è **non firmata** (manca ancora il certificato Apple): macOS la blocca
finché non la autorizzi a mano, una volta sola. Serve un Mac con **chip Apple** (M1, M2, M3, M4) e macOS 12 o più recente.

Priorità del collaudo: **1) l'app si avvia, 2) apre i file**. Il resto viene dopo.

---

## 1. Scaricare la build

Il modo più semplice: dal Mac apri la pagina **Releases** del repository **MB-Visual-Rilasci** su GitHub e, nella
versione più recente (1.6.1 o successiva), scarica `MBVisual-<versione>-mac.dmg`.

In alternativa, la build più recente di prova:
1. Su GitHub apri il repository **MB-Visual**, scheda **Actions**, ed entra con il tuo account.
2. Nell'elenco a sinistra scegli **Build Mac**, poi clicca l'esecuzione più recente con il segno verde (ramo `main`).
3. In fondo alla pagina, nella sezione **Artifacts**, scarica:
   - **MBVisual-mac-dmg**: è quello da usare;
   - **MBVisual-mac-zip**: è la riserva, nel caso il .dmg non si apra.
4. GitHub consegna sempre un file `.zip`. Fai doppio clic per estrarlo: dentro trovi `MBVisual-<versione>-mac.dmg`
   (o `MBVisual-<versione>-mac.zip` con dentro `MB Visual.app`).

Se la versione è stata pubblicata anche tra i rilasci (repository **MB-Visual-Rilasci**, pagina **Releases**), lì il
`.dmg` si scarica direttamente, accanto al setup per Windows.

## 2. Installare

**Con il .dmg**
1. Doppio clic sul `.dmg`: si apre una finestra con `MB Visual`, `Applications` e `LEGGIMI.txt`.
2. Trascina **MB Visual** sulla cartella **Applications**.
3. Espelli il disco "MB Visual" (icona sulla Scrivania o nella barra laterale del Finder).

**Con lo zip di riserva**
1. Doppio clic su `MBVisual-<versione>-mac.zip`: compare `MB Visual.app`.
2. Trascinala nella cartella **Applicazioni**.

## 3. Primo avvio di un'app non firmata

Prova i metodi in quest'ordine e fermati al primo che funziona.

**A. Clic destro > Apri** (macOS 12, 13 e 14)
1. Apri il Finder e vai in **Applicazioni**.
2. Fai clic destro (oppure Ctrl+clic) su **MB Visual** e scegli **Apri**.
3. Nell'avviso clicca di nuovo **Apri**.

**B. Impostazioni > Privacy e sicurezza > Apri comunque** (obbligatorio su macOS 15 Sequoia e successivi)
1. Fai doppio clic su MB Visual: compare un avviso. Clicca **Fine** oppure **OK**.
2. Apri **Impostazioni di Sistema > Privacy e sicurezza** e scorri fino alla sezione **Sicurezza**.
3. Accanto a "MB Visual è stato bloccato…" clicca **Apri comunque**, poi conferma con la password o il Touch ID.
4. Riapri l'app e, nell'ultimo avviso, clicca **Apri**.

**C. Se macOS dice "MB Visual è danneggiato e non può essere aperto"**
L'app non è rotta: macOS ha messo in quarantena il file scaricato. Apri **Terminale** (Applicazioni > Utility) e scrivi:

```bash
xattr -cr "/Applications/MB Visual.app"
```

Poi riapri l'app. Il comando toglie il segno "scaricato da internet" a tutti i file dell'app e non tocca nient'altro.

## 4. Licenza (da sapere prima)

Il server delle licenze è quello di sempre e sul Mac l'impronta del dispositivo è quella del Mac (non cambia
reinstallando l'app). Il Mac conta come un **PC**. Se usi la tua chiave, già attiva sul PC Windows, il server
risponde "Questa licenza è già attiva su un altro PC". Per il collaudo:
- in **MB Visual Admin** crea una licenza di prova (es. cliente "Collaudo Mac", 1 PC) e usa quella chiave sul Mac;
- a collaudo finito revocala da MB Visual Admin.

---

## 5. Cose da provare

I file di prova sono nella cartella del progetto `tests/samples` (su OneDrive). Puoi anche usare file veri dei clienti.
Segna ✅ (funziona), ⚠️ (funziona male) oppure ❌ (non funziona).

### Avvio (priorità massima)
| # | Prova | Esito |
|---|-------|-------|
| 1 | L'app si apre dal Finder e mostra la schermata iniziale (non resta bianca) | |
| 2 | Si attiva la licenza di prova (schermata di attivazione → chiave) | |
| 3 | Chiusura con il pulsante rosso e poi riapertura | |
| 4 | Il puntatore resta sempre la freccia | |

### Apertura dei file (priorità massima)
| # | Prova | Esito |
|---|-------|-------|
| 5 | **Trascinamento**: un file trascinato dal Finder nella finestra si apre | |
| 6 | **Apri**: dal pulsante Apri, finestra di scelta dei file del Mac | |
| 7 | **Dal Finder**: clic destro su un file > Apri con > MB Visual (con l'app chiusa e con l'app già aperta) | |
| 8 | **PDF**: si vede, si scorre, zoom, ricerca; "Modifica PDF" apre la barra degli strumenti | |
| 9 | **DWG** e **DXF**: si vede il disegno, layer, zoom | |
| 10 | **IFC**: modello 3D, albero, clic su un elemento → scheda BIM | |
| 11 | **STEP / STL / OBJ** (3D) | |
| 12 | **Word, Excel, PowerPoint** (.docx, .xlsx, .pptx): si apre l'editor ONLYOFFICE; modifica e Salva | |
| 13 | **Immagini**: JPG, PNG, HEIC dell'iPhone; l'editor immagini si apre | |
| 14 | **Video e audio**: MP4, MOV dell'iPhone, MP3: si riproducono | |
| 15 | **Archivi**: ZIP e 7Z, estrazione di un file | |
| 16 | **Email** (.eml, .msg) e **testo** (.txt, .csv) | |

### Funzioni
| # | Prova | Esito |
|---|-------|-------|
| 17 | **Salva con nome** in un altro formato: PDF → immagini, DOCX → PDF, immagine → PNG, video → MP4 | |
| 18 | **OCR**: PDF scansionato > Modifica PDF > Altro > "Rendi ricercabile", poi cerca una parola | |
| 19 | **Crea nuovo** (Cmd+N): Word, DXF, immagine | |
| 20 | **Mostra nella cartella**: si apre il Finder sul file | |
| 21 | **Scorciatoie** con **Cmd** come sul Mac (Cmd+O, Cmd+S, Cmd+P, Cmd+Z): annota quelle che non funzionano | |
| 22 | **Navisworks** (.nwd): in questa build il lettore Navisworks non c'è ancora; annota solo che messaggio compare | |
| 23 | **Stampa** (Cmd+P): compaiono le stampanti del Mac; stampa un PDF e un DXF su A4; "PDF vettoriale" salva il file | |
| 24 | **Firma digitale** con un file **.p12/.pfx** (le smart card del Mac non ci sono ancora): firma e verifica | |
| 25 | **Archivi cloud** (OneDrive/Google Drive/Dropbox): accesso, apertura di un file; al secondo avvio resta collegato | |
| 26 | **Lingua**: menu File > Impostazioni › Lingua > Automatica segue la lingua del Mac; prova anche l'inglese | |
| 27 | **Sposta in Applicazioni**: aprendo l'app fuori da Applicazioni, la voce nel menu File la copia lì e la riapre | |
| 28 | **Ricerca nel progetto** su una cartella con PDF e DWG | |

Non serve provarle ora (verranno dopo): aggiornamento automatico, anteprime Quick Look, motore IA, firma con smart card.
Sul Mac non ci sono per scelta: "Integrazione con Windows" (miniature in Esplora risorse) e "Modifica in Word/Excel" via
automazione (il pulsante apre comunque il file con Microsoft Office per Mac, se installato).

---

## 6. Se qualcosa non va: cosa annotare

Per ogni problema scrivi:
1. **numero della prova** e **file usato** (nome ed estensione; se puoi, conserva il file);
2. **cosa hai fatto** e **cosa è successo**, con il **messaggio d'errore esatto**: meglio uno **screenshot**
   (Cmd+Maiusc+4, poi trascina sulla zona da catturare);
3. **versione di macOS** ( > Informazioni su questo Mac) e **chip** (M1, M2…).

Poi recupera i **registri**:
- **Registro dell'app**: `~/Library/Logs/MBVisual.log`
  (Finder > menu **Vai > Vai alla cartella…** > scrivi `~/Library/Logs` > Invio). Ogni avvio inizia con una riga `--- avvio`.
- **Se l'app si chiude da sola o non si apre**: i rapporti di arresto di macOS sono in `~/Library/Logs/DiagnosticReports`
  (file che iniziano con "MB Visual"). Si leggono anche con l'app **Console** > Rapporti di arresto.
- **Avvio dal Terminale**, utile se l'app non mostra niente: i messaggi compaiono direttamente nel Terminale.

```bash
"/Applications/MB Visual.app/Contents/MacOS/MB Visual"
```

  Copia tutto il testo che compare. Per chiudere premi Ctrl+C.
- **Interfaccia nel browser**, se la finestra resta bianca. Con questo comando il Terminale scrive un indirizzo
  `http://127.0.0.1:…`: aprilo in Safari e annota se lì l'app funziona.

```bash
"/Applications/MB Visual.app/Contents/MacOS/MB Visual" --browser
```

Manda i file di registro, gli screenshot e questa tabella compilata: con quelli si correggono i problemi.
