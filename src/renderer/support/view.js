import { externalLinks } from '../../shared/links.js';

/** Render application-owned support content; no logs or credentials are attached to external links. */
export function supportPage(t) {
  return `<h1>${t('support.title')}</h1><p class="lead">${t('support.lead')}</p>
    <div class="support-channels">
      <article class="panel support-card"><span class="support-icon" aria-hidden="true">GH</span><h2>${t('support.report')}</h2><p>${t('support.reportHint')}</p><div class="actions"><a class="button primary" href="${externalLinks.issue}">${t('support.openIssue')} ↗</a><a class="button" href="${externalLinks.repository}">${t('support.repository')} ↗</a></div></article>
      <article class="panel support-card"><span class="support-icon" aria-hidden="true">@</span><h2>${t('support.email')}</h2><p>${t('support.emailHint')}</p><div class="actions"><a class="button" href="${externalLinks.email}">${t('support.contact')} ↗</a></div><a href="${externalLinks.email}">office@interweb.bg</a></article>
    </div>
    <section class="panel support-section"><h2>${t('support.beforeReporting')}</h2><p>${t('support.details')}</p><p class="hint">${t('support.privacy')}</p><button type="button" data-open-page="sql">${t('support.diagnostics')}</button></section>
    <section class="panel support-section"><h2>${t('support.donate')}</h2><p>${t('support.donateHint')}</p><div class="support-donations">
      <a class="donation-option" href="${externalLinks.coffee}"><span class="support-icon" aria-hidden="true">B</span><span><strong>Buy Me a Coffee</strong><small>${t('support.oneTime')}</small></span><b aria-hidden="true">↗</b></a>
      <a class="donation-option" href="${externalLinks.kofi}"><span class="support-icon" aria-hidden="true">K</span><span><strong>Ko-fi</strong><small>${t('support.coffee')}</small></span><b aria-hidden="true">↗</b></a>
      <a class="donation-option" href="${externalLinks.paypal}"><span class="support-icon" aria-hidden="true">P</span><span><strong>PayPal</strong><small>${t('support.paypal')}</small></span><b aria-hidden="true">↗</b></a>
    </div><p class="hint">${t('support.paymentNotice')}</p></section>`;
}
