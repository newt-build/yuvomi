/** Playful shortcut to the canonical profile images of household members. */
import { api } from '/api.js';
import { clearApiCache } from '/sw-register.js';
import { esc } from '/utils/html.js';

export async function render(container, { signal: suppliedSignal, user: currentUser } = {}) {
  const controller = suppliedSignal ? null : new AbortController();
  const signal = suppliedSignal ?? controller.signal;
  let catalogue, selectedUser = null, selectedCharacter = null, busy = false, message = '', operation = null;
  const alive = () => !signal.aborted && container.isConnected;
  function draw() {
    if (!alive()) return;
    const user = catalogue.users.find(value => value.id === selectedUser);
    container.innerHTML = `<section class="settings-section fa"><h2 class="settings-section__title">Avatar</h2>
      <p>Scegli la persona e il personaggio: la sua immagine profilo cambierà in tutta Family.</p>
      <div class="fa__grid" aria-label="Persone">${catalogue.users.map(member => `<button class="fa__choice" type="button" data-user="${member.id}" aria-pressed="${member.id === selectedUser}" ${busy ? 'disabled' : ''}>${member.avatar ? `<img src="${esc(member.avatar)}" alt="">` : '<span class="fa__fallback" aria-hidden="true">●</span>'}<span>${esc(member.label)}</span></button>`).join('')}</div>
      ${user ? `<h3>Personaggio per ${esc(user.label)}</h3><div class="fa__grid" aria-label="Personaggi">${catalogue.characters.map(character => `<button class="fa__choice" type="button" data-character="${esc(character.id)}" aria-pressed="${character.id === selectedCharacter}" ${busy ? 'disabled' : ''}><img src="${esc(character.image)}" alt=""><span>${esc(character.title)}</span></button>`).join('')}</div>
        <button type="button" class="btn btn--primary" data-save ${busy || !selectedCharacter ? 'disabled' : ''}>${busy ? 'Salvo…' : 'Salva avatar'}</button>` : ''}
      ${!catalogue.characters.length ? '<p>Nessun personaggio disponibile nel catalogo.</p>' : ''}
      <p data-feedback role="status"></p></section>`;
    container.querySelector('[data-feedback]').textContent = message;
    container.querySelectorAll('[data-user]').forEach(button => button.addEventListener('click', () => {
      if (busy) return;
      selectedUser = Number(button.dataset.user); selectedCharacter = catalogue.users.find(value => value.id === selectedUser)?.avatarCharacterId;
      operation = null; message = ''; draw();
    }, { signal }));
    container.querySelectorAll('[data-character]').forEach(button => button.addEventListener('click', () => {
      if (busy) return;
      selectedCharacter = button.dataset.character; operation = null; message = ''; draw();
    }, { signal }));
    container.querySelector('[data-save]')?.addEventListener('click', async () => {
      if (busy || !selectedCharacter || !user) return;
      busy = true; message = ''; operation ??= crypto.randomUUID(); draw();
      try {
        const result = await api.put(`/family-avatars/users/${user.id}`, { characterId: selectedCharacter,
          expectedVersion: user.version, expectedAvatarKey: user.avatarKey }, { signal, headers: { 'Idempotency-Key': operation } });
        if (!alive()) return;
        catalogue.users = catalogue.users.map(value => value.id === user.id ? result.user : value);
        selectedCharacter = result.user.avatarCharacterId; operation = null; message = 'Avatar salvato.';
        // Other pages read the same users.avatar_data/key, not a second avatar store.
        if (currentUser?.id === user.id) window.dispatchEvent(new CustomEvent('yuvomi:profile-changed', { detail: { avatar_data: result.user.avatar } }));
        try { await clearApiCache(); }
        catch { message = 'Avatar salvato. Le altre viste potrebbero richiedere una ricarica.'; }
      } catch (error) {
        if (!alive()) return;
        message = error.message || 'Salvataggio non confermato.';
        if (error.status === 409) {
          try { catalogue = await api.get('/family-avatars', { signal }); selectedCharacter = catalogue.users.find(value => value.id === selectedUser)?.avatarCharacterId; operation = null; }
          catch { message += ' Rilettura non riuscita: riprova.'; }
        }
      } finally { busy = false; if (alive()) draw(); }
    }, { signal });
  }
  try { catalogue = await api.get('/family-avatars', { signal }); draw(); }
  catch (error) { if (alive()) { const notice = document.createElement('p'); notice.setAttribute('role', 'alert'); notice.textContent = error.message || 'Catalogo avatar non disponibile.'; container.replaceChildren(notice); } }
  return () => controller?.abort();
}
