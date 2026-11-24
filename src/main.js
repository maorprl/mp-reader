import ePub from 'epubjs';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {allBooks,getBook,saveBook,removeBook} from './db.js';
import {attachReaderTools, defaultLayout, setReaderLayout} from './reader-tools.js';
import {setupSync, showPairingScreen, syncBook, isPaired, readCatalog, uploadBook, downloadBook, identify, localLibrary} from './sync.js';
import './style.css';
pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const app=document.querySelector('#app');
const state={books:[],book:null,epub:null,rendition:null,pdf:null,page:1,zoom:1.2,font:105,night:false,token:0};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function message(t){const m=document.querySelector('#notice');if(m){m.textContent=t;m.hidden=false;setTimeout(()=>{if(m.textContent===t)m.hidden=true},4000);}else alert(t);}
let libraryRequest = 0;
async function refresh() {
  const request = ++libraryRequest;
  if (!isPaired()) {
    state.books = [];
    showPairingScreen(app, refresh);
    return;
  }
  const books = (await allBooks()).sort((a,b)=>b.addedAt-a.addedAt);
  if (request !== libraryRequest || state.book || !isPaired()) return;
  state.books = books;
  library();
  if (!isPaired()) return;
  try {
    const {books: remote} = await readCatalog();
    const known = new Set();
    for (const book of books) {
      if (book.type === 'epub') known.add(await identify(book));
    }
    if (request !== libraryRequest || state.book || !isPaired()) return;
    state.books = books.concat(remote.filter(entry => !known.has(entry.book)).map(entry => ({
      ...entry, id: entry.book, type: 'epub', progress: 'זמין להורדה', remote: true,
    })));
    library();
  } catch (error) {
    console.error(error);
    if (request === libraryRequest && !state.book) message('ספריית הענן לא זמינה כרגע.');
  }
}

async function openLibraryBook(button) {
  const entry = state.books.find(book => book.id === button.dataset.open);
  if (!entry?.remote) return openBook(button.dataset.open);
  const scope = localLibrary();
  button.disabled = true;
  try {
    const book = await downloadBook(entry);
    if (scope !== localLibrary()) return;
    await saveBook(book);
    await openBook(book.id);
  } catch (error) {
    console.error(error);
    message('הורדת הספר נכשלה.');
  } finally {
    button.disabled = false;
  }
}

async function shareLibrary(button) {
  button.disabled = true;
  try {
    const {books: remote} = await readCatalog();
    const existing = new Set(remote.map(entry => entry.book));
    let skipped = 0;
    for (const book of await allBooks()) {
      if (book.type !== 'epub') continue;
      const hash = await identify(book);
      if (!existing.has(hash)) {
        if (book.file.size > 25 * 1024 * 1024) {
          skipped++;
          continue;
        }
        await uploadBook(book);
        existing.add(hash);
      }
      await syncBook(book, saveBook);
    }
    await refresh();
    message(skipped ? 'הספרייה סונכרנה. ספרים מעל 25 MB נשארו במכשיר.' : 'הספרייה סונכרנה.');
  } catch (error) {
    console.error(error);
    message('סנכרון הספרייה נכשל. אפשר לנסות שוב.');
  } finally {
    button.disabled = false;
  }
}

