; ============================================================
;  Inno Setup script - ตัวติดตั้ง E-Voting Card Agent
;  สร้างไฟล์ Setup.exe พร้อมไอคอนบนเดสก์ท็อป
;
;  วิธีใช้:
;   1) รัน package-agent.bat ก่อน เพื่อสร้างโฟลเดอร์ ..\agent-dist
;   2) ติดตั้ง Inno Setup: https://jrsoftware.org/isdl.php
;   3) เปิดไฟล์นี้ด้วย Inno Setup แล้วกด Build (Ctrl+F9)
;      หรือสั่ง:  ISCC.exe installer.iss
;   4) ได้ไฟล์ติดตั้งที่  .\installer-output\EVotingCardAgent-Setup.exe
;
;  บันทึกไฟล์นี้เป็น UTF-8 (มี BOM) เพื่อให้ Inno Setup แสดงภาษาไทยได้ถูกต้อง
; ============================================================

#define MyAppName "E-Voting Card Agent"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "E-Voting"
#define MyAppExeName "start-agent.bat"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\EVotingCardAgent
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=.\installer-output
OutputBaseFilename=EVotingCardAgent-Setup
SetupIconFile=evoting.ico
UninstallDisplayIcon={app}\evoting.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "สร้างไอคอนบนเดสก์ท็อป (Desktop icon)"; GroupDescription: "ไอคอน:"
Name: "startupicon"; Description: "เปิด Agent อัตโนมัติเมื่อเปิดเครื่อง (Run at startup)"; GroupDescription: "ตัวเลือกเพิ่มเติม:"; Flags: unchecked

[Files]
; คัดลอกทั้งโฟลเดอร์ agent-dist (มี Node แบบพกพา + ไลบรารีอ่านบัตรที่คอมไพล์แล้ว)
Source: "..\agent-dist\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "evoting.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\evoting.ico"
Name: "{group}\ถอนการติดตั้ง {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\evoting.ico"; Tasks: desktopicon
Name: "{autostartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\evoting.ico"; Tasks: startupicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "เปิด E-Voting Card Agent เดี๋ยวนี้"; Flags: postinstall nowait skipifsilent shellexec
