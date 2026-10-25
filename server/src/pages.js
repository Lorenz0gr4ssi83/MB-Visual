// Pagine pubbliche del server (GET, senza cookie ne' licenza), richieste anche da Google per l'app OAuth di Gmail e Drive:
//   /mbdesk (anche /mbvisual) presentazione di MB Desk          /privacy  informativa unica (licenza, statistiche, posta e archivi cloud)
// Testo in italiano con l'inglese sotto. BOZZA legale da far rivedere. Mai il nome del proprietario: contatto = segnalazione
// dall'app e, se configurata, la variabile SUPPORT_EMAIL (indirizzo neutro di assistenza) in wrangler.toml.
// Le affermazioni devono restare vere rispetto al codice: statistiche (src/stats.js, mbvisual/stats.py), posta (mbvisual/mail:
// archivio cifrato sul dispositivo), cloud (mbvisual/cloud.py: token cifrati DPAPI/Portachiavi), licenze (src/index.js).

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const CSS = `*{box-sizing:border-box}html{background:#17191b}body{margin:0;color:#e6e8e5;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 20px 60px}
main{width:min(760px,100%);margin:0 auto}header{text-align:center;margin-bottom:28px}header img{width:104px;height:104px}
h1{font-size:26px;margin:10px 0 2px}.by{margin:0;color:#8a8c89;font-size:13px;letter-spacing:.05em}h2{font-size:19px;margin:30px 0 8px;color:#f07d2e}
h3{font-size:16px;margin:20px 0 4px}p,li{color:#cfd2cc}ul{padding-left:22px}a{color:#f07d2e}.en{margin-top:44px;padding-top:24px;border-top:1px solid #34383b}
.muted{color:#8a8c89;font-size:14px}.btn{display:inline-block;margin:6px 6px 0 0;padding:10px 16px;border-radius:8px;background:#26292c;border:1px solid #34383b;color:#e6e8e5;text-decoration:none}
.btn.p{background:#f07d2e;border-color:#f07d2e;color:#16110c;font-weight:600}blockquote{margin:12px 0;padding:10px 14px;border-left:3px solid #f07d2e;background:#1f2224;color:#e6e8e5}
footer{margin-top:40px;text-align:center}`;

