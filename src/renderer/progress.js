/** Show measured operation activity without inventing percentages or runtime stages. */
export class OperationProgress {
  constructor() {
    this.dialog = document.querySelector('#operationProgress');
    this.current = null;
    this.dialog.addEventListener('cancel', event => event.preventDefault());
    this.dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    });
  }

  /** Delay short operations to avoid flashing; quiet background refreshes never open a modal. */
  begin(action, label, t, quiet) {
    if (quiet || ['settings', 'setLanguage', 'saveSettings', 'openWebsite', 'openAdmin', 'logs', 'openLogs', 'sqlCopyReport', 'sqlCopyPlan'].includes(action)) return null;
    const key = 'progress.action.' + action;
    const translated = t(key);
    const token = { action, t, started: performance.now(), title: translated === key ? t('progress.action', { action: label }) : translated };
    this.current = token;
    document.querySelector('#progressTitle').textContent = token.title;
    document.querySelector('#progressHint').textContent = t('progress.hint');
    document.querySelector('#progressStep').textContent = t('progress.waiting');
    this.tick();
    token.delay = setTimeout(() => {
      if (this.current !== token) return;
      document.body.classList.add('operation-loading');
      this.dialog.showModal();
      this.dialog.focus();
    }, 180);
    token.timer = setInterval(() => this.tick(), 1000);
    return token;
  }

  /** Display elapsed time independently from backend progress, including during long builds. */
  tick() {
    const token = this.current;
    if (!token) return;
    const seconds = Math.floor((performance.now() - token.started) / 1000);
    const time = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    document.querySelector('#progressElapsed').textContent = token.t('progress.elapsed', { time });
  }

  /** Accept only real setup journal stages received while a setup operation is active. */
  setup(state) {
    const token = this.current;
    if (!token || !['install', 'resumeInstall', 'installWsl', 'installDocker'].includes(token.action)) return;
    const key = 'progress.stage.' + state.stage;
    const label = token.t(key);
    if (label === key) return;
    document.querySelector('#progressStep').textContent = state.status === 'restartRequired'
      ? token.t('progress.restartRequired') : label;
  }

  /** Keep progress visible while the operation's final status/feed refreshes finish. */
  verifying(token) {
    if (token && this.current === token) document.querySelector('#progressStep').textContent = token.t('progress.verifying');
  }

  /** Clear timers and restore interaction; errors move focus to the visible operation result. */
  finish(token, failed) {
    if (token && this.current !== token) return;
    if (token) {
      clearTimeout(token.delay);
      clearInterval(token.timer);
      this.current = null;
      this.dialog.close();
      document.body.classList.remove('operation-loading');
    }
    if (failed) {
      const console = document.querySelector('.console');
      console.classList.add('operation-error');
      console.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      document.querySelector('#output').focus({ preventScroll: true });
    }
  }
}
