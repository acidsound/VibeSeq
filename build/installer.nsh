; VibeSeq keeps its large mutable model/runtime tree beside the executable.
; electron-builder's default update uninstaller moves every item below
; $INSTDIR into $PLUGINSDIR before installing the next version. That fails
; when a custom installation is on another drive because NSIS Rename cannot
; move a directory across volumes, and it would also process all model data.

!define VIBESEQ_DATA_DIRECTORY "VibeSeq Data"
!define VIBESEQ_DATA_BACKUP_SUFFIX ".VibeSeq-Data-preserved"
!define VIBESEQ_SAFE_UNINSTALL_VALUE "DataPreservingUninstaller"

!macro customInit
  ; Releases before the data-preserving uninstaller used electron-builder's
  ; cross-volume atomic removal. Bypass that legacy uninstaller exactly once.
  ; initMultiUser has already restored the registered $INSTDIR at this point.
  ReadRegDWORD $R8 HKCU "${INSTALL_REGISTRY_KEY}" "${VIBESEQ_SAFE_UNINSTALL_VALUE}"
  ${If} $R8 != 1
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      DetailPrint "Migrating the legacy VibeSeq installation in place."
      DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
      !ifdef UNINSTALL_REGISTRY_KEY_2
        DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
      !endif
    ${EndIf}
  ${ElseIfNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
    ; Recover an interrupted install whose safe uninstaller was not written.
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
    !endif
  ${EndIf}
!macroend

!macro customInstall
  ; Future installers can now invoke this release's customRemoveFiles safely.
  WriteRegDWORD HKCU "${INSTALL_REGISTRY_KEY}" "${VIBESEQ_SAFE_UNINSTALL_VALUE}" 1
!macroend

!macro VibeSeqRestorePreservedData
  ${If} ${FileExists} "$R7\*.*"
    CreateDirectory "$INSTDIR"
    ClearErrors
    Rename "$R7" "$INSTDIR\${VIBESEQ_DATA_DIRECTORY}"
    ${If} ${Errors}
      DetailPrint "VibeSeq Data remains safely preserved at $R7."
      Abort "Could not restore VibeSeq Data. It remains preserved at $R7."
    ${EndIf}
  ${EndIf}
!macroend

!macro customRemoveFiles
  ; Keep mutable data on the installation drive while removing only the app.
  ; A sibling backup makes the rename atomic even for installations on G:, D:,
  ; or another custom volume, and avoids copying multi-gigabyte model files.
  SetOutPath "$TEMP"
  StrCpy $R7 "$INSTDIR${VIBESEQ_DATA_BACKUP_SUFFIX}"

  ; Recover cleanly if a previous update stopped after preserving the data.
  ${If} ${FileExists} "$R7\*.*"
    ${If} ${FileExists} "$INSTDIR\${VIBESEQ_DATA_DIRECTORY}\*.*"
      Abort "Both the active and preserved VibeSeq Data folders exist. Refusing to overwrite either folder."
    ${Else}
      !insertmacro VibeSeqRestorePreservedData
    ${EndIf}
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\${VIBESEQ_DATA_DIRECTORY}\*.*"
    ClearErrors
    Rename "$INSTDIR\${VIBESEQ_DATA_DIRECTORY}" "$R7"
    ${If} ${Errors}
      Abort "Could not preserve VibeSeq Data before updating the application."
    ${EndIf}
  ${EndIf}

  ClearErrors
  RMDir /r "$INSTDIR"
  ${If} ${Errors}
    !insertmacro VibeSeqRestorePreservedData
    Abort "Could not remove the previous VibeSeq application files. VibeSeq Data was preserved."
  ${EndIf}

  !insertmacro VibeSeqRestorePreservedData
!macroend
