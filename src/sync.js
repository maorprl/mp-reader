const endpoint = 'https://lucky-unit-12e9.maorperlov.workers.dev';
const tokenKey = 'mp-reader-sync-token';
const scopeKey = 'mp-reader-local-library';
const initialToken = localStorage.getItem(tokenKey);
if (initialToken && !localStorage.getItem(scopeKey)) {
  localStorage.setItem(scopeKey, 'legacy');
}

export function localLibrary() {
  return isPaired() ? localStorage.getItem(scopeKey) : null;
}

const fields = ['location', 'bookmarks', 'highlights'];
const pending = new Map();

async function call(path, payload, token = localStorage.getItem(tokenKey)) {
  const response = await fetch(endpoint + path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})},
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Sync failed (' + response.status + ')');
  return response.json();
}

async function identify(book) {
  if (book.syncHash) return book.syncHash;
  const hash = await crypto.subtle.digest('SHA-256', await book.file.arrayBuffer());
  book.syncHash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  return book.syncHash;
}

export async function syncBook(book, persist) {
  if (book.localLibrary && book.localLibrary !== localLibrary()) return;
  const token = localStorage.getItem(tokenKey);
  if (!token || book.type !== 'epub') return;
  const hash = await identify(book);
  const key = 'mp-reader-sync:' + token + ':' + hash;
  const earlier = pending.get(key) ?? Promise.resolve();
  const next = earlier.catch(() => {}).then(async () => {
    if (localStorage.getItem(tokenKey) !== token) return;
    const baseline = JSON.parse(localStorage.getItem(key) || '{}');
    const snapshot = Object.fromEntries(fields.map(field => [field, book[field] ?? (field === 'location' ? null : [])]));
    const changes = {};
    for (const field of fields) {
      const value = snapshot[field];
      if (baseline[field] ? JSON.stringify(value) !== JSON.stringify(baseline[field].value) :
          (Array.isArray(value) ? value.length : value != null)) {
        changes[field] = {value, base: baseline[field]?.rev ?? 0};
      }
    }
    const {fields: remote} = await call('/book', {book: hash, changes}, token);
    if (localStorage.getItem(tokenKey) !== token) return;
    let changed = false;
    for (const field of fields) {
      if (!remote[field]) continue;
      const current = book[field] ?? (field === 'location' ? null : []);
      if (JSON.stringify(current) !== JSON.stringify(snapshot[field])) continue;
      if (JSON.stringify(snapshot[field]) === JSON.stringify(remote[field].value)) continue;
      // Keep active reader state stable. Pull remote changes on the next open.
      if (!persist) continue;
      if (Array.isArray(book[field])) book[field].splice(0, book[field].length, ...remote[field].value);
      else book[field] = remote[field].value;
      changed = true;
    }
    if (changed) await persist(book);
    const acknowledged = Object.fromEntries(fields.flatMap(field => {
      if (!remote[field]) return [];
      if (persist || JSON.stringify(snapshot[field]) === JSON.stringify(remote[field].value)) return [[field, remote[field]]];
      return baseline[field] ? [[field, baseline[field]]] : [];
    }));
    localStorage.setItem(key, JSON.stringify(acknowledged));
  });
  pending.set(key, next);
  try {
    await next;
  } finally {
    if (pending.get(key) === next) pending.delete(key);
  }
}

export function showPairingScreen(root, onConnectionChange) {
  root.innerHTML = `<main class="library pairing-screen">
    <h1>mp-reader</h1>
    <h2>חיבור לספרייה</h2>
    <div data-choices>
      <button type="button" data-request>הצטרף לספרייה קיימת</button>
      <button type="button" data-create>צור ספרייה חדשה</button>
    </div>
    <output dir="ltr" data-code aria-live="polite"></output>
    <p role="status"></p>
    <button type="button" data-cancel hidden>חזרה</button>
  </main>`;
  const status = root.querySelector('[role=status]');
  const choices = root.querySelector('[data-choices]');
  const buttons = choices.querySelectorAll('button');
  const requestButton = root.querySelector('[data-request]');
  const cancel = root.querySelector('[data-cancel]');
  const output = root.querySelector('[data-code]');
  let requestAttempt = 0;
  function showChoices() {
    ++requestAttempt;
    choices.hidden = false;
    cancel.hidden = true;
    output.textContent = '';
    requestButton.disabled = false;
  }
  cancel.onclick = () => {
    showChoices();
    status.textContent = '';
  };
  requestButton.onclick = async () => {
    const attempt = ++requestAttempt;
    const proof = crypto.randomUUID().replaceAll('-', '');
    choices.hidden = true;
    cancel.hidden = false;
    status.textContent = 'מבקש קוד צימוד…';
    try {
      const {code} = await call('/device-request', {proof});
      if (!output.isConnected || attempt !== requestAttempt) return;
      output.textContent = code;
      status.textContent = 'במחשב או בטלפון שכבר מחובר, פתח „סנכרון מכשירים”, הזן את הקוד ולחץ „אשר צימוד”.';
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (!output.isConnected || attempt !== requestAttempt || isPaired()) return;
        let result;
        try { result = await call('/device-status', {proof}); }
        catch (error) {
          if (error.message.includes('(404)')) break;
          continue;
        }
        if (!output.isConnected || attempt !== requestAttempt || isPaired()) return;
        if (result.approved) {
          localStorage.setItem(scopeKey, crypto.randomUUID());
          localStorage.setItem(tokenKey, proof);
          await onConnectionChange();
          return;
        }
      }
      if (attempt === requestAttempt) {
        showChoices();
        status.textContent = 'תוקף הקוד פג. אפשר להציג קוד חדש.';
      }
    } catch (error) {
      console.error(error);
      if (attempt === requestAttempt) {
        showChoices();
        status.textContent = 'לא ניתן להציג קוד כרגע.';
      }
    }
  };
  async function createLibrary() {
    if (buttons[0].disabled || isPaired()) return;
    ++requestAttempt;
    output.textContent = '';
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = 'מתחבר…';
    try {
      const {token} = await call('/create');
      localStorage.setItem(scopeKey, crypto.randomUUID());
      localStorage.setItem(tokenKey, token);
      await onConnectionChange();
    } catch (error) {
      console.error(error);
      status.textContent = 'יצירת הספרייה נכשלה. בדוק את החיבור לאינטרנט.';
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  }
  root.querySelector('[data-create]').onclick = createLibrary;
}

