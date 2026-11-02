import path from "node:path";

function literal(value: string): string {
  if (!value || /[$"\r\n\0]/.test(value))
    throw new Error("UNSAFE_INSTALLER_TEXT");
  return `"${value.replaceAll("/", "\\")}"`;
}

export function friendInstallerScript(options: {
  packageDirectory: string;
  outputExecutable: string;
  instructions: string;
  notices: string;
  smokeId: string;
  files: string[];
}): string {
  if (
    !/^[a-f0-9]{32}$/.test(options.smokeId) ||
    !options.files.length ||
    options.files.length > 5000
  )
    throw new Error("INVALID_INSTALLER_OPTIONS");
  for (const value of [
    options.packageDirectory,
    options.outputExecutable,
    options.instructions,
    options.notices,
  ])
    if (!path.isAbsolute(value))
      throw new Error("ABSOLUTE_INSTALLER_PATH_REQUIRED");
  const files = [...options.files];
  if (new Set(files.map((file) => file.toLowerCase())).size !== files.length)
    throw new Error("DUPLICATE_INSTALLER_FILE");
  const directories = new Set<string>();
  for (const file of files) {
    if (
      file.includes("\\") ||
      file
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === ".." || part.includes(":"),
        ) ||
      path.isAbsolute(file)
    )
      throw new Error("UNSAFE_INSTALLER_FILE");
    literal(file);
    let directory = path.posix.dirname(file);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  const deletes = files
    .map((file) => `  Delete "$INSTDIR\\App\\${file.replaceAll("/", "\\")}"`)
    .join("\n");
  const removeDirectories = [...directories]
    .sort(
      (a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a),
    )
    .map(
      (directory) =>
        `  RMDir "$INSTDIR\\App\\${directory.replaceAll("/", "\\")}"`,
    )
    .join("\n");
  return `Unicode true
RequestExecutionLevel user
Name "LobbyMesh"
OutFile ${literal(options.outputExecutable)}
InstallDir "$LOCALAPPDATA\\Programs\\LobbyMesh"
SetCompressor zlib
CRCCheck force
VIProductVersion "0.1.0.0"
VIAddVersionKey /LANG=1033 "ProductName" "LobbyMesh"
VIAddVersionKey /LANG=1033 "FileDescription" "LobbyMesh private test setup"
VIAddVersionKey /LANG=1033 "FileVersion" "0.1.0"
VIAddVersionKey /LANG=1033 "LegalCopyright" "See included notices"
!include "MUI2.nsh"
!include "FileFunc.nsh"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "Install LobbyMesh for your Windows account.$\\r$\\n$\\r$\\nAfter setup, choose a name and exchange contact codes with your friend. Voice is optional and calls start muted."
!define MUI_FINISHPAGE_RUN "$INSTDIR\\App\\LobbyMesh.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open LobbyMesh"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Var SmokeMode

Function .onInit
  SetShellVarContext current
  StrCpy $SmokeMode 0
  StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\LobbyMesh"
  ${"$"}{GetParameters} $0
  ClearErrors
  ${"$"}{GetOptions} $0 "/LOBBYMESH_SMOKE" $1
  IfErrors normal
  StrCpy $SmokeMode 1
  StrCpy $INSTDIR "$TEMP\\lobbymesh-installer-smoke-${options.smokeId}"
  IfFileExists "$INSTDIR\\*.*" 0 normal
  Abort
normal:
  FindWindow $0 "" "LobbyMesh"
  StrCmp $0 0 ready
  IfSilent running
  MessageBox MB_OK|MB_ICONEXCLAMATION "Close LobbyMesh, then run setup again."
running:
  SetErrorLevel 2
  Abort
ready:
FunctionEnd

Section "LobbyMesh"
  SetOutPath "$INSTDIR\\App"
  File /r ${literal(path.join(options.packageDirectory, "*"))}
  SetOutPath "$INSTDIR"
  File /oname=START-HERE.txt ${literal(options.instructions)}
  File /oname=INSTALLER-LICENSES.txt ${literal(options.notices)}
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  StrCmp $SmokeMode 1 done
  CreateShortCut "$SMPROGRAMS\\LobbyMesh.lnk" "$INSTDIR\\App\\LobbyMesh.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LobbyMesh" "DisplayName" "LobbyMesh"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LobbyMesh" "DisplayVersion" "0.1.0 (private preview)"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LobbyMesh" "UninstallString" '$\\"$INSTDIR\\Uninstall.exe$\\"'
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LobbyMesh" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LobbyMesh" "NoRepair" 1
done:
SectionEnd

Function un.onInit
  SetShellVarContext current
  StrCpy $SmokeMode 0
  StrCmp $INSTDIR "$LOCALAPPDATA\\Programs\\LobbyMesh" valid
  StrCmp $INSTDIR "$TEMP\\lobbymesh-installer-smoke-${options.smokeId}" smoke invalid
smoke:
  StrCpy $SmokeMode 1
  Goto valid
invalid:
  SetErrorLevel 3
  Abort
valid:
  FindWindow $0 "" "LobbyMesh"
  StrCmp $0 0 ready
  IfSilent running
  MessageBox MB_OK|MB_ICONEXCLAMATION "Close LobbyMesh, then uninstall again."
running:
  SetErrorLevel 2
  Abort
ready:
FunctionEnd

Section "Uninstall"
${deletes}
${removeDirectories}
  RMDir "$INSTDIR\\App"
  Delete "$INSTDIR\\START-HERE.txt"
  Delete "$INSTDIR\\INSTALLER-LICENSES.txt"
  Delete "$INSTDIR\\Uninstall.exe"
  StrCmp $SmokeMode 1 done
  Delete "$SMPROGRAMS\\LobbyMesh.lnk"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LobbyMesh"
done:
  RMDir "$INSTDIR"
SectionEnd
`;
}
