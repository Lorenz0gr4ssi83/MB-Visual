# Archivi cloud in MB Visual: guida alla registrazione

Con il pannello **Cloud** (in alto a destra, accanto a *Esplora*) MB Visual apre e salva i file direttamente da
**SharePoint/OneDrive**, **Google Drive**, **Dropbox** e **Autodesk Construction Cloud / BIM 360 / Docs**, senza
sincronizzare le cartelle sul PC.

Per poterlo fare, ogni fornitore chiede che l'app sia **registrata** con il tuo account. La registrazione è gratuita,
si fa una volta sola e produce un **ID applicazione** (in inglese *client ID*) da copiare in MB Visual:
**Cloud → Configura**. I servizi senza ID restano nascosti.

> **Sicurezza.** L'accesso avviene sempre nel tuo browser, sulla pagina ufficiale del fornitore: MB Visual non vede
> né salva la tua password. Conserva solo un *token* di accesso cifrato con la protezione di Windows (DPAPI): è
> leggibile solo dal tuo utente su questo PC. **Cloud → Esci** lo cancella.

In tutte le registrazioni serve l'**indirizzo di ritorno** (redirect URI), che MB Visual mostra in *Configura* con il
pulsante *Copia*. Con le impostazioni predefinite è:

```
http://localhost:47613/callback
```

Se la porta 47613 è già usata da un altro programma puoi cambiarla in *Configura*: in quel caso aggiorna l'indirizzo
anche in tutte le registrazioni.

---

## 1. Microsoft SharePoint e OneDrive (Microsoft Entra)

Serve un account Microsoft 365 aziendale (per SharePoint e OneDrive for Business) oppure un account Microsoft personale
(solo OneDrive personale). Se nella tua azienda gli utenti non possono registrare app, chiedi all'amministratore IT di
fare questi passaggi.

1. Apri **https://entra.microsoft.com** e accedi con l'account aziendale.
2. Menu **Identità → Applicazioni → Registrazioni app → Nuova registrazione**.
3. **Nome**: `MB Visual`.
4. **Tipi di account supportati**: scegli
   *Account in qualsiasi directory organizzativa e account Microsoft personali* (funziona per tutti), oppure
   *Solo account in questa directory organizzativa* (solo per i colleghi della tua azienda).
5. **URI di reindirizzamento**: piattaforma **Client pubblico/nativo (dispositivi mobili e desktop)**, indirizzo
   `http://localhost:47613/callback`.
6. Premi **Registra**.
7. Nella pagina *Panoramica* copia **ID applicazione (client)**. Se al punto 4 hai scelto "Solo questa directory",
   copia anche **ID della directory (tenant)**.
8. Menu **Autorizzazioni API → Aggiungi un'autorizzazione → Microsoft Graph → Autorizzazioni delegate** e seleziona:
   `Files.ReadWrite.All`, `Sites.ReadWrite.All`, `User.Read`, `offline_access`. Premi **Aggiungi autorizzazioni**.
9. Facoltativo ma consigliato in azienda: **Concedi consenso amministratore per …** (lo può fare solo un
   amministratore). Senza questo, al primo accesso ogni utente vede la richiesta di consenso, oppure riceve un
   messaggio "è necessaria l'approvazione dell'amministratore" se l'azienda lo impone.
10. Non serve alcun *segreto client*: MB Visual usa il flusso sicuro PKCE per le app desktop.

In MB Visual (**Cloud → Configura**, sezione *OneDrive / SharePoint*):

- **ID applicazione**: quello del punto 7;
- **Tenant**: lascia `common` se al punto 4 hai scelto "qualsiasi directory e account personali"; altrimenti incolla
  l'*ID della directory (tenant)*.

Nel pannello troverai: *Il mio OneDrive*, *Condivisi con me* e *Siti SharePoint* (i siti che segui e quelli che la
ricerca di Microsoft ti mostra), con le loro raccolte documenti.

---

## 2. Google Drive (Google Cloud)

1. Apri **https://console.cloud.google.com** e accedi con l'account Google (meglio quello aziendale Google Workspace,
   se c'è).