function library(){document.title='mp-reader · הספרייה';app.innerHTML=`
<header class="top"><div class="brand">📖 mp-reader</div><button id="sync-devices" type="button">סנכרון מכשירים</button></header>
<main class="library"><div class="hero"><h1>הספרייה שלי</h1></div>
<div class="actions">${isPaired() ? '<button type="button" id="share-library">סנכרן ספרים</button>' : ''}<h2>הספרים שלי <small>(${state.books.length})</small></h2><label class="primary">＋ הוספת ספרים<input id="pick" type="file" accept=".epub,.pdf" multiple hidden></label></div>
<div class="grid">${state.books.map(b=>`<article class="tile"><button class="cover" data-open="${esc(b.id)}"><span class="cover-icon">${b.type==='pdf'?'PDF':'EPUB'}</span><strong>${esc(b.title)}</strong></button><div class="tile-foot"><button class="book-name" data-open="${esc(b.id)}">${esc(b.title)}</button><small>${esc(b.progress||'טרם נקרא')}</small>${b.remote ? '' : `<button class="delete" data-delete="${esc(b.id)}" aria-label="מחק עותק מקומי">🗑</button>`}</div></article>`).join('')}</div>
${state.books.length?'':'<div class="empty">אין עדיין ספרים.</div>'}
</main><div id="notice" class="notice" hidden></div>`;
setupSync(app.querySelector('#sync-devices'), refresh);
const share = app.querySelector('#share-library');
if (share) share.onclick = () => shareLibrary(share);
app.querySelector('#pick').onchange=async event => {
  let uploadFailed = false;
  let duplicate = false;
  for (const file of event.target.files) {
    try {
      const {id, exists} = await importBook(file);
      duplicate ||= Boolean(exists);
      if (id && !exists && isPaired() && /\.epub$/i.test(file.name)) {
        try { await uploadBook(await getBook(id)); }
        catch (error) { console.error(error); uploadFailed = true; }
      }
    } catch (error) {
      console.error(error);
      message('שמירת הקובץ נכשלה. בדוק מקום פנוי.');
    }
  }
  await refresh();
  if (uploadFailed) message('הספר נשמר במכשיר. ההעלאה לענן לא הושלמה.');
  else if (duplicate) message('הקובץ כבר נמצא בספרייה.');
};
app.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openLibraryBook(b));
app.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const book=state.books.find(x=>x.id===b.dataset.delete);if(book&&confirm('למחוק את "'+book.title+'"?')){await removeBook(book.id);await refresh();}});
}
let importQueue = Promise.resolve();
function importBook(file) {
  const scope = localLibrary();
  const run = importQueue.catch(() => {}).then(async () => {
    if (!scope || scope !== localLibrary()) return {};
    const extension = file.name.split('.').pop().toLowerCase();
    if (!['epub', 'pdf'].includes(extension)) return {};
    const book = {id: crypto.randomUUID(), type: extension, title: file.name.replace(/\.(epub|pdf)$/i, ''),
      file, localLibrary: scope, addedAt: Date.now(), location: null, progress: null};
    const hash = await identify(book);
    for (const existing of await allBooks()) {
      if (existing.file.size === file.size && await identify(existing) === hash) {
        return {id: existing.id, exists: true};
      }
    }
    if (extension === 'epub') {
      const catalog = await readCatalog().catch(() => null);
      if (catalog?.books.some(entry => entry.book === hash)) return {exists: true};
    }
    await saveBook(book);
    return {id: book.id};
  });
  importQueue = run;
  return run;
}

window.addEventListener('mp-reader-import', async event => {
  if (location.hostname !== 'reader.mpreader.invalid') return;
  if (!isPaired()) return;
  const {url, name} = event.detail;
  if (!/^\/import\/[a-f0-9-]+$/.test(url)) return;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not read the selected EPUB');
    const filename = /\.epub$/i.test(name) ? name : name + '.epub';
    const file = new File([await response.blob()], filename, {type: 'application/epub+zip', lastModified: 0});
    const {id, exists} = await importBook(file);
    if (!id && exists) {
      await refresh();
      message('הקובץ כבר נמצא בספרייה.');
      return;
    }
    if (id && !exists) await uploadBook(await getBook(id)).catch(console.error);
    if (id) await openBook(id);
  } catch (error) {
    console.error(error);
    message('לא ניתן לפתוח את קובץ ה־EPUB.');
  }
});

const readerLabels = {
  he: {
    back: '↩ לספרייה', toc: 'תוכן עניינים', previous: 'הקודם', next: 'הבא',
    close: 'סגור ✕', loading: 'טוען…', position: 'מחשב התקדמות…',
    bookProgress: percent => 'התקדמות בספר: ' + percent + '%',
    smaller: 'הקטנת גופן', larger: 'הגדלת גופן', theme: 'שינוי ערכת צבעים',
    openError: 'לא ניתן לפתוח את הספר. ייתכן שהקובץ פגום או מוגן.',
    errorNotice: 'אירעה שגיאה בפתיחת הספר',
  },
  en: {
    back: '↩ Library', toc: 'Table of contents', previous: 'Previous', next: 'Next',
    close: 'Close ✕', loading: 'Loading…', position: 'Calculating progress…',
    bookProgress: percent => 'Book progress: ' + percent + '%',
    smaller: 'Decrease font size', larger: 'Increase font size', theme: 'Toggle color theme',
    openError: 'Could not open this book. The file may be damaged or protected.',
    errorNotice: 'An error occurred while opening the book.',
  },
};

