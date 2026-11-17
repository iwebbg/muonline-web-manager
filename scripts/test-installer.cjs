/** Compile the custom pages against real builder messages in every asynchronous include order. */
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { LangConfigurator, addCustomMessageFileInclude, createAddLangsMacro } = require('app-builder-lib/out/targets/nsis/nsisLang.js');
const { NsisScriptGenerator } = require('app-builder-lib/out/targets/nsis/nsisScriptGenerator.js');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js');

/** Exercise the compiler only: no installer or uninstaller executable is launched. */
async function main() {
  const root = path.resolve(__dirname, '..');
  const options = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).build;
  if (JSON.stringify(options.nsis.installerLanguages) !== JSON.stringify(['en_US', 'bg_BG'])) {
    throw new Error('Update installer-languages.nsh when changing the configured installer languages.');
  }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'muonline-installer-contract-'));
  try {
    let temporary = 0;
    const packager = { getTempFile: async () => path.join(folder, 'messages-' + temporary++ + '.nsh') };
    const languageGenerator = new NsisScriptGenerator();
    createAddLangsMacro(languageGenerator, new LangConfigurator(options.nsis));
    const includes = [];
    const languages = new LangConfigurator(options.nsis);
    for (const file of ['messages.yml', 'assistedMessages.yml']) {
      const generator = new NsisScriptGenerator();
      await addCustomMessageFileInclude(file, packager, generator, languages);
      includes.push(generator.build());
    }
    const custom = '!include "' + path.join(root, 'build/installer.nsh') + '"\n';
    const orders = [[custom, ...includes], [includes[0], custom, includes[1]], [...includes, custom]];
    const compiler = await getMakeNsisPath(options.toolsets?.nsis, options.nsis.customNsisBinary);
    for (const uninstall of [false, true]) {
      for (let order = 0; order < orders.length; order++) {
        const output = path.join(folder, `contract-${uninstall}-${order}.exe`);
        const script = path.join(folder, `contract-${uninstall}-${order}.nsi`);
        const pages = uninstall
          ? '!insertmacro MUI_UNPAGE_INSTFILES'
          : '!insertmacro customWelcomePage\n!insertmacro customPageAfterChangeDir\n!insertmacro MUI_PAGE_INSTFILES\n!insertmacro MUI_PAGE_FINISH';
        const sections = uninstall
          ? 'Section\nWriteUninstaller "$TEMP\\muonline-contract-uninstall.exe"\nSectionEnd\nSection "Uninstall"\nDetailPrint "$(chooseUninstallationOptions)"\nSectionEnd'
          : 'Section\nDetailPrint "$(chooseInstallationOptions)"\nSectionEnd';
        await fs.writeFile(script, `Unicode true\nName "MuOnline installer contract"\nOutFile "${output}"\nRequestExecutionLevel user\n!define PRODUCT_NAME "MuOnline Web Manager"\n${uninstall ? '!define BUILD_UNINSTALLER\n' : ''}!define MULTIUSER_INSTALLMODEPAGE\n${languageGenerator.build()}${orders[order].join('')}!include MUI2.nsh\n${pages}\n!insertmacro addLangs\n!insertmacro customHeader\n${sections}\n`);
        const result = spawnSync(compiler.path, ['-WX', '-INPUTCHARSET', 'UTF8', '-V2', script], { encoding: 'utf8', env: { ...process.env, ...compiler.env }, timeout: 30000 });
        if (result.error || result.status !== 0) {
          throw new Error(`NSIS ${uninstall ? 'uninstaller' : 'installer'} include order ${order} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
        }
      }
    }
    await compileFullTemplates(root, folder, options, compiler, packager);
    console.log('PASS: six EN/BG include-order contracts and both full electron-builder NSIS phases compile with -WX. Full-template checks use fixture payloads; no executable was run.');
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}
/** Compile actual builder templates over stdin, matching its cwd/include resolution on Windows. */
async function compileFullTemplates(root, folder, options, compiler, packager) {
  // Initialize the package entrypoint before importing NsisTarget to avoid internal circular imports.
  require('app-builder-lib');
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js');
  const { CancellationToken } = require('builder-util-runtime');
  packager.config = options;
  packager.info = { buildResourcesDir: path.join(root, 'build'), cancellationToken: new CancellationToken() };
  packager.getResource = async (custom, name) => {
    const candidate = custom ? path.resolve(root, custom) : path.join(root, 'build', name);
    try { await fs.access(candidate); return candidate; } catch { return null; }
  };
  const target = Object.create(NsisTarget.prototype);
  target.packager = packager;
  target.options = options.nsis;
  const header = await target.computeCommonInstallerScriptHeader();
  const templateDirectory = path.dirname(require.resolve('app-builder-lib/templates/nsis/installer.nsi'));
  const template = await fs.readFile(path.join(templateDirectory, 'installer.nsi'), 'utf8');
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const payload = path.join(folder, 'fixture.7z');
  const uninstaller = path.join(folder, 'fixture-uninstaller.exe');
  await fs.writeFile(payload, 'Compile-only payload, never installed.');
  await fs.writeFile(uninstaller, 'Compile-only uninstaller fixture, never executed.');
  for (const uninstall of [true, false]) {
    const defines = {
      APP_ID: options.appId, APP_GUID: 'f6c2fc50-75fa-5282-9b30-9000c3917a09',
      UNINSTALL_APP_KEY: 'f6c2fc50-75fa-5282-9b30-9000c3917a09',
      PRODUCT_NAME: options.productName, PRODUCT_FILENAME: options.productName, APP_FILENAME: options.productName,
      APP_DESCRIPTION: 'NSIS compile-only contract', VERSION: version, PROJECT_DIR: root,
      BUILD_RESOURCES_DIR: path.join(root, 'build'), APP_PACKAGE_NAME: 'muonline-web-manager',
      APP_64: payload, APP_64_NAME: 'fixture.7z', APP_64_HASH: 'A'.repeat(128), APP_64_UNPACKED_SIZE: '1',
      COMPANY_NAME: 'InterWeb', APP_INSTALLER_STORE_FILE: 'muonline-web-manager-updater\\installer.exe',
      COMPRESSION_METHOD: '7z', MULTIUSER_INSTALLMODE_ALLOW_ELEVATION: null, INSTALL_MODE_PER_ALL_USERS_REQUIRED: null,
      allowToChangeInstallationDirectory: null, SHORTCUT_NAME: options.productName,
      UNINSTALL_DISPLAY_NAME: options.productName + ' ' + version, DISPLAY_LANG_SELECTOR: null,
      ESTIMATED_SIZE: '1', COMPRESS: 'auto', UNINSTALLER_OUT_FILE: uninstaller,
      ...(uninstall ? { BUILD_UNINSTALLER: null } : {})
    };
    const definitions = Object.entries(defines).map(([key, value]) => '!define ' + key + (value === null ? '' : ' "' + value + '"')).join('\n');
    const output = path.join(folder, 'full-' + uninstall + '.exe');
    const source = definitions + '\nUnicode true\nOutFile "' + output + '"\n' + header + template;
    const result = spawnSync(compiler.path, ['-WX', '-INPUTCHARSET', 'UTF8', '-V2', '-'], {
      input: source, cwd: templateDirectory, encoding: 'utf8', env: { ...process.env, ...compiler.env }, timeout: 30000
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Full NSIS ${uninstall ? 'uninstaller' : 'installer'} template failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
