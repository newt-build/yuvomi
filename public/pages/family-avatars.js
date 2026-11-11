/** The kiosk gets only the Avatar shortcut, not the general settings navigation. */
import { render as renderAvatars } from '/settings/pages/family-avatars.js';
import { render as renderSettings } from '/pages/settings.js';
import { renderAppPage } from '/utils/page-layout.js';

export async function render(container, context) {
  if (context.user?.access_scope !== 'display') return renderSettings(container, context);
  container.innerHTML = renderAppPage({ mode: 'data',
    header: '<div class="page-toolbar"><h1 class="page-toolbar__title">Impostazioni · Avatar</h1></div>',
    body: '<div class="app-page__body"><section class="page-section" data-avatar-root></section></div>',
  });
  return renderAvatars(container.querySelector('[data-avatar-root]'), context);
}
