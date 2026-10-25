"""ID delle applicazioni registrate presso i servizi cloud, inclusi nelle versioni distribuite (vedi
ui/guide/archivi-cloud.md). Vuoti = servizio nascosto finche' l'utente non lo configura da "Archivi cloud -> Configura".
Gli ID dei client registrati per MB Desk NON stanno nel repository (GitHub li blocca): le build scrivono
`cloud_ids_build.py` (escluso da git) con `tools/cloud_secrets.py`, da %USERPROFILE%\\.mbvisual\\licenze\\cloud_ids.json
o dalla variabile MBV_CLOUD_IDS (secret del workflow Mac). Google: client "Applicazione desktop" del progetto mb-visual
(Google Auth Platform), lo stesso per Google Drive e la posta Gmail (Gmail, Calendar, People, Drive API attive).
Un ID scritto dall'utente in Configura ha la precedenza."""
IDS = {
    "onedrive": {"client_id": "", "tenant": "common"},
    "gdrive": {"client_id": ""},
    "dropbox": {"client_id": ""},
    "autodesk": {"client_id": ""},
}

try:
    from .cloud_ids_build import IDS as _BUILD
    for _k, _v in _BUILD.items():
        IDS.setdefault(_k, {}).update({a: b for a, b in _v.items() if b})
except ImportError:
    pass
