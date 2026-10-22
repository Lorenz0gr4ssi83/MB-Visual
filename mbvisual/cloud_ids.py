"""ID delle applicazioni registrate presso i servizi cloud, inclusi nelle versioni distribuite (vedi
ui/guide/archivi-cloud.md). Vuoti = servizio nascosto finche' l'utente non lo configura da "Archivi cloud -> Configura".
Gli ID applicazione dei client pubblici (PKCE) non sono segreti; il segreto del client Google NON va scritto qui:
lo inserisce l'utente nella finestra di configurazione (resta cifrato per l'utente di Windows)."""
IDS = {
    "onedrive": {"client_id": "", "tenant": "common"},
    "gdrive": {"client_id": ""},
    "dropbox": {"client_id": ""},
    "autodesk": {"client_id": ""},
}