async function getReaderLanguage(epub) {
  const language = epub.packaging?.metadata?.language?.trim().toLowerCase().split(/[-_]/)[0];
  if (language === 'en') return 'en';
  if (language === 'he' || language === 'iw') return 'he';

  const section = epub.spine.first();
  if (section) {
    try {
      await section.load(epub.load.bind(epub));
      const sample = section.document?.querySelector('body')?.textContent.slice(0, 6000) ?? '';
      const hebrewLetters = sample.match(/[א-ת]/g)?.length ?? 0;
      const latinLetters = sample.match(/[a-z]/gi)?.length ?? 0;
      if (hebrewLetters || latinLetters) return latinLetters > hebrewLetters ? 'en' : 'he';
    } catch {
      // Let the renderer handle unreadable sections when opening the book.
    }
  }
  return /[א-ת]/.test(epub.packaging?.metadata?.title ?? '') ? 'he' : 'en';
}

function shell(book, language = 'he'){const labels = readerLabels[language];app.innerHTML=`<div class="reader ${book.type === 'epub' ? 'reading-clean' : ''}" lang="${language}" dir="${language === 'en' ? 'ltr' : 'rtl'}"><header class="reading-top"><button id="back">${labels.back}</button><strong dir="auto">${esc(book.title)}</strong><button id="toc" ${book.type==='pdf'?'hidden':''}>${labels.toc}</button></header>
<div class="stage ${state.night?'night':''}"><div id="viewport" class="viewport">${labels.loading}</div></div>
<footer class="controls" ${book.type === 'epub' ? 'aria-describedby="position"' : ''}><div class="nav"><button id="prev" aria-label="${labels.previous}">${labels.previous}</button>${book.type === 'epub' ? '' : '<span id="position">—</span>'}<button id="next" aria-label="${labels.next}">${labels.next}</button></div><div class="settings"><div class="appearance-controls"><button id="smaller" ${book.type === 'epub' ? `aria-label="${labels.smaller}"` : ''}>−</button><span id="size-label"></span><button id="larger" ${book.type === 'epub' ? `aria-label="${labels.larger}"` : ''}>＋</button><button id="theme" aria-label="${labels.theme}" ${book.type==='pdf'?'hidden':''}>◐</button></div></div>${book.type === 'epub' ? `<div id="position" class="epub-progress"><span class="progress-summary" dir="ltr">—</span></div>` : ''}</footer>
<aside class="toc-panel" id="toc-panel" hidden><button id="close-toc">${labels.close}</button><h3>${labels.toc}</h3><div id="toc-list"></div></aside>
</div><div id="notice" class="notice" hidden></div>`;
app.querySelector('#back').onclick=closeBook;
app.querySelector('#prev').onclick=()=>navigate(-1);app.querySelector('#next').onclick=()=>navigate(1);
app.querySelector('#smaller').onclick=()=>changeSize(-1);app.querySelector('#larger').onclick=()=>changeSize(1);
app.querySelector('#size-label').textContent=book.type==='pdf'?Math.round(state.zoom*100)+'%':state.font+'%';
if(book.type==='epub'){app.querySelector('#theme').onclick=()=>{state.night=!state.night;app.querySelector('.stage').classList.toggle('night',state.night);state.rendition?.themes.select(state.night?'night':'paper');};app.querySelector('#toc').onclick=()=>app.querySelector('#toc-panel').hidden=false;app.querySelector('#close-toc').onclick=()=>app.querySelector('#toc-panel').hidden=true;}
}
async function openBook(id){if (!isPaired()) return;await destroy();const book=await getBook(id);if(!book)return;state.book=book;const token=++state.token;let labels=readerLabels.he;shell(book);try{await syncBook(book, saveBook).catch(console.error);if(state.token!==token)return;if(book.type==='pdf'){const buffer=await book.file.arrayBuffer();state.pdf=await pdfjs.getDocument({data:new Uint8Array(buffer)}).promise;if(state.token!==token)return;state.page=Math.max(1,Math.min(state.pdf.numPages,Number(book.location)||1));await drawPdf();}else{const data=await book.file.arrayBuffer();state.epub=ePub(data);await state.epub.ready;if(state.token!==token)return;
const language = await getReaderLanguage(state.epub);
if (state.token !== token) return;
labels = readerLabels[language];
shell(book, language);
const view = app.querySelector('#viewport');
view.replaceChildren();
const direction = state.epub.packaging?.metadata?.direction === 'rtl' ||
  (!state.epub.packaging?.metadata?.direction && language === 'he') ? 'rtl' : 'ltr';
setReaderLayout(app.querySelector('.stage'), {...defaultLayout, ...book.layout});
state.rendition = state.epub.renderTo(view, {width:'100%', height:'100%', flow:'paginated',
  spread:'none', defaultDirection:direction});state.rendition.themes.register('paper',{body:{background:'#fffdf7 !important',color:'#302c28 !important'}});state.rendition.themes.register('night',{body:{background:'#20252b !important',color:'#f0eeee !important'}});state.rendition.themes.select(state.night?'night':'paper');state.rendition.themes.fontSize(state.font+'%');const progress = trackEpubProgress(state.epub, state.rendition, book, labels, token);
state.epubProgress = progress;
state.readerTools = new AbortController();
const tools = attachReaderTools({root: app, book, rendition: state.rendition, language,
  direction: state.epub.packaging?.metadata?.direction || direction, progress, navigate, changeSize,
  persist: () => saveReadingState(book), signal: state.readerTools.signal});
const displayed = state.rendition.display(book.location || undefined);
progress.indexed = displayed.then(() => {
  if (state.token === token) return progress.index();
}, () => {});
await displayed;
if (state.token === token) watchReadingState(book, state.rendition, progress, tools, state.readerTools.signal);
if(state.token!==token)return;const navigation=await state.epub.loaded.navigation;if(state.token!==token)return;const toc=app.querySelector('#toc-list');toc.replaceChildren();for(const item of navigation.toc||[]){const b=document.createElement('button');b.textContent=item.label;b.dir='auto';b.style.textAlign='start';b.onclick=async()=>{if (state.epubProgress.resizing) return;app.querySelector('#toc-panel').hidden=true;state.epubProgress.anchor = null;await state.rendition.display(item.href);};toc.append(b);}}}catch(err){if(state.token!==token)return;console.error(err);app.querySelector('#viewport').textContent=labels.openError;message(labels.errorNotice);}}
function watchReadingState(book, rendition, progress, tools, signal) {
  let running = false;
  const canApply = () => !signal.aborted && !progress.resizing && !progress.navigating && Boolean(progress.anchor) && tools.canRefresh();
  async function refreshOpenBook() {
    if (running || document.visibilityState === 'hidden' || !canApply()) return;
    running = true;
    try {
      await syncBook(book, async updated => {
        const moved = updated.location && updated.location !== progress.anchor;
        if (moved) progress.anchor = updated.location;
        await saveBook(updated);
        if (signal.aborted) return;
        tools.refresh();
        if (moved && progress.anchor === updated.location) await rendition.display(updated.location);
      }, canApply);
    } catch (error) {
      if (!signal.aborted) console.error(error);
    } finally {
      running = false;
    }
  }
  const timer = setInterval(refreshOpenBook, 7000);
  signal.addEventListener('abort', () => clearInterval(timer), {once:true});
  window.addEventListener('focus', refreshOpenBook, {signal});
  window.addEventListener('online', refreshOpenBook, {signal});
  document.addEventListener('visibilitychange', refreshOpenBook, {signal});
}