2. In alto, selettore dei progetti → **Nuovo progetto** → nome `MB Visual` → **Crea**, poi selezionalo.
3. Menu **API e servizi → Libreria**: cerca **Google Drive API** e premi **Abilita**.
4. Menu **Google Auth Platform** (in alcune console: *API e servizi → Schermata consenso OAuth*) → **Inizia**:
   - nome dell'app `MB Visual`, email di assistenza: la tua;
   - **Pubblico**: *Interno* se hai Google Workspace e l'app serve solo ai colleghi del dominio (consigliato: nessuna
     verifica e nessuna scadenza); altrimenti *Esterno*;
   - email di contatto: la tua → **Crea**.
5. Se hai scelto *Esterno*: sezione **Pubblico → Utenti di test → Aggiungi utenti** e inserisci gli indirizzi Gmail
   che useranno MB Visual (massimo 100). Nota: finché l'app è "in test", Google fa scadere l'accesso ogni 7 giorni
   (basta premere di nuovo *Accedi*). Per toglierlo bisogna pubblicare l'app, e l'ambito Drive completo richiede la
   verifica di Google.
6. Sezione **Accesso ai dati → Aggiungi o rimuovi ambiti**: seleziona `.../auth/drive` (Visualizza, modifica, crea ed
   elimina tutti i tuoi file di Google Drive), `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` →
   **Aggiorna → Salva**.
7. Sezione **Client → Crea client**: tipo di applicazione **App desktop**, nome `MB Visual` → **Crea**.
8. Copia **ID client** e **Segreto client** (per le app desktop Google li considera non riservati, ma non
   pubblicarli comunque).

In MB Visual (**Cloud → Configura**, sezione *Google Drive*): incolla l'**ID applicazione** e il **Segreto client**.
Il segreto viene salvato cifrato per il tuo utente di Windows. Per le app desktop di Google l'indirizzo di ritorno
(`http://127.0.0.1:47613/`) **non va registrato**.

Nel pannello troverai *Il mio Drive*, *Condivisi con me* e *Drive condivisi*. I documenti nativi di Google
(Documenti, Fogli, Presentazioni) si aprono come copia Word/Excel/PowerPoint; quando li salvi, MB Visual propone di
creare un nuovo file Office nella stessa cartella (il documento Google originale non viene toccato).

---

## 3. Dropbox

1. Apri **https://www.dropbox.com/developers/apps** e accedi con il tuo account Dropbox.
2. **Create app**:
   - *Choose an API*: **Scoped access**;
   - *Choose the type of access*: **Full Dropbox**;
   - *Name your app*: un nome unico, per esempio `MB Visual - <nome azienda>` → **Create app**.
3. Scheda **Settings**:
   - **Redirect URIs**: aggiungi `http://localhost:47613/callback` e premi **Add**;
   - **Allow public clients (Implicit Grant & PKCE)**: **Allow**.
4. Scheda **Permissions**: spunta `account_info.read`, `files.metadata.read`, `files.content.read`,
   `files.content.write` e premi **Submit** in basso.
5. Torna in **Settings** e copia **App key**. Il *App secret* **non serve**.
6. Un'app nuova è "in sviluppo": funziona per te e per un massimo di 500 utenti collegati. Oltre, si chiede la
   produzione con **Apply for production**.

In MB Visual (**Cloud → Configura**, sezione *Dropbox*): incolla la **App key** come *ID applicazione*.

---

## 4. Autodesk Construction Cloud, BIM 360 e Autodesk Docs (Autodesk Platform Services)

1. Apri **https://aps.autodesk.com**, premi **Sign in** e accedi con l'account Autodesk.
2. Vai al tuo **Developer Hub** / **Applications** e scegli **Create application** (se è la prima volta, il sito ti fa
   creare un *hub* per lo sviluppatore: è gratuito).
3. Tipo di applicazione: **Desktop, Mobile, Single-Page App** (client pubblico con PKCE, senza segreto). Nome
   `MB Visual`.
4. **Callback URL**: `http://localhost:47613/callback`.
5. **API** da abilitare: **Data Management API** e, se presenti nell'elenco, **Autodesk Construction Cloud API** /
   **BIM 360 API**. Salva.
