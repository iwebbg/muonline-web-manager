!addincludedir "${__FILEDIR__}"
; electron-builder generates message includes asynchronously. Apply overrides only
; after all generated includes have loaded, when installer.nsi invokes this hook.
!macro customHeader
  !include "installer-bg.nsh"
!macroend

; English (1033) and Bulgarian (1026) custom installer strings.
LangString MuWelcome 1033 "Install the persistent MuOnline Web control panel. WSL2 and Docker Engine setup is available after launch. Services continue when the panel closes.$\r$\n$\r$\nSupport development:$\r$\nhttps://buymeacoffee.com/interweb.bg$\r$\nhttps://ko-fi.com/interwebltd$\r$\nhttps://paypal.me/interwebltd"
LangString MuWelcome 1026 "Инсталирайте постоянния контролен панел MuOnline Web. Настройката на WSL2 и Docker Engine е достъпна след стартиране. Услугите продължават да работят при затворен панел.$\r$\n$\r$\nПодкрепете разработката:$\r$\nhttps://buymeacoffee.com/interweb.bg$\r$\nhttps://ko-fi.com/interwebltd$\r$\nhttps://paypal.me/interwebltd"
LangString MuSupportTitle 1033 "Support MuOnline Web"
LangString MuSupportTitle 1026 "Подкрепете MuOnline Web"
LangString MuSupportSubtitle 1033 "Optional support for continued development"
LangString MuSupportSubtitle 1026 "Доброволна подкрепа за развитието на проекта"
LangString MuSupportDescription 1033 "MuOnline Web is supported by its community. Donations are optional and never required to install or use the manager."
LangString MuSupportDescription 1026 "MuOnline Web се развива с подкрепата на общността. Даренията са доброволни и не са условие за инсталиране или използване на панела."

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TEXT "$(MuWelcome)"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!include nsDialogs.nsh

!macro customPageAfterChangeDir
  Page custom MuOnlineSupportPage
!macroend

!ifndef BUILD_UNINSTALLER
Function MuOnlineSupportPage
  !insertmacro MUI_HEADER_TEXT "$(MuSupportTitle)" "$(MuSupportSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 30u "$(MuSupportDescription)"
  Pop $0
  ${NSD_CreateLink} 0 42u 100% 14u "https://buymeacoffee.com/interweb.bg"
  Pop $0
  ${NSD_OnClick} $0 MuOnlineCoffee
  ${NSD_CreateLink} 0 66u 100% 14u "https://ko-fi.com/interwebltd"
  Pop $0
  ${NSD_OnClick} $0 MuOnlineKofi
  ${NSD_CreateLink} 0 90u 100% 14u "https://paypal.me/interwebltd"
  Pop $0
  ${NSD_OnClick} $0 MuOnlinePaypal
  nsDialogs::Show
FunctionEnd

Function MuOnlineCoffee
  Pop $0
  ExecShell "open" "https://buymeacoffee.com/interweb.bg"
FunctionEnd

Function MuOnlineKofi
  Pop $0
  ExecShell "open" "https://ko-fi.com/interwebltd"
FunctionEnd

Function MuOnlinePaypal
  Pop $0
  ExecShell "open" "https://paypal.me/interwebltd"
FunctionEnd
!endif
