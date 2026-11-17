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
        await fs.writeFile(script, `Unicode true\nName "MuOnline installer contract"\nOutFile "${output}"\nRequestExecutionLevel user\n!define PRODUCT_NAME "MuOnline Web Manager"\n${uninstall ? '!define BUILD_UNINSTALLER\n' : ''}!include MUI2.nsh\n!define MULTIUSER_INSTALLMODEPAGE\n${languageGenerator.build()}${orders[order].join('')}${pages}\n!insertmacro addLangs\n!insertmacro customHeader\n${sections}\n`);
        const result = spawnSync(compiler.path, ['-WX', '-INPUTCHARSET', 'UTF8', '-V2', script], { encoding: 'utf8', env: { ...process.env, ...compiler.env }, timeout: 30000 });
        if (result.error || result.status !== 0) {
          throw new Error(`NSIS ${uninstall ? 'uninstaller' : 'installer'} include order ${order} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
        }
      }
    }
    console.log('PASS: installer/uninstaller EN/BG custom and standard MultiUser language messages compile with -WX in all three generated-message include orders. No executable was run.');
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
