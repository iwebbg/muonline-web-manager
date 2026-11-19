/** Terminal setup notices stay separate from the non-dismissible busy overlay. */
export class InstallationOutcome {
  constructor() {
    this.dialog = document.querySelector('#installationOutcome');
    this.kind = null;
    for (const button of this.dialog.querySelectorAll('[data-close-outcome]')) button.addEventListener('click', () => this.close());
    this.dialog.addEventListener('close', () => { this.kind = null; });
  }

  show(kind, t) {
    this.kind = kind;
    this.dialog.dataset.kind = kind;
    document.querySelector('#outcomeIcon').textContent = kind === 'success' ? '✓' : '↻';
    document.querySelector('#outcomeTitle').textContent = t('outcome.' + kind + '.title');
    document.querySelector('#outcomeDescription').textContent = t('outcome.' + kind + '.description');
    document.querySelector('#outcomeContinue').textContent = t(kind === 'success' ? 'outcome.controlPanel' : 'outcome.understood');
    document.querySelector('#outcomeClose').setAttribute('aria-label', t('outcome.close'));
    this.dialog.showModal();
    document.querySelector('#outcomeClose').focus();
  }

  close() {
    const kind = this.kind;
    this.dialog.close();
    if (kind === 'success') document.querySelector('[data-action="openWebsite"]')?.focus();
    else document.querySelector('#resumeInstall')?.focus();
  }
}
