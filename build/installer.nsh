!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TEXT "Install the persistent MuOnline Web control panel. WSL2 and Docker Engine setup is available after launch. Services continue when the panel closes.$\r$\n$\r$\nSupport development:$\r$\nhttps://buymeacoffee.com/interweb.bg$\r$\nhttps://ko-fi.com/interwebltd$\r$\nhttps://paypal.me/interwebltd"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!include nsDialogs.nsh

!macro customPageAfterChangeDir
  Page custom MuOnlineSupportPage
!macroend

!ifndef BUILD_UNINSTALLER
Function MuOnlineSupportPage
  !insertmacro MUI_HEADER_TEXT "Support MuOnline Web" "Optional support for continued development"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 30u "MuOnline Web is supported by its community. Donations are optional and never required to install or use the manager."
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
