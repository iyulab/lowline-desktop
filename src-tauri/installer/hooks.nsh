; Installer hooks. During an update, wait for the closing app and its sidecar to let go of their files
; before the installer replaces them: wait-for-exit.nsh is tauri-kit-update's own (nsis/wait-for-exit.nsh
; of the version in Cargo.toml), copied unchanged.
; NSIS looks for an included file from the generated installer script, not from this file: name this folder.
!include "${__FILEDIR__}\wait-for-exit.nsh"

!macro NSIS_HOOK_PREINSTALL
  !insertmacro TAURI_KIT_WAIT_FOR_EXIT "host\Lowline.Host.exe"
!macroend