async function saveReadingState(book) {
  await saveBook(book);
  syncBook(book).catch(console.error);
}

function trackEpubProgress(epub, rendition, book, labels, token) {
  const progress = {anchor: book.location, resizing: false};
  const summary = app.querySelector('.progress-summary');
  let location;
  let locationCount = 0;

  function update() {
    if (!location?.start || token !== state.token) return;
    const {cfi, displayed} = location.start;
    const anchor = progress.anchor || cfi;
    const page = displayed.page > 0 && displayed.total > 0
      ? displayed.page + ' / ' + displayed.total : '—';
    const percent = locationCount > 0
      ? Math.round(100 * epub.locations.locationFromCfi(anchor) / Math.max(1, locationCount - 1))
      : null;
    summary.textContent = percent === null ? page : page + ' · ' + percent + '%';
    summary.setAttribute('aria-label', percent === null ? page : page + ' · ' + labels.bookProgress(percent));
  }

  rendition.on('relocated', current => {
    if (token !== state.token || progress.resizing) return;
    location = current;
    progress.anchor ??= current.start.cfi;
    book.location = progress.anchor;
    book.progress = 'בקריאה';
    update();
    saveReadingState(book).catch(console.error);
  });

  progress.index = async () => {
    try {
      const locations = await epub.locations.generate(200);
      if (token !== state.token) return;
      locationCount = locations.length;
    } catch (error) {
      if (token === state.token) console.error(error);
    }
    if (token !== state.token) return;
    update();
  };

  progress.reflow = async (font, viewport) => {
    if (progress.resizing || !location) return;
    progress.resizing = true;
    try {
      const anchor = progress.anchor || location.start.cfi;
      if (font !== null) rendition.themes.fontSize(font + '%');
      if (viewport) rendition.resize(viewport.clientWidth, viewport.clientHeight, anchor);
      rendition.clear();
      await rendition.display(anchor);
      if (token !== state.token) return;
      location = rendition.currentLocation();
      update();
    } finally {
      progress.resizing = false;
    }
  };
  return progress;
}