export function setupSync(button, onConnectionChange) {
  button.textContent = 'המכשיר מצומד · סנכרון מכשירים';
  button.onclick = () => {
    const panel = document.createElement('dialog');
    panel.dir = 'rtl';
    panel.innerHTML = `<h2>סנכרון מכשירים</h2>
      <form data-approve><label>הוסף מכשיר לפי הקוד שמופיע עליו
        <input name="code" dir="ltr" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required>
      </label><button>אשר צימוד</button></form>
      <button type="button" data-disconnect>נתק מכשיר</button>
      <p role="status"></p>
      <button type="button" data-close>סגור</button>`;
    document.body.append(panel);
    const status = panel.querySelector('[role=status]');
    const disconnect = panel.querySelector('[data-disconnect]');
    const approval = panel.querySelector('[data-approve]');
    approval.onsubmit = async event => {
      event.preventDefault();
      const submit = approval.querySelector('button');
      submit.disabled = disconnect.disabled = true;
      try {
        await call('/device-approve', {code:approval.elements.code.value});
        approval.reset();
        status.textContent = 'המכשיר אושר. הספרייה תיפתח בו בעוד כמה שניות.';
      } catch {
        status.textContent = 'הקוד לא נמצא או פג. בדוק את הקוד במכשיר שמצטרף.';
      } finally {
        submit.disabled = disconnect.disabled = false;
      }
    };
    disconnect.onclick = () => {
      if (!window.confirm('לנתק את המכשיר? לחיבור מחדש לספרייה הזו צריך קוד ממכשיר מצומד אחר.')) return;
      localStorage.removeItem(tokenKey);
      localStorage.removeItem(scopeKey);
      panel.close();
      onConnectionChange().catch(console.error);
    };
    panel.querySelector('[data-close]').onclick = () => panel.close();
    panel.addEventListener('close', () => panel.remove(), {once: true});
    panel.showModal();
  };
}

const chunkSize = 384000;
const maxBookSize = 25 * 1024 * 1024;

export function isPaired() {
  return Boolean(localStorage.getItem(tokenKey));
}

export function readCatalog() {
  return call('/catalog');
}

export async function uploadBook(book) {
  if (!book || book.localLibrary !== localLibrary()) throw new Error('Library changed');
  if (book.file.size > maxBookSize) throw new Error('book-size');
  const token = localStorage.getItem(tokenKey);
  const hash = await identify(book);
  for (let start = 0; start < book.file.size; start += chunkSize) {
    const bytes = new Uint8Array(await book.file.slice(start, start + chunkSize).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (token !== localStorage.getItem(tokenKey)) throw new Error('Device disconnected');
    await call('/upload', {book: hash, index: start / chunkSize, data: btoa(binary)}, token);
  }
  if (token !== localStorage.getItem(tokenKey)) throw new Error('Device disconnected');
  await call('/publish', {book: hash, size: book.file.size, title: book.title.slice(0, 300)}, token);
}

export async function downloadBook(entry) {
  const chunks = [];
  for (let start = 0; start < entry.size; start += chunkSize) {
    const {data} = await call('/download', {book: entry.book, index: start / chunkSize});
    chunks.push(Uint8Array.from(atob(data), value => value.charCodeAt(0)));
  }
  const file = new File(chunks, entry.title + '.epub', {type:'application/epub+zip'});
  const book = {id:crypto.randomUUID(), type:'epub', title:entry.title, file, addedAt:Date.now()};
  if (file.size !== entry.size || await identify(book) !== entry.book) {
    throw new Error('EPUB verification failed');
  }
  return book;
}

export {identify};
