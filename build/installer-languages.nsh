; Keep the configured EN/BG language order, supplying missing NSIS 3.0.4 MultiUser
; translations before Bulgarian's language-file fallback is evaluated.
!ifmacrodef addLangs
  !macroundef addLangs
!endif
!macro addLangs
  !insertmacro MUI_LANGUAGE "English"
  !define /ifndef MULTIUSER_TEXT_INSTALLMODE_TITLE "Избор на потребители"
  !define /ifndef MULTIUSER_TEXT_INSTALLMODE_SUBTITLE "За кои потребители да се инсталира $(^NameDA)."
  !define /ifndef MULTIUSER_INNERTEXT_INSTALLMODE_TOP "Изберете дали да инсталирате $(^NameDA) само за вас или за всички потребители на този компютър. $(^ClickNext)"
  !define /ifndef MULTIUSER_INNERTEXT_INSTALLMODE_ALLUSERS "Инсталирай за всички потребители на този компютър"
  !define /ifndef MULTIUSER_INNERTEXT_INSTALLMODE_CURRENTUSER "Инсталирай само за мен"
  !insertmacro MUI_LANGUAGE "Bulgarian"
!macroend
