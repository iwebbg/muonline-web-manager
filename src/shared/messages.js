import { resolveLocale, translate } from './i18n.js';

/** Known application messages only. Arbitrary logs and SQL diagnostics are not translated. */
const bulgarian = {
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
  "The operation was aborted due to timeout": "Операцията е прекратена поради изтекло време."
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
  if (typeof message !== 'string' || resolveLocale(locale) === 'en') {
    return message;
  }
  if (Object.hasOwn(bulgarian, message)) {
    return bulgarian[message];
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
