# Posta elettronica in MB Visual

La scheda **Posta** (icona della busta nella barra laterale) raccoglie in un solo posto la posta dello studio, le
caselle PEC, il calendario e i contatti. I messaggi restano sul PC in un archivio **cifrato** (leggibile solo dal tuo
utente di Windows): si leggono anche senza rete e gli invii partono da soli quando la connessione torna.

## 1. Collegare una casella

Posta → pulsante **Aggiungi account** (in basso a sinistra) oppure ⚙ Impostazioni → Account.

### Casella normale (IMAP)
1. Scegli **Altra casella (IMAP)**, scrivi indirizzo e password, premi **Avanti**.
2. MB Visual cerca da solo i server: gestori noti (Libero, Virgilio, TIM, Tiscali, Aruba, Yahoo, iCloud...),
   configurazione pubblicata dal dominio (autoconfig), banca dati dei gestori di Thunderbird, Autodiscover di
   Microsoft, server di posta del dominio (MX), nomi tipici (imap./mail./smtp.).
3. Controlla i dati e premi **Prova e salva**: MB Visual prova sia la ricezione (IMAP) sia l'invio (SMTP).

Se il gestore chiede la **verifica in due passaggi**, nel campo password va una *password per le app* creata dal
pannello del gestore (Gmail, Yahoo, iCloud, Aruba con 2FA...).

### PEC
Scegli **PEC**: i server di Aruba, Legalmail (InfoCert), Namirial, Poste (Postecert e Postecertifica), Register,
Actalis, Libero e TIM sono già impostati (porte SSL 993/465). Basta l'indirizzo e la password della casella.
Note dei gestori:
- **Legalmail**: il nome utente è quello dato da InfoCert, non l'indirizzo (modificalo nella schermata successiva).
- **Namirial**: abilita prima l'accesso IMAP dalla webmail.
- **TIM PEC**: nome utente diverso dall'indirizzo e password secondaria dedicata.
- **Aruba** con verifica in due passaggi: crea una password per le app.

Per la PEC con dominio personalizzato (es. `studio@pec.ditta.it`) scegli il gestore che fornisce il servizio.

### Microsoft 365 / Outlook.com e Gmail
Accesso sicuro nel browser (OAuth 2.0): MB Visual non vede mai la password. Vedi il capitolo 6 per la registrazione
dell'applicazione (da fare una volta sola per tutto lo studio).

## 2. Uso quotidiano

- **Cartelle**: in alto i Preferiti (posta in arrivo di tutti gli account, non letti, contrassegnati, promemoria,
  posta in uscita), poi PEC, Commesse e le cartelle di ogni account. Trascina i messaggi su una cartella per spostarli
  o su una commessa per archiviarli lì.
- **Conversazioni**: i messaggi con lo stesso filo sono raggruppati (numero accanto al mittente); la freccia apre la
  conversazione completa, comprese le tue risposte in Posta inviata.
- **Ricerca** (Ctrl+E): parole nel testo, nell'oggetto e nei nomi degli allegati, anche in parte (`capann`).
  Operatori: `da:anna`, `a:comune`, `oggetto:SCIA`, `ha:allegato`, `allegato:dwg`, `è:nonletto`, `è:contrassegnato`,
  `commessa:24-017`, `categoria:Rosso`, `dopo:2026-01-01`, `prima:31/12/2026`, `pec:ricevute`, `pec:errore`.
  Il pulsante **In tutta la posta** estende la ricerca a tutte le cartelle e agli account.
- **Bandierine, categorie, Ricordamelo**: come in Outlook. "Ricordamelo" fa ricomparire il messaggio con un avviso
  all'ora scelta.
- **Regole** (⚙ → Regole): sui messaggi in arrivo spostano, segnano come letti, contrassegnano, categorizzano,
  collegano e archiviano in una commessa.
- **Invio posticipato**: nel messaggio, pulsante con l'orologio accanto a Invia. I messaggi programmati restano in
  Posta in uscita (si possono inviare subito, riprogrammare o riprendere in modifica). L'app deve essere aperta
  all'ora dell'invio.
- **Firme e risposte rapide**: ⚙ → Firme (HTML con logo e collegamenti, per account) e Risposte rapide.

- **Avvisi e contatore**: la posta si aggiorna anche con la scheda Posta chiusa; il numero sulla busta della barra laterale
  indica i messaggi da leggere e arrivano gli avvisi dei messaggi nuovi, dei promemoria e degli appuntamenti.