async function drawPdf(){if(!state.pdf||!state.book)return;const token=state.token;const pageNumber=state.page;const page=await state.pdf.getPage(pageNumber);if(token!==state.token||pageNumber!==state.page)return;const scale=state.zoom;const viewport=page.getViewport({scale});const canvas=document.createElement('canvas');const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.ceil(viewport.width*dpr);canvas.height=Math.ceil(viewport.height*dpr);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';const context=canvas.getContext('2d');await page.render({canvasContext:context,viewport,transform:dpr!==1?[dpr,0,0,dpr,0,0]:undefined}).promise;if(token!==state.token||pageNumber!==state.page)return;const target=app.querySelector('#viewport');target.replaceChildren(canvas);target.classList.add('pdf');app.querySelector('#position').textContent=pageNumber+' / '+state.pdf.numPages;state.book.location=pageNumber;state.book.progress='עמוד '+pageNumber+' מתוך '+state.pdf.numPages;await saveBook(state.book);}
async function navigate(n) {
  if (state.pdf) {
    state.page = Math.max(1, Math.min(state.pdf.numPages, state.page + n));
    await drawPdf();
    return;
  }
  const {rendition, epub, epubProgress: progress} = state;
  if (!rendition || !progress || progress.resizing || progress.navigating) return;

  const current = rendition.currentLocation()?.start;
  let nextSection;
  // In RTL the renderer can try to scroll past the last column of a section.
  if (n > 0 && current?.displayed?.total > 0 && current.displayed.page >= current.displayed.total) {
    nextSection = epub.spine.get(current.index)?.next();
    if (!nextSection) return;
  }

  progress.navigating = true;
  progress.anchor = null;
  try {
    if (nextSection) await rendition.display(nextSection.href);
    else if (n > 0) await rendition.next();
    else await rendition.prev();
  } finally {
    progress.navigating = false;
  }
}
async function changeSize(n){if(state.pdf){state.zoom=Math.max(.5,Math.min(3,state.zoom+n*.2));app.querySelector('#size-label').textContent=Math.round(state.zoom*100)+'%';await drawPdf();}else if (state.epubProgress && !state.epubProgress.resizing) {
  const font = Math.max(70, Math.min(200, state.font + n * 10));
  if (font === state.font) return;
  state.font = font;
  app.querySelector('#size-label').textContent = font + '%';
  try {
    await state.epubProgress.reflow(font);
  } catch (error) {
    console.error(error);
  }
}}
async function destroy(){state.token++;state.readerTools?.abort();state.readerTools=null;try{state.rendition?.destroy();}catch{}try{state.epub?.destroy();}catch{}try{await state.pdf?.destroy();}catch{}state.rendition=null;state.epubProgress=null;state.epub=null;state.pdf=null;state.book=null;}
async function closeBook(){await destroy();await refresh();}
refresh().catch(err=>{console.error(err);app.textContent='לא ניתן לפתוח את הספרייה המקומית בדפדפן הזה.';});

window.addEventListener('focus', () => {
  if (isPaired() && !state.book && !document.querySelector('dialog[open]')) refresh().catch(console.error);
});
