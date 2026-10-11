#define AppName "HandsFree"
#define AppVersion "0.3.0"
#define AppPublisher "Benzene"
#define SourceRoot ".."

[Setup]
AppId={{7C0E0D2A-4B19-4C0E-9E7A-6E2F1B3A9D41}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
; per-user install: the browser profile and model dir must be writable, and
; PrivilegesRequired=lowest keeps this off the UAC prompt
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
OutputDir=..\dist
OutputBaseFilename=HandsFree-{#AppVersion}-setup
; ~2 GB of mostly-binary payload, so keep compression cheap
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceRoot}\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs
Source: "{#SourceRoot}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\models\*"; DestDir: "{app}\models"; Flags: ignoreversion
Source: "{#SourceRoot}\node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs
Source: "runtime\node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "runtime\browsers\*"; DestDir: "{app}\browsers"; Flags: ignoreversion recursesubdirs
Source: "HandsFree.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\HandsFree.cmd"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\HandsFree.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\HandsFree.cmd"; Description: "Start {#AppName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent