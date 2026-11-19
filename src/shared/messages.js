import { resolveLocale, translate } from './i18n.js';

/** Known application messages only. Arbitrary logs and SQL diagnostics are not translated. */
const bulgarian = {
  "Windows needs updating before the current WSL runtime can be installed. Update Windows, then click Install again. Existing distributions were retained.": "Преди инсталирането на актуалния WSL runtime е нужно обновяване на Windows. Обнови Windows и натисни Инсталирай отново. Съществуващите дистрибуции са запазени.",
  "The official WSL installer could not be downloaded. Check internet access and retry Install. Existing distributions were retained.": "Официалният WSL инсталатор не може да бъде изтеглен. Провери интернет връзката и опитай Инсталирай отново. Съществуващите дистрибуции са запазени.",
  "WSL installer verification failed. The package was not executed. Retry Install after checking Windows updates and network access.": "Проверката на WSL инсталатора е неуспешна. Пакетът не е стартиран. Провери обновяванията на Windows и мрежовия достъп, после опитай отново.",
  "The verified WSL installer did not complete. Check Windows Installer and retry Install. Existing distributions were retained.": "Провереният WSL инсталатор не завърши успешно. Провери Windows Installer и опитай отново. Съществуващите дистрибуции са запазени.",
  "WSL runtime was installed but its modern commands are not available yet. Restart Windows, then retry Install.": "WSL runtime е инсталиран, но новите му команди още не са достъпни. Рестартирай Windows и опитай Инсталирай отново.",
  "This WSL version is too old for automatic setup. Update Windows and install current WSL from Microsoft Store, then click Install again. Existing distributions were retained.": "Тази версия на WSL е твърде стара за автоматична настройка. Обнови Windows и инсталирай актуалния WSL от Microsoft Store, после натисни Инсталирай отново. Съществуващите дистрибуции са запазени.",
  "Restart Windows, then click Install again to continue. Installation progress has been saved.": "Рестартирай Windows и натисни Инсталирай отново, за да продължиш. Напредъкът на инсталацията е запазен.",
  "Untracked application files exist. Recover installation state before uninstalling.": "Има файлове на приложение без запазено състояние. Възстанови състоянието преди деинсталиране.",
  "Confirm the exact SQL endpoint, web database and login before uninstalling.": "Потвърди точния SQL сървър, web база и login преди деинсталиране.",
  "Temporary SQL sysadmin credentials are required for uninstall.": "За деинсталацията са нужни временни SQL sysadmin credentials.",
  "The SQL login differs from the saved installation. Reconcile configuration before uninstalling.": "SQL login-ът се различава от запазената инсталация. Съгласувай конфигурацията преди деинсталиране.",
  "Cannot verify SQL targets before backup or update. Check application configuration.": "SQL връзките не могат да бъдат проверени преди архивиране или обновяване. Проверете конфигурацията на приложението.",
  "SQL targets or game profile differ from the saved installation. Reconcile the runtime configuration before backup or update.": "SQL връзките или game профилът се различават от запазената инсталация. Съгласувайте конфигурацията преди архивиране или обновяване.",
  "Site environment contains an unterminated quoted value.": "В конфигурацията на сайта има незатворена кавичка. Поправете файла преди промяна на достъпа.",
  "Existing site environment is missing. Restore it before updating.": "Конфигурацията на сайта липсва. Възстановете я преди обновяване.",
  "Complete installation and check website status first.": "Завършете инсталацията и проверете състоянието на сайта.",
  "Installed website address is invalid. Check access settings.": "Адресът на инсталирания сайт е невалиден. Проверете настройките за достъп.",
  "Administrator not found.": "Администраторът не е намерен.",
  "The last active administrator cannot be deleted or deactivated.": "Последният активен администратор не може да бъде изтрит или деактивиран.",
  "Administrator update failed. Check database availability and identity constraints.": "Промяната е неуспешна. Проверете връзката с базата и ограниченията за потребителите.",
  "Deletion failed. Check database availability; identities referenced by history must be deactivated with admin:update --active=0 instead.": "Изтриването е неуспешно. Проверете базата; потребителите, свързани с историята, трябва да бъдат деактивирани.",
  "Invalid administrator ID.": "Невалиден ID на администратор.",
  "Invalid administrator update fields.": "Невалидни полета за редакция.",
  "Invalid administrator active state.": "Невалидно активно състояние.",
  "Confirm administrator deactivation.": "Потвърдете деактивирането на администратора.",
  "Confirm administrator deletion.": "Потвърдете изтриването на администратора.",
  "Provide at least one administrator change.": "Посочете поне една промяна.",
  "Administrator password must have at least 12 characters, uppercase, lowercase, number and symbol.": "Паролата трябва да има поне 12 символа, главна и малка буква, число и специален символ.",
  "The email has already been taken.": "Този имейл вече се използва.",
  "The password must be at least 12 characters.": "Паролата трябва да е поне 12 символа.",
  "The password must contain at least one uppercase and one lowercase letter.": "Паролата трябва да съдържа главна и малка буква.",
  "The password must contain at least one number.": "Паролата трябва да съдържа число.",
  "The password must contain at least one symbol.": "Паролата трябва да съдържа специален символ.",
  "Runtime operations require Windows with WSL2. Linux development supports tests and the panel preview.": "Runtime операциите изискват Windows с WSL2. На Linux са достъпни тестовете и прегледът на интерфейса.",
  "Invalid feed settings.": "Невалидни настройки на release feed.",
  "CDN must use HTTPS without credentials.": "CDN адресът трябва да използва HTTPS без вградени credentials.",
  "Invalid release channel prefix.": "Невалиден префикс на release канала.",
  "WSL returned an invalid runtime response. Complete Ubuntu initialization and retry.": "WSL върна невалиден отговор. Завършете първоначалната настройка на Ubuntu и опитайте отново.",
  "Ubuntu-24.04 must be installed and use WSL version 2. Run WSL setup, finish Ubuntu initialization and restart Windows if requested.": "Ubuntu-24.04 трябва да е инсталирана във WSL2. Стартирайте настройката на WSL, завършете настройката на Ubuntu и рестартирайте Windows, ако е необходимо.",
  "WSL features requested. Restart Windows if required, then run WSL setup again to install Ubuntu-24.04 for this Windows user.": "Заявено е активиране на WSL. Ако е нужно, рестартирайте Windows и стартирайте настройката отново, за да инсталирате Ubuntu-24.04 за този потребител.",
  "WSL2 and Ubuntu installation requested for this user. Launch Ubuntu-24.04 once to finish initialization, then check prerequisites.": "Заявена е инсталация на WSL2 и Ubuntu за този потребител. Отворете Ubuntu-24.04, за да завършите първоначалната настройка, след което проверете зависимостите.",
  "Initialize Ubuntu-24.04 under WSL2 first.": "Първо завършете настройката на Ubuntu-24.04 във WSL2.",
  "Docker installed. MuOnline-Web-WSL logon task keeps services alive when the panel closes.": "Docker е инсталиран. Задачата MuOnline-Web-WSL поддържа услугите при затворен панел.",
  "Check the signed web release feed before installing or updating.": "Проверете подписания web release feed преди инсталация или обновяване.",
  "No authenticated newer manager release is available.": "Няма проверена по-нова версия на панела.",
  "Verified manager installer launched. The panel will close; WSL services continue.": "Провереният инсталатор на панела е стартиран. Панелът ще се затвори; WSL услугите продължават да работят.",
  "Another operation is running. Wait for it to finish.": "Изпълнява се друга операция. Изчакайте да завърши.",
  "Feed settings saved.": "Настройките на release feed са запазени.",
  "Unsupported manager operation.": "Неподдържана операция на панела.",
  "Unsupported operation.": "Неподдържана операция.",
  "Invalid language.": "Невалиден език.",
  "Cannot launch the verified manager installer.": "Провереният инсталатор на панела не може да бъде стартиран.",
  "A clean HTTPS URL is required.": "Нужен е HTTPS адрес без credentials, query параметри или fragment.",
  "Only stable major.minor.patch versions are accepted.": "Приемат се само стабилни версии във формат major.minor.patch.",
  "Release is unsigned or uses an untrusted signing key.": "Release-ът не е подписан или използва недоверен ключ за подписване.",
  "Release manifest signature is invalid.": "Подписът на release manifest-а е невалиден.",
  "Unsupported release manifest.": "Неподдържан release manifest.",
  "Release requires a different manager/runtime version.": "Release-ът изисква друга версия на панела или runtime средата.",
  "Invalid release artifact.": "Невалиден release артефакт.",
  "Release has no valid Laravel game registry.": "Release-ът няма валиден Laravel registry за game профили.",
  "Release metadata is too large.": "Release метаданните са твърде големи.",
  "Invalid release prefix.": "Невалиден release префикс.",
  "Artifact exceeds signed size.": "Артефактът надвишава подписания размер.",
  "Artifact checksum mismatch.": "Контролната сума на артефакта не съвпада.",
  "Install the application first.": "Първо инсталирайте приложението.",
  "Invalid SQL identifier.": "Невалиден SQL идентификатор.",
  "Reserved SQL identifier.": "Запазен SQL идентификатор.",
  "Invalid text value.": "Невалидна текстова стойност.",
  "Invalid environment value.": "Невалидна стойност на променлива на средата.",
  "Invalid access mode.": "Невалиден режим на достъп.",
  "Confirm the HTTP production warning.": "Потвърдете предупреждението за HTTP в production.",
  "Invalid domain.": "Невалиден домейн.",
  "Invalid ACME email.": "Невалиден ACME имейл.",
  "Archive contains too many entries.": "Архивът съдържа твърде много записи.",
  "Unsafe archive path.": "Опасен път в архива.",
  "Duplicate archive path.": "Повтарящ се път в архива.",
  "Archive links and special files are forbidden.": "Връзки и специални файлове не се допускат в архива.",
  "Archive contains protected runtime data.": "Архивът съдържа защитени runtime данни.",
  "Vendor archive must contain vendor/ only.": "Vendor архивът трябва да съдържа само vendor/.",
  "Application archive cannot contain vendor/.": "Архивът на приложението не трябва да съдържа vendor/.",
  "Archive exceeds extraction size limit.": "Архивът надвишава допустимия размер за разархивиране.",
  "Invalid release version.": "Невалидна release версия.",
  "Artifact size mismatch.": "Размерът на артефакта не съвпада.",
  "Laravel game profile registry is missing.": "Липсва Laravel registry за game профили.",
  "Manifest profiles differ from the Laravel registry.": "Профилите в manifest-а се различават от Laravel registry.",
  "Administrator password must have at least 12 characters.": "Паролата на администратора трябва да има поне 12 знака.",
  "Invalid administrator email.": "Невалиден имейл на администратора.",
  "Administrator creation was not confirmed.": "Създаването на администратора не беше потвърдено.",
  "Administrator created.": "Администраторът е създаден.",
  "Existing installation detected. Use recovery or update instead.": "Открита е съществуваща инсталация. Използвайте възстановяване или обновяване.",
  "SQL databases and runtime identities must be distinct.": "SQL базите и runtime SQL logins трябва да бъдат различни.",
  "Invalid SQL host.": "Невалиден SQL host.",
  "Invalid SQL port.": "Невалиден SQL порт.",
  "Invalid APP_ENV.": "Невалиден APP_ENV.",
  "Choose a profile from the release registry.": "Изберете профил от release registry.",
  "Only incomplete first installations can be resumed.": "Могат да се продължат само незавършени първи инсталации.",
  "Game database diagnostics failed. Run SQL diagnostics to inspect schema and permission checks.": "Диагностиката на game базата е неуспешна. Стартирайте SQL диагностиката, за да проверите схемата и правата.",
  "Installation complete. Bootstrap credentials removed. Game writes remain disabled.": "Инсталацията е завършена. Временните bootstrap credentials са премахнати. Записите в game базата остават изключени.",
  "Use an absolute backup directory on the SQL Server host.": "Използвайте абсолютен път за backup директорията на SQL Server машината.",
  "Recover the incomplete installation before updating.": "Възстановете незавършената инсталация преди обновяване.",
  "Release is not newer than installed application.": "Release-ът не е по-нов от инсталираното приложение.",
  "Update removes the installed game profile.": "Обновяването премахва инсталирания game профил.",
  "Update failed before migrations; original runtime restored.": "Обновяването е неуспешно преди migrations; първоначалната runtime среда е възстановена.",
  "This runtime release requires x64 WSL. ARM64 is not supported yet.": "Тази runtime версия изисква x64 WSL. ARM64 все още не се поддържа.",
  "Upgrade Docker Compose; --env-from-file support is required.": "Обновете Docker Compose; нужна е поддръжка на --env-from-file.",
  "Installation requires manual recovery. Consult the recovery guide.": "Инсталацията изисква ръчно възстановяване. Вижте ръководството за recovery.",
  "Recover installation first.": "Първо възстановете инсталацията.",
  "Unsupported runtime operation.": "Неподдържана runtime операция.",
  "Runtime operation failed. No credentials were logged. Inspect installation state and the recovery guide.": "Runtime операцията е неуспешна. Не са записани credentials в логовете. Проверете състоянието на инсталацията и recovery ръководството.",
  "Untrusted IPC sender.": "Недоверен IPC източник.",
  "IPC payload exceeds limit.": "IPC заявката надвишава допустимия размер.",
  "External link is not allowed.": "Външният линк не е разрешен.",
  "fetch failed": "Свързването с release сървъра е неуспешно.",
  "The operation was aborted due to timeout": "Операцията е прекратена поради изтекло време.",
  "Invalid GitHub repository.": "Невалидно GitHub repository.",
  "Invalid GitHub tag response.": "GitHub върна невалиден списък с версии.",
  "No stable application tag is available.": "Няма публикуван стабилен таг на приложението.",
  "GitHub tag list exceeds the discovery limit.": "Списъкът с GitHub тагове надвишава допустимия размер за проверка.",
  "Signed release version does not match the latest GitHub tag.": "Версията на подписания пакет не съвпада с последния GitHub таг.",
  "A stable application version is required.": "Нужна е стабилна версия на приложението.",
  "Latest application release is not ready for installation.": "Последната версия още не е готова за инсталиране.",
  "Installed application version could not be determined.": "Инсталираната версия не може да бъде определена.",
  "No newer application version is available.": "Няма по-нова версия на приложението.",
  "An equivalent firewall rule already exists. Retest instead of adding a duplicate.": "Еквивалентно firewall правило вече съществува. Повторете теста, вместо да добавяте дубликат.",
  "Firewall rules could not be inspected. Retest before preparing a change.": "Firewall правилата не могат да бъдат проверени. Повторете преди подготовка на промяна.",
  "Existing firewall rule does not match the previewed scope.": "Съществуващото firewall правило не съвпада с предвидения обхват.",
  "Invalid measured IPv4 interface.": "Невалидни измерени IPv4 interface данни.",
  "Measured WSL NAT scope is required.": "Нужен е съвпадащ измерен частен WSL NAT обхват. Не може да се предложи безопасно правило.",
  "Invalid SQL troubleshooting input.": "Невалидни полета за SQL диагностика.",
  "Invalid SQL instance.": "Невалиден SQL instance.",
  "Windows SQL inventory is unavailable.": "Windows SQL информацията не е достъпна.",
  "SQL troubleshooting could not inspect WSL. No credentials were logged.": "SQL диагностиката не може да провери WSL. Credentials не са записани в логове.",
  "Unsupported SQL change.": "Неподдържана SQL системна промяна.",
  "Select a discovered SQL instance first.": "Първо изберете открит SQL instance.",
  "Selected SQL port is owned by another process or could not be verified.": "Избраният SQL порт е зает от друг процес или не може да бъде проверен.",
  "Selected SQL port is owned by another process.": "Избраният SQL порт е зает от друг процес.",
  "Choose an enabled IP section when Listen All is No.": "При Listen All: No изберете enabled IP секция.",
  "SQL change needs a current preview and explicit confirmation.": "SQL промяната изисква актуален preview и изрично потвърждение.",
  "SQL configuration or WSL addresses changed. Retest and prepare a new preview.": "SQL конфигурацията или WSL адресите са променени. Проверете отново и подгответе нов preview.",
  "Run SQL troubleshooting before copying a report.": "Стартирайте SQL диагностиката преди копиране на отчет."
};

const prefixes = [
  ['Cannot start required executable: ', 'Нужната програма не може да бъде стартирана: '],
  ['Incomplete runtime release: ', 'Непълен runtime release: '],
  ['Access configuration applied: ', 'Конфигурацията за достъп е приложена: '],
  ['Initial access setup failed. Installation state was preserved; use Resume installation after correcting DNS/firewall. Backup: ', 'Първоначалната настройка на достъпа е неуспешна. Състоянието е запазено; продължете инсталацията след поправка на DNS/firewall. Backup: '],
  ['Access change and recovery failed. Restore the private configuration backup: ', 'Промяната на достъпа и възстановяването са неуспешни. Възстановете частния конфигурационен backup: '],
  ['Access change failed; previous configuration restored. Backup: ', 'Промяната на достъпа е неуспешна; предишната конфигурация е възстановена. Backup: '],
  ['Update failed after migrations began. Site remains in maintenance. Do not automatically roll back SQL. Backup: ', 'Обновяването е неуспешно след започнали migrations. Сайтът остава в maintenance. Не връщайте автоматично SQL промените. Backup: '],
  ['Update failed before migrations, but runtime recovery also failed. Inspect the persisted updating phase. Backup: ', 'Обновяването е неуспешно преди migrations, но runtime възстановяването също е неуспешно. Проверете запазения етап updating. Backup: ']
];

/** Translate manager-owned messages while retaining identifiers, URLs and recovery paths. */
export function translateMessage(locale, message) {
  const cleanup = typeof message === 'string' && /^SQL cleanup incomplete: code=([a-z_]+); database=([a-z_]+); login=([a-z_]+)$/.exec(message);
  if (cleanup) {
    return translate(locale, 'uninstall.failure') + '\n' + translate(locale, 'uninstall.reason.' + cleanup[1])
      + '\n' + translate(locale, 'uninstall.progress', {
        database: translate(locale, 'uninstall.status.' + cleanup[2]),
        login: translate(locale, 'uninstall.status.' + cleanup[3])
      });
  }
  if (typeof message !== 'string' || resolveLocale(locale) === 'en') {
    return message;
  }
  if (Object.hasOwn(bulgarian, message)) {
    return bulgarian[message];
  }
  const archive = /^Archive contains protected runtime data \((application|vendor): (\.env|\.git|node_modules|storage)\)\.$/.exec(message);
  if (archive) {
    return 'Архивът съдържа защитени runtime данни (' + archive[1] + ': ' + archive[2] + '). Release пакетът трябва да бъде коригиран; не е нужна нова SQL база.';
  }
  const docker = /^Docker operation failed: ([a-z]+) \(exit (\d+|timeout); reason ([a-zA-Z]+)(?:; Dockerfile line (\d+))?\)\. Output withheld to protect credentials\.$/.exec(message);
  if (docker) {
    const operations = { build: 'изграждане на образа', start: 'стартиране на контейнерите', bootstrap: 'SQL bootstrap', exec: 'команда в контейнер', status: 'статус', logs: 'логове', run: 'еднократен контейнер', compose: 'Compose', command: 'Docker команда' };
    const reasons = { diskSpace: 'няма свободно дисково пространство', daemon: 'Docker daemon е недостъпен', network: 'мрежа/DNS/TLS', imageMissing: 'липсващ или недостъпен Docker образ', buildTarget: 'липсва Docker build target', dockerfile: 'липсва Dockerfile', buildContext: 'липсва файл в build контекста', portBusy: 'портът е зает', unhealthy: 'контейнерът не е healthy', composeConfig: 'невалидна Compose/env конфигурация', unsupportedOption: 'неподдържана опция', sqlLogin: 'SQL отказва входа', permission: 'отказан достъп', buildStep: 'неуспешна build стъпка', timeout: 'изтекло време', unknown: 'неустановена' };
    if (operations[docker[1]] && reasons[docker[3]]) return 'Docker: ' + operations[docker[1]] + ' — код ' + docker[2] + ', причина: ' + reasons[docker[3]] + (docker[4] ? ', Dockerfile ред ' + docker[4] : '') + '. Изходът е скрит за защита на паролите.';
  }
  for (const [english, localized] of prefixes) {
    if (message.startsWith(english)) {
      return localized + message.slice(english.length);
    }
  }
  if (message.startsWith('Services: ')) {
    return 'Услуги: ' + translate(locale, message.slice(10));
  }
  let match = /^Release endpoint returned HTTP (\d+)\. Artifacts may not be published yet\.$/.exec(message);
  if (match) {
    return 'Release сървърът върна HTTP ' + match[1] + '. Артефактите може още да не са публикувани.';
  }
  match = /^GitHub tag check failed: HTTP (\d+)$/.exec(message);
  if (match) {
    return 'Проверката за нова версия в GitHub е неуспешна: HTTP ' + match[1];
  }
  match = /^Artifact download failed: HTTP (\d+)$/.exec(message);
  if (match) {
    return 'Изтеглянето на артефакта е неуспешно: HTTP ' + match[1];
  }
  match = /^Updated to ([0-9.]+)\. Backup: (.*)$/.exec(message);
  if (match) {
    return 'Обновено до ' + match[1] + '. Backup: ' + match[2];
  }
  match = /^Command failed or timed out: (.*)\. Output withheld to protect credentials\.$/.exec(message);
  if (match) {
    return 'Командата е неуспешна или времето е изтекло: ' + match[1] + '. Изходът е скрит, за да се защитят credentials.';
  }
  match = /^Runtime command failed: (.*) \(exit (\d+)\)\. Check runtime diagnostics; output is withheld to protect credentials\.$/.exec(message);
  if (match) {
    return 'Runtime командата е неуспешна: ' + match[1] + ' (код ' + match[2] + '). Проверете диагностиката; изходът е скрит, за да се защитят credentials.';
  }
  return message;
}