function page(title, body, lang = "it") {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/img/icon-192.png"><style>${CSS}</style></head><body><main>
<header><img src="/img/logo-512.png" alt="MB Desk"><h1>MB Desk</h1><p class="by">Powered by MB Group</p></header>
${body}</main></body></html>`;
}
const contact = (env, en) => {
  const mail = String(env.SUPPORT_EMAIL || "").trim();
  const app = en ? "from the app, <b>File › Account and license › Report</b>" : "dall'app, <b>File › Account e licenza › Segnalazione</b>";
  return mail ? `${en ? "by email at" : "via email a"} <a href="mailto:${esc(mail)}">${esc(mail)}</a> ${en ? "or" : "oppure"} ${app}` : app;
};

export function presentationPage(env) {
  return page("MB Desk", `
<p>MB Desk è un'applicazione per aprire, consultare e modificare file tecnici e documenti: PDF, disegni CAD (DWG, DXF), modelli 3D e BIM (IFC e altri),
documenti Office, immagini, video, archivi, file firmati digitalmente e molti altri formati. Funziona su PC Windows, su Mac e sul telefono.</p>
<p>È distribuita da MB Group a clienti selezionati, con una licenza personale. I file aperti restano sul dispositivo dell'utente.</p>
<p>Con il consenso dell'utente MB Desk può collegarsi alla sua casella di posta (anche Gmail) e ai suoi archivi cloud (anche Google Drive) per aprire e salvare
i file e leggere e inviare i messaggi direttamente dall'app. Questi dati restano sul dispositivo dell'utente.</p>
<p><a class="btn p" href="/privacy">Informativa sulla privacy</a></p>
<section class="en"><h2>English</h2>
<p>MB Desk is an application to open, view and edit technical files and documents: PDF, CAD drawings (DWG, DXF), 3D and BIM models (IFC and more), Office documents,
images, video, archives, digitally signed files and many other formats. It runs on Windows PCs, on Macs and on phones.</p>
<p>It is distributed by MB Group to selected customers under a personal license. Opened files stay on the user's device.</p>
<p>With the user's permission MB Desk can connect to the user's mailbox (including Gmail) and cloud storage (including Google Drive) to open and save files and to read and
send messages directly in the app. This data stays on the user's device.</p>
<p><a class="btn p" href="/privacy">Privacy policy</a></p></section>
<footer class="muted">MB Desk · MB Group</footer>`);
}

export function privacyPage(env) {
  return page("MB Desk - Privacy", `
<h2 style="margin-top:0">Informativa sulla privacy</h2>
<p class="muted">Ultimo aggiornamento: 23 ottobre 2026</p>
<p>Questa informativa descrive quali dati tratta MB Desk (app per PC, Mac e telefono) e questo server. Titolare del trattamento: MB Workshop Srl (MB Group).</p>

<h3>1. Licenza</h3>
<p>Per attivare e rinnovare la licenza l'app invia a questo server: la chiave di licenza, un'impronta del dispositivo (codice ricavato dall'identificativo del
sistema e non reversibile; sul telefono un codice casuale), il nome del dispositivo, il tipo (PC o cellulare) e la versione dell'app. Il server conserva anche
il nome e l'email del cliente indicati da MB Group alla creazione della licenza, le date di attivazione e dell'ultimo controllo e le segnalazioni inviate
dall'app. Finalità: fornire il servizio acquistato e impedire l'uso non autorizzato (esecuzione del contratto). I dati restano finché la licenza è attiva e
si cancellano su richiesta quando la licenza viene eliminata. Sul telefono l'attivazione è conservata in un cookie tecnico necessario al funzionamento.</p>

<h3>2. Statistiche d'uso anonime (solo con consenso)</h3>
<p>Alla prima apertura l'app per PC e Mac chiede se inviare statistiche anonime d'uso. Senza un clic su "Sì" non si raccoglie e non si invia nulla. Con il consenso,
una volta al giorno l'app invia: un identificativo casuale dell'installazione (non legato alla licenza né al dispositivo), versione, sistema operativo, architettura,
lingua, numero di avvii e tempo d'uso, componenti attivi, estensioni dei file aperti (solo l'estensione), funzioni usate e tipo di errori dei visualizzatori.
Mai nomi di file, percorsi, contenuti, posta, contatti, calendari o dati degli account collegati; l'indirizzo IP non viene salvato con le statistiche.
Finalità: capire quali formati e funzioni migliorare. Base giuridica: consenso (art. 6.1.a GDPR e art. 122 del Codice privacy), revocabile in ogni momento da
File › Impostazioni › Statistiche d'uso. Conservazione: poiché i dati sono anonimi, si conservano finché servono a migliorare MB Desk; si cancellano quando
l'utente revoca il consenso (l'app lo chiede automaticamente al server) o su richiesta, comunicando l'identificativo mostrato nella stessa finestra.</p>