6. Copia il **Client ID**.
7. **Passaggio obbligatorio per ACC e BIM 360**: un *amministratore dell'account* Autodesk Construction Cloud deve
   autorizzare l'app, altrimenti i progetti non compaiono:
   - ACC: **Account Admin → Impostazioni (Settings) → Integrazioni personalizzate (Custom Integrations) →
     Aggiungi integrazione personalizzata**; scegli *Document Management* e incolla il **Client ID**;
   - BIM 360: **Account Admin → Impostazioni → Integrazioni personalizzate** (stessi passaggi).
   Gli hub personali (Autodesk Docs / Fusion Team) non hanno bisogno di questo passaggio.

In MB Visual (**Cloud → Configura**, sezione *Autodesk*): incolla il **Client ID** come *ID applicazione*.

Nel pannello troverai gli hub (account), poi i progetti e le loro cartelle (*Project Files*, *Plans*…). La ricerca
funziona dentro una cartella di progetto (cerca anche nelle sottocartelle). Ogni salvataggio crea una **nuova
versione** del file in ACC/BIM 360, come il caricamento dal sito.

---

## Come si usa

- **Accedi**: nel pannello Cloud scegli il servizio e premi *Accedi*. Si apre il browser: accedi e autorizza
  MB Visual. Quando compare "Accesso completato" torna all'app.
- **Aprire**: fai clic su un file. MB Visual lo scarica in una cartella temporanea e lo apre nel visualizzatore
  adatto, come un file del PC.
- **Salvare**: salva normalmente (Ctrl+S o il pulsante dell'editor). Pochi secondi dopo MB Visual carica il file sul
  cloud come nuova versione. Vale anche se lo modifichi con *Modifica in Excel/Word/PowerPoint*.
- **Conflitti**: se nel frattempo un collega ha salvato lo stesso file sul cloud, MB Visual non sovrascrive niente e
  chiede cosa fare: *Salva come copia* (accanto all'originale, con nome e data), *Sovrascrivi* (la versione del
  collega resta nella cronologia delle versioni del servizio) oppure *Apri la versione del cloud*.
- **Aggiornamenti dei colleghi**: se il file aperto (scheda attiva) cambia sul cloud e tu non hai modifiche in
  sospeso, MB Visual scarica da solo la nuova versione; altrimenti ti avvisa.
- **Salva nel cloud**: menu **File → Salva nel cloud...** (oppure *Salva qui il file attivo* in fondo al pannello)
  salva il file aperto, anche in un altro formato, in qualsiasi cartella di un servizio collegato.
- **Esci**: *Esci* nel pannello cancella il token da questo PC.

## Per l'installazione sui PC dei colleghi

Gli ID applicazione non sono segreti: invece di farli inserire a ogni collega, si possono scrivere una volta in
`mbvisual/cloud_ids.py` prima di creare la build; i servizi compaiono allora su tutti i PC (ognuno accede con il
proprio account). Il segreto client di Google è l'unico dato da non distribuire con leggerezza: se lo inserisci in
`cloud_ids.py` (`"client_secret": "..."`), usa un'app Google di tipo *Interno* (solo il tuo dominio Workspace).

## Problemi frequenti

| Messaggio | Causa e soluzione |
| --- | --- |
| *La porta 47613 è occupata* | Un altro programma usa la porta: cambiala in *Configura* e aggiorna l'indirizzo di ritorno nelle registrazioni. |
| *redirect_uri mismatch* / *invalid redirect* (nel browser) | L'indirizzo di ritorno registrato non è identico a quello mostrato in *Configura* (attenzione a `localhost`, porta e `/callback`). |
| *È necessaria l'approvazione dell'amministratore* (Microsoft) | L'azienda non permette agli utenti di autorizzare app: l'amministratore deve premere *Concedi consenso amministratore* (passo 1.9). |
| *Accesso bloccato: app non verificata* (Google) | L'account non è tra gli *utenti di test* (passo 2.5) oppure l'app è *Esterna* non pubblicata. |
| Nessun progetto Autodesk visibile | Manca l'integrazione personalizzata nell'Account Admin di ACC/BIM 360 (passo 4.7), oppure non sei membro dei progetti. |
| *Accesso scaduto o revocato, accedi di nuovo* | Il token è scaduto (Google in test: ogni 7 giorni) o è stato revocato: premi *Accedi*. |
| *Il file è salvato solo sul PC* | Il caricamento non è riuscito (rete, permessi): nel pannello Cloud, sezione *Aperti dal cloud*, premi *Carica*. |