- **Conferme di lettura**: se il mittente le chiede compare la barra "Invia conferma"; per chiederla tu, pulsante con la
  ricevuta nel messaggio.
- **File .eml**: una PEC salvata su disco (es. nella cartella di una commessa) si apre con i dati del gestore e il messaggio
  originale; trascinando dei .eml su una cartella della posta si importano.

### Tasti (come Outlook)
| Tasto | Azione |
|---|---|
| Ctrl+N / Ctrl+Maiusc+M | Nuovo messaggio |
| Ctrl+R / Ctrl+Maiusc+R | Rispondi / Rispondi a tutti |
| Ctrl+F | Inoltra (Ctrl+Alt+F come allegato) |
| Ctrl+E o F3 | Cerca |
| Ctrl+Q / Ctrl+U | Segna letto / da leggere |
| Canc / Maiusc+Canc | Elimina / elimina definitivamente |
| Backspace | Archivia |
| Ins | Contrassegna |
| Ctrl+Maiusc+V | Sposta nella cartella |
| Ctrl+Maiusc+I / Ctrl+Maiusc+O | Posta in arrivo / Posta in uscita |
| F9 | Invia e ricevi |
| Ctrl+Invio | Invia (nel messaggio) |
| Ctrl+S | Salva bozza (nel messaggio) |
| Ctrl+1 / 2 / 3 | Posta / Calendario / Contatti |

## 3. PEC: ricevute collegate

- Ogni PEC inviata mostra lo **stato**: Inviata → Accettata → Consegnata (o Non consegnata / Non accettata), con una
  riga per ogni destinatario e la ricevuta da aprire con un clic. Gli indirizzi non PEC sono segnalati: per loro non
  arriva la ricevuta di consegna.
- **Registro PEC inviate** (PEC nella barra a sinistra): tutte le PEC inviate con lo stato, le mancate consegne
  contate in rosso.
- Le ricevute non affollano la posta in arrivo: stanno nell'**Archivio ricevute** e nello stato del messaggio inviato
  (si può cambiare in ⚙ → Opzioni).
- Una **PEC ricevuta** si apre direttamente sul messaggio originale (`postacert.eml`): oggetto, testo e allegati veri,
  con il riquadro del gestore (data, identificativo, mittente certificato) e la busta (`daticert.xml`,
  `postacert.eml`, `smime.p7s`, messaggio completo) a portata di clic. Rispondendo, il destinatario è il mittente vero,
  non il gestore.

## 4. Allegati e commesse

- Un clic su un allegato lo mostra **dentro la lettura** con il visualizzatore di MB Visual (DWG, DXF, IFC, PDF, p7m,
  Office, immagini, modelli 3D...). Doppio clic = scheda a parte. Clic destro: salva, salva nella commessa, firma
  digitalmente e inoltra.
- **Commesse** (⚙ → Commesse o il + accanto a "Commesse"): nome, codice, cartella di progetto, parole chiave e
  indirizzi dei referenti. Un messaggio si collega a una commessa e si **archivia nella sua cartella**
  (`<cartella>/Posta/<data> <oggetto>/`) come .eml con gli allegati; le PEC inviate anche con le ricevute, quelle
  ricevute con `daticert.xml`. La vista "posta per commessa" è nella barra a sinistra.
- MB Visual propone la commessa giusta (codice nell'oggetto, conversazione già collegata, referenti, parole chiave) e
  con il codice nell'oggetto la collega da sola.

## 5. Invio: firma digitale e file pesanti

- Nel messaggio, clic su un allegato → **Firma digitalmente prima dell'invio** (smart card, CNS, firma remota, .p12:
  la stessa firma di File → Firma digitale). L'allegato viene sostituito dalla versione firmata (.p7m o PDF firmato).
- Allegati oltre la soglia (20 MB, modificabile in ⚙ → Opzioni): MB Visual propone di **inviarli come link**. Il file
  va in OneDrive/SharePoint, Google Drive o Dropbox (collegati dal pannello Cloud) nella cartella
  "MB Visual - Invii" e nel messaggio compare il link di download in sola lettura (OneDrive: scadenza 30 giorni dove
  il piano lo permette). Per Dropbox, dopo l'aggiornamento rifai l'accesso dal pannello Cloud (serve il permesso di
  condivisione).

## 6. Microsoft 365 e Google: cosa registrare (una volta per lo studio)