<h3>3. Posta e archivi cloud collegati (Gmail, Google Drive, Microsoft, Dropbox, Autodesk)</h3>
<p>L'utente può collegare a MB Desk la propria casella di posta e i propri archivi cloud. L'accesso avviene con l'autorizzazione del fornitore (OAuth) e
serve solo alle funzioni richieste dall'utente: leggere, scrivere, organizzare e inviare la posta, gestire calendario e contatti, aprire e salvare i file.</p>
<ul>
<li>I token di accesso, i messaggi e i file scaricati restano solo sul dispositivo dell'utente, cifrati (Windows: protezione dati dell'utente; Mac: Portachiavi),
e non arrivano mai ai server di MB Group. Le richieste partono dall'app direttamente verso Google, Microsoft, Dropbox o Autodesk.</li>
<li>I dati di Google (e degli altri fornitori) non vengono usati per statistiche, pubblicità o profilazione, non vengono venduti né ceduti a terzi e non vengono
letti da persone, salvo richiesta esplicita dell'utente per assistenza o obblighi di legge.</li>
<li>Quando l'utente invia un file grande come collegamento, il collegamento viene creato nel suo archivio cloud.</li>
</ul>
<blockquote>MB Desk's use and transfer to any other app of information received from Google APIs will adhere to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</blockquote>
<p>Revoca dell'accesso: dall'app (eliminando l'account nelle impostazioni della posta, che cancella dal dispositivo token e messaggi salvati, oppure con Esci nel pannello Cloud, che cancella i token) oppure dal fornitore:
Google <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, Microsoft
<a href="https://myapps.microsoft.com">myapps.microsoft.com</a> o <a href="https://account.live.com/consent/Manage">account.live.com/consent/Manage</a>,
Dropbox Impostazioni › App collegate.</p>

<h3>4. File dell'utente</h3>
<p>I documenti aperti con MB Desk restano sul dispositivo: l'app non li invia a MB Group.</p>

<h3>5. Fornitori e luogo del trattamento</h3>
<p>Questo server funziona sulla piattaforma Cloudflare, con il database collocato in Europa. Gli aggiornamenti dell'app vengono scaricati da GitHub.</p>

<h3>6. Diritti e contatti</h3>
<p>Puoi chiedere accesso, rettifica, cancellazione, limitazione e opposizione, e proporre reclamo al Garante per la protezione dei dati personali
(<a href="https://www.garanteprivacy.it">garanteprivacy.it</a>). Contatti: ${contact(env, false)}.</p>

<section class="en"><h2>Privacy policy (English)</h2>
<p class="muted">Last updated: 23 October 2026</p>
<p>This policy describes the data processed by MB Desk (app for PC, Mac and phone) and by this server. Data controller: MB Workshop Srl (MB Group).</p>
<h3>1. License</h3>
<p>To activate and renew the license the app sends this server: the license key, a device fingerprint (a non-reversible code derived from the system identifier;
on phones a random code), the device name, the device type (PC or phone) and the app version. The server also keeps the customer's name and email entered by
MB Group when the license is created, activation and last-check dates, and reports sent from the app. Purpose: providing the purchased service and preventing
unauthorized use (performance of a contract). Data is kept while the license is active and deleted on request when the license is removed. On phones the
activation is stored in a strictly necessary technical cookie.</p>
<h3>2. Anonymous usage statistics (consent only)</h3>
<p>On first launch the PC and Mac app asks whether to send anonymous usage statistics. Unless "Yes" is clicked nothing is collected or sent. With consent, once a day
the app sends: a random installation identifier (not linked to the license or the device), version, operating system, architecture, language, number of launches and
time of use, active components, extensions of opened files (the extension only), features used and the type of viewer errors. Never file names, paths, contents,
email, contacts, calendars or data from connected accounts; the IP address is not stored with the statistics. Purpose: understanding which formats and features to
improve. Legal basis: consent (Art. 6(1)(a) GDPR and Art. 122 of the Italian Privacy Code), which can be withdrawn at any time in File › Settings › Usage statistics.
Retention: as the data is anonymous, it is kept for as long as it is useful to improve MB Desk; it is deleted when the user withdraws consent (the app asks the
server automatically) or on request, quoting the identifier shown in the same window.</p>
<h3>3. Connected email and cloud storage (Gmail, Google Drive, Microsoft, Dropbox, Autodesk)</h3>
<p>Users can connect their mailbox and cloud storage to MB Desk. Access is granted through the provider's authorization (OAuth) and is used only for the features
the user requests: reading, writing, organizing and sending email, managing calendar and contacts, opening and saving files.</p>
<ul>
<li>Access tokens, messages and downloaded files stay only on the user's device, encrypted (Windows: user data protection; Mac: Keychain), and never reach
MB Group's servers. Requests go from the app directly to Google, Microsoft, Dropbox or Autodesk.</li>
<li>Google data (and data from the other providers) is not used for statistics, advertising or profiling, is not sold or transferred to third parties, and is not
read by humans, except at the user's explicit request for support or where required by law.</li>
<li>When the user sends a large file as a link, the link is created in the user's own cloud storage.</li>
</ul>
<blockquote>MB Desk's use and transfer to any other app of information received from Google APIs will adhere to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</blockquote>
<p>Revoking access: in the app (removing the account in the mail settings, which deletes the tokens and saved messages from the device, or signing out in the Cloud panel, which deletes the tokens) or at the provider: Google
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, Microsoft <a href="https://myapps.microsoft.com">myapps.microsoft.com</a> or
<a href="https://account.live.com/consent/Manage">account.live.com/consent/Manage</a>, Dropbox Settings › Connected apps.</p>
<h3>4. User files</h3>
<p>Documents opened with MB Desk stay on the device: the app does not send them to MB Group.</p>
<h3>5. Providers and location</h3>
<p>This server runs on the Cloudflare platform, with the database located in Europe. App updates are downloaded from GitHub.</p>
<h3>6. Rights and contact</h3>
<p>You can request access, rectification, erasure, restriction and objection, and lodge a complaint with the Italian Data Protection Authority
(<a href="https://www.garanteprivacy.it">garanteprivacy.it</a>). Contact: ${contact(env, true)}.</p></section>
<footer class="muted"><a href="/mbdesk">MB Desk</a> · MB Group</footer>`);
}
