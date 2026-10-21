; Programma di installazione di MB Visual (Inno Setup 6). Si compila con tools/build_setup.py, che passa
; versione e cartella dell'app (%USERPROFILE%\.mbvisual\dist\MB Visual, creata da tools/build_portable.py).
; Installazione per l'utente, senza diritti di amministratore, nella stessa cartella usata da "Installa su questo PC"
; (%LOCALAPPDATA%\Programs\MB Visual): gli aggiornamenti automatici dell'app continuano a funzionare.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #error Manca SourceDir (cartella dell'app da installare)
#endif
#ifndef OutDir
  #define OutDir "."
#endif

[Setup]
AppId={{6E3B8C51-2F4A-4D7B-9A61-3C5D7E9F1A20}
AppName=MB Visual
AppVersion={#AppVersion}
AppVerName=MB Visual {#AppVersion}
AppPublisher=MB Engineering srl
AppComments=Visualizzatore e editor di documenti, disegni CAD, modelli 3D e BIM
DefaultDirName={localappdata}\Programs\MB Visual
DisableDirPage=yes
DisableProgramGroupPage=yes
DefaultGroupName=MB Visual
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=MBVisual-Setup-{#AppVersion}
SetupIconFile={#SourceDir}\_internal\app.ico
UninstallDisplayIcon={app}\MBVisual.exe
UninstallDisplayName=MB Visual
Compression=lzma2/normal
SolidCompression=yes
LZMANumBlockThreads=4
DiskSpanning=no
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "it"; MessagesFile: "compiler:Languages\Italian.isl"

[Tasks]
Name: "desktopicon"; Description: "Crea un collegamento sul Desktop"; GroupDescription: "Collegamenti:"
; miniature/anteprime in Esplora, "Apri con", icone e menu del tasto destro (mbvisual/shellint.py, solo per l'utente)
Name: "integrazione"; Description: "Integra con Esplora risorse (miniature e anteprime di DWG, IFC, STEP..., ""Apri con"", icone)"; GroupDescription: "Esplora risorse:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; versione precedente: si tolgono i file vecchi di _internal (come fa l'aggiornamento automatico)
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\MB Visual"; Filename: "{app}\MBVisual.exe"; IconFilename: "{app}\_internal\app.ico"; Comment: "MB Visual"
Name: "{autodesktop}\MB Visual"; Filename: "{app}\MBVisual.exe"; IconFilename: "{app}\_internal\app.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\MBVisual.exe"; Parameters: "--integrazione attiva"; StatusMsg: "Integrazione con Esplora risorse..."; Flags: runhidden waituntilterminated; Tasks: integrazione
Filename: "{app}\MBVisual.exe"; Description: "Avvia MB Visual"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; toglie tutte le voci di Esplora (registro dell'utente, icone, cache delle miniature)
Filename: "{app}\MBVisual.exe"; Parameters: "--integrazione rimuovi"; Flags: runhidden waituntilterminated; RunOnceId: "MBVisualIntegrazione"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\_internal"
