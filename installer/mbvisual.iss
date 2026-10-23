; Programma di installazione di MB Visual (Inno Setup 6.7). Si compila con tools/build_setup.py, che passa
; versione, cartella dell'app (%USERPROFILE%\.mbvisual\dist\MB Visual, creata da tools/build_portable.py) e la cartella
; ArtDir con icone, immagini e testi dei componenti generati da tools/make_setup_art.py (registro ui/components.json).
; Installazione per l'utente, senza diritti di amministratore, nella stessa cartella usata da "Installa su questo PC"
; (%LOCALAPPDATA%\Programs\MB Visual): gli aggiornamenti automatici dell'app continuano a funzionare.
; Componenti: si installano sempre tutti i file; la scelta (profilo + componenti) accende e spegne le funzioni dell'app
; e si cambia anche dopo da File > Componenti... (mbvisual/components.py). Si salva in %LOCALAPPDATA%\MBVisual\componenti.json
; e in HKCU\Software\MB Visual\Componenti: aggiornando (anche con /SILENT) la scelta precedente viene ripresa.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #error Manca SourceDir (cartella dell'app da installare)
#endif
#ifndef ArtDir
  #error Manca ArtDir (tools/make_setup_art.py)
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
; niente pagine con percorsi o nomi utente: si vede solo cosa sta accadendo (richiesta dell'utente)
DisableReadyPage=yes
DisableWelcomePage=yes
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
; aspetto "Grafite di precisione": tema scuro, logo in alto a destra e nella pagina finale, pagina dei componenti piu' ampia
WizardStyle=modern dark
WizardSizePercent=150,140
WizardImageFile={#ArtDir}\wizard_164x314.png,{#ArtDir}\wizard_205x392.png,{#ArtDir}\wizard_246x471.png,{#ArtDir}\wizard_328x628.png
WizardSmallImageFile={#ArtDir}\small_55.png,{#ArtDir}\small_69.png,{#ArtDir}\small_83.png,{#ArtDir}\small_110.png,{#ArtDir}\small_138.png
WizardImageBackColor=#0f1114
WizardImageStretch=no
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "it"; MessagesFile: "compiler:Languages\Italian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Messages]
it.SelectComponentsLabel2=Scegli il profilo più vicino al tuo lavoro oppure i singoli componenti, poi fai clic su Avanti. Puoi aggiungere o togliere componenti quando vuoi da File › Componenti..., senza reinstallare.
en.SelectComponentsLabel2=Choose the profile closest to your work or individual components, then click Next. You can add or remove components at any time from File › Components..., without reinstalling.
it.WizardSelectComponents=Componenti di MB Visual
en.WizardSelectComponents=MB Visual components
it.SelectComponentsDesc=Cosa vuoi fare con MB Visual?
en.SelectComponentsDesc=What do you want to do with MB Visual?

#include AddBackslash(ArtDir) + "componenti.iss"

[CustomMessages]
it.DesktopIcon=Crea un collegamento sul Desktop
en.DesktopIcon=Create a desktop shortcut
it.Shortcuts=Collegamenti:
en.Shortcuts=Shortcuts:
it.ShellStatus=Integrazione con Esplora risorse...
en.ShellStatus=Integrating with File Explorer...
it.Launch=Avvia MB Visual
en.Launch=Launch MB Visual

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; GroupDescription: "{cm:Shortcuts}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; versione precedente: si tolgono i file vecchi di _internal (come fa l'aggiornamento automatico)
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\MB Visual"; Filename: "{app}\MBVisual.exe"; IconFilename: "{app}\_internal\app.ico"; Comment: "MB Visual"
Name: "{autodesktop}\MB Visual"; Filename: "{app}\MBVisual.exe"; IconFilename: "{app}\_internal\app.ico"; Tasks: desktopicon

[Run]
; miniature/anteprime in Esplora, "Apri con", icone e menu del tasto destro (mbvisual/shellint.py, solo per l'utente): componente sempre incluso
Filename: "{app}\MBVisual.exe"; Parameters: "--integrazione attiva"; StatusMsg: "{cm:ShellStatus}"; Flags: runhidden waituntilterminated; Components: shell
Filename: "{app}\MBVisual.exe"; Description: "{cm:Launch}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; toglie tutte le voci di Esplora (registro dell'utente, icone, cache delle miniature)
Filename: "{app}\MBVisual.exe"; Parameters: "--integrazione rimuovi"; Flags: runhidden waituntilterminated; RunOnceId: "MBVisualIntegrazione"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\_internal"

[Code]
const
  RegKey = 'Software\MB Visual\Componenti';
var
  InfoPanel: TPanel;
  InfoIcon: TBitmapImage;
  InfoTitle, InfoText, InfoTag: TNewStaticText;
  IconSide: Integer;
  ShownId: String;

// elemento n di un elenco separato da virgole
function Item(const List: String; N: Integer): String;
var S: String; P: Integer;
begin
  S := List + ',';
  while N > 0 do begin
    P := Pos(',', S);
    if P = 0 then begin Result := ''; exit; end;
    Delete(S, 1, P);
    N := N - 1;
  end;
  P := Pos(',', S);
  if P = 0 then Result := '' else Result := Copy(S, 1, P - 1);
end;

function InList(const List, Id: String): Boolean;
begin
  Result := Pos(',' + Id + ',', ',' + List + ',') > 0;
end;

procedure LoadIcon(const Name: String);
var F: String;
begin
  F := 'comp_' + Name + '_' + IntToStr(IconSide) + '.bmp';
  ExtractTemporaryFile(F);
  InfoIcon.Bitmap.LoadFromFile(ExpandConstant('{tmp}\') + F);
end;

// descrizione subito sotto il nome, o sotto "Sempre incluso" per i componenti fissi
procedure PlaceText();
begin
  InfoTag.Top := InfoTitle.Top + InfoTitle.Height + ScaleY(4);
  InfoTag.Visible := InfoTag.Caption <> '';
  if InfoTag.Visible then InfoText.Top := InfoTag.Top + InfoTag.Height + ScaleY(10)
  else InfoText.Top := InfoTitle.Top + InfoTitle.Height + ScaleY(10);
  InfoText.Height := InfoPanel.Height - InfoText.Top - ScaleY(12);
end;

// pannello a destra: icona, nome e descrizione del componente scelto nell'elenco
procedure ShowComponent(const Id: String);
begin
  if (Id = '') or (Id = ShownId) then exit;
  ShownId := Id;
  LoadIcon(Id);
  InfoTitle.Caption := CustomMessage('Comp_' + Id);
  InfoText.Caption := CustomMessage('CompDesc_' + Id);
  if InList('{#CompOptional}', Id) then InfoTag.Caption := '' else InfoTag.Caption := CustomMessage('CompSempre');
  PlaceText();
end;

// ... oppure il profilo scelto nella tendina
procedure ShowProfile();
var T: String;
begin
  T := WizardSetupType(False);
  ShownId := '';
  LoadIcon('profilo');
  InfoTitle.Caption := CustomMessage('Prof_' + T);
  InfoText.Caption := CustomMessage('ProfDesc_' + T);
  InfoTag.Caption := '';
  PlaceText();
end;

procedure ComponentsClick(Sender: TObject);
begin
  if WizardForm.ComponentsList.ItemIndex >= 0 then
    ShowComponent(Item('{#CompIds}', WizardForm.ComponentsList.ItemIndex));
end;

procedure ComponentsCheck(Sender: TObject);
begin
  ComponentsClick(Sender);
end;

procedure TypesChange(Sender: TObject);
begin
  ShowProfile();
end;

// aggiornamento: si riprende la scelta salvata dall'app o dall'installazione precedente (anche con /SILENT)
procedure RestoreChoice();
var Attivi, Profilo, Sel, Id: String; I: Integer;
begin
  if (ExpandConstant('{param:TYPE|}') <> '') or (ExpandConstant('{param:COMPONENTS|}') <> '') then exit;
  if not RegQueryStringValue(HKCU, RegKey, 'Attivi', Attivi) then exit;
  if not RegQueryStringValue(HKCU, RegKey, 'Profilo', Profilo) then Profilo := 'personalizzato';
  for I := 0 to WizardForm.TypesCombo.Items.Count - 1 do
    if WizardForm.TypesCombo.Items[I] = CustomMessage('Prof_' + Profilo) then WizardForm.TypesCombo.ItemIndex := I;
  Sel := '';
  I := 0;
  Id := Item('{#CompOptional}', I);
  while Id <> '' do begin
    if InList(Attivi, Id) then Sel := Sel + Id + ',' else Sel := Sel + '!' + Id + ',';
    I := I + 1;
    Id := Item('{#CompOptional}', I);
  end;
  WizardSelectComponents(Sel);
end;

procedure InitializeWizard();
var L: TNewCheckListBox; Gap, W: Integer;
begin
  L := WizardForm.ComponentsList;
  Gap := ScaleX(16);
  W := WizardForm.SelectComponentsPage.ClientWidth;
  if ScaleX(48) > 64 then IconSide := 96 else IconSide := 48;
  // elenco a sinistra, scheda descrittiva a destra (lo spazio su disco non conta: i file si installano tutti)
  WizardForm.ComponentsDiskSpaceLabel.Visible := False;
  L.Width := (W * 46) div 100;
  WizardForm.TypesCombo.Width := L.Width;
  L.Height := WizardForm.SelectComponentsPage.ClientHeight - L.Top;
  L.Offset := ScaleY(4);
  InfoPanel := TPanel.Create(WizardForm);
  InfoPanel.Parent := WizardForm.SelectComponentsPage;
  InfoPanel.BevelOuter := bvNone;
  InfoPanel.Left := L.Left + L.Width + Gap;
  InfoPanel.Top := WizardForm.TypesCombo.Top;
  InfoPanel.Width := W - InfoPanel.Left;
  InfoPanel.Height := L.Top + L.Height - InfoPanel.Top;
  InfoIcon := TBitmapImage.Create(WizardForm);
  InfoIcon.Parent := InfoPanel;
  InfoIcon.Left := ScaleX(18);
  InfoIcon.Top := ScaleY(18);
  InfoIcon.Width := ScaleX(48);
  InfoIcon.Height := ScaleY(48);
  InfoIcon.Stretch := True;
  InfoTitle := TNewStaticText.Create(WizardForm);
  InfoTitle.Parent := InfoPanel;
  InfoTitle.Left := ScaleX(18);
  InfoTitle.Top := InfoIcon.Top + InfoIcon.Height + ScaleY(14);
  InfoTitle.Font.Size := 13;
  InfoTitle.Font.Style := [fsBold];
  InfoTitle.Font.Color := $F1EEEC;
  InfoTitle.AutoSize := True;
  InfoTag := TNewStaticText.Create(WizardForm);
  InfoTag.Parent := InfoPanel;
  InfoTag.Left := ScaleX(18);
  InfoTag.Top := InfoTitle.Top + ScaleY(28);
  InfoTag.Font.Color := $2E7DF0; // arancione MB (BGR)
  InfoTag.AutoSize := True;
  InfoText := TNewStaticText.Create(WizardForm);
  InfoText.Parent := InfoPanel;
  InfoText.Left := ScaleX(18);
  InfoText.Top := InfoTag.Top + ScaleY(22);
  InfoText.Width := InfoPanel.Width - ScaleX(36);
  InfoText.WordWrap := True;
  InfoText.AutoSize := False;
  InfoText.Height := InfoPanel.Height - InfoText.Top - ScaleY(12);
  InfoText.Font.Size := 10;
  InfoText.Font.Color := $C8C2BC;
  L.OnClick := @ComponentsClick;
  L.OnClickCheck := @ComponentsCheck;
  WizardForm.TypesCombo.OnChange := @TypesChange;
  RestoreChoice();
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpSelectComponents then begin
    ShowProfile();
    // /SCHEDA=<id>: apre la pagina con la scheda di quel componente (schermate per le presentazioni)
    if ExpandConstant('{param:SCHEDA|}') <> '' then ShowComponent(ExpandConstant('{param:SCHEDA|}'));
  end;
end;

// scelta finale -> componenti.json (letto dall'app) e registro (ripreso dagli aggiornamenti)
procedure SaveChoice();
var Json, Attivi, Noti, Id, Profilo: String; I: Integer;
begin
  Attivi := '';
  Noti := '';
  I := 0;
  Id := Item('{#CompOptional}', I);
  while Id <> '' do begin
    if Noti <> '' then Noti := Noti + ', ';
    Noti := Noti + '"' + Id + '"';
    if WizardIsComponentSelected(Id) then begin
      if Attivi <> '' then Attivi := Attivi + ', ';
      Attivi := Attivi + '"' + Id + '"';
    end;
    I := I + 1;
    Id := Item('{#CompOptional}', I);
  end;
  Profilo := WizardSetupType(False);
  Json := '{"versione": 1, "profilo": "' + Profilo + '", "attivi": [' + Attivi + '], "noti": [' + Noti + '], "origine": "setup"}';
  ForceDirectories(ExpandConstant('{localappdata}\MBVisual'));
  SaveStringToFile(ExpandConstant('{localappdata}\MBVisual\componenti.json'), Json, False);
  StringChangeEx(Attivi, '"', '', True);
  StringChangeEx(Attivi, ' ', '', True);
  RegWriteStringValue(HKCU, RegKey, 'Attivi', Attivi);
  RegWriteStringValue(HKCU, RegKey, 'Profilo', Profilo);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then SaveChoice();
end;