MB Visual usa gli stessi ID applicazione degli **Archivi cloud** (vedi la guida `archivi-cloud.md`), con permessi in
più per posta, calendario e contatti.

### Microsoft Entra (Microsoft 365 / Outlook.com)
1. portal.azure.com → **Microsoft Entra ID → Registrazioni app → Nuova registrazione**.
2. Tipi di account: *Account in qualsiasi directory organizzativa e account Microsoft personali* (per usare anche
   Outlook.com) oppure solo la tua organizzazione.
3. URI di reindirizzamento: piattaforma **Client pubblico/nativo (mobile e desktop)**, indirizzo
   `http://localhost:47613/callback` (la porta si cambia in Cloud → Configura).
4. **Autorizzazioni API → Microsoft Graph → Autorizzazioni delegate**: `offline_access`, `User.Read`, `Mail.ReadWrite`,
   `Mail.Send`, `Calendars.ReadWrite`, `Contacts.ReadWrite` (più `Files.ReadWrite.All` e `Sites.ReadWrite.All` per gli
   archivi cloud e gli invii come link). Se richiesto, **Concedi consenso amministratore** per l'organizzazione.
5. **Autenticazione → Consenti flussi client pubblici: Sì**.
6. Copia l'**ID applicazione (client)** e incollalo in MB Visual: Cloud → Configura → OneDrive / SharePoint
   (lo stesso ID vale per la posta). Tenant: `common` oppure l'ID della directory per limitarlo allo studio.

### Google Cloud (Gmail / Google Workspace)
1. console.cloud.google.com → nuovo progetto → **API e servizi → Libreria**: abilita *Gmail API*, *Google Calendar
   API*, *People API* (e *Google Drive API* per gli archivi cloud).
2. **Schermata consenso OAuth**: tipo *Interno* se avete Google Workspace (solo utenti dello studio, nessuna verifica
   di Google), altrimenti *Esterno* aggiungendo gli indirizzi come *utenti di test*.
3. Ambiti: `https://mail.google.com/`, `https://www.googleapis.com/auth/calendar`,
   `https://www.googleapis.com/auth/contacts`, `openid`, `email`, `profile` (+ `.../auth/drive` per il cloud).
   Nota: `https://mail.google.com/` è un ambito "riservato": con tipo Esterno in produzione Google chiede una verifica;
   con *Interno* o con utenti di test non serve.
4. **Credenziali → Crea credenziali → ID client OAuth → App desktop**. Copia ID client e segreto client in
   MB Visual: Cloud → Configura → Google Drive (lo stesso ID vale per Gmail).

In alternativa senza registrazione: Gmail con **password per le app** come casella IMAP (serve la verifica in due
passaggi attiva sull'account Google).

## 7. Calendario e contatti
- **Calendario** (Ctrl+2): giorno, settimana lavorativa, settimana, mese, agenda. Doppio clic su un orario = nuovo evento.
  Con dei partecipanti l'evento parte come invito (accettabile da Outlook, Gmail, telefono); eliminandolo arriva
  l'annullamento. Gli inviti ricevuti si accettano dalla lettura del messaggio.
- **Contatti** (Ctrl+3): rubriche degli account, scheda con telefoni, indirizzi e messaggi recenti, pulsante Scrivi. Gli
  indirizzi della rubrica vengono proposti mentre scrivi i destinatari.
- Origine dei dati: Microsoft 365 (automatico), Google (automatico con l'accesso Google), altri gestori con **CalDAV/CardDAV**
  (Impostazioni dell'account → Impostazioni avanzate: indirizzo del server, es. Nextcloud, iCloud, Fastmail, Aruba
  Calendario; utente e password se diversi da quelli della posta). Senza server: calendario e rubrica restano su questo PC.

## 8. Privacy e sicurezza
- Archivio in `%LOCALAPPDATA%\MBVisual\posta`: indice e messaggi cifrati AES-256 con chiave protetta da Windows
  (DPAPI). Password e token degli account cifrati allo stesso modo.
- Le immagini remote dei messaggi sono bloccate finché non scegli "Mostra immagini" (evita i pixel di tracciamento);
  si possono sbloccare sempre per un mittente.
- I collegamenti che mostrano un indirizzo diverso da quello vero vengono segnalati prima dell'apertura.
- Gli allegati aperti finiscono in una cartella temporanea (`%TEMP%\MBVisual\posta`) cancellata dopo un giorno.
