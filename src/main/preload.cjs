const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['openWebsite', 'openAdmin', 'sqlInspect', 'sqlDiagnose', 'sqlPlan', 'sqlApply', 'sqlCopyReport', 'sqlCopyPlan', 'adminList', 'adminUpdate', 'adminDelete', 'settings', 'setLanguage', 'saveSettings', 'prerequisites', 'installWsl', 'installDocker', 'updates', 'install', 'update', 'updateManager', 'status', 'start', 'stop', 'restart', 'logs', 'doctor', 'admin', 'access', 'backup', 'resumeInstall']);
contextBridge.exposeInMainWorld('manager', Object.freeze({
  /** Forward only documented operations; the main process validates the sender again. */
  invoke(action, input = {}) {
    if (!actions.has(action)) {
      return Promise.reject(new Error('Unsupported operation.'));
    }
    return ipcRenderer.invoke('manager:invoke', action, input);
  },
  /** Open one of the build-owned company, support or donation links through the main process. */
  openLink(target) {
    return ipcRenderer.invoke('manager:link', target);
  }
}));
