import {readerVersion} from './version.js';
import ePub from 'epubjs';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {allBooks,getBook,saveBook,removeBook} from './db.js';
import {attachReaderTools, defaultLayout, setReaderLayout} from './reader-tools.js';
import {setupSync, showPairingScreen, syncBook, isPaired, readCatalog, uploadBook, downloadBook, identify, localLibrary} from './sync.js';
import {readingPageOffset, textLineAt} from './reading-page.js';
import './style.css';
pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const app=document.querySelector('#app');
const state={books:[],book:null,epub:null,rendition:null,pdf:null,page:1,zoom:1.2,font:150,theme:'day',token:0};
const readingThemes = {
  day: ['#fffdf7', '#302c28'],
  sepia: ['#f1e2c5', '#392d22'],
  night: ['#20252b', '#f0eeee'],
  console: ['#171c18', '#b6e3ab'],
};
const savedTheme = localStorage.getItem('reader-theme');
if (Object.hasOwn(readingThemes, savedTheme)) state.theme = savedTheme;
function setTheme(theme) {
  if (!Object.hasOwn(readingThemes, theme)) return;
  state.theme = theme;
  localStorage.setItem('reader-theme', theme);
  app.querySelector('.stage').dataset.theme = theme;
  state.rendition.themes.select("mp-display-" + theme);
}
const fontAt = steps => Math.max(70, Math.min(200, state.font + steps * 5));
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

function libraryProgress(book) {
  if (book.remote) return book.progress;
  if (book.readingPercent?.location === book.location && Number.isFinite(book.readingPercent?.value)) {
    return 'התקדמות: ' + book.readingPercent.value + '%';
  }
  return book.location ? 'בקריאה' : 'טרם נקרא';
}

function library(){document.title='mp-reader · הספרייה';app.innerHTML=`
<header class="top"><div class="brand">📖 mp-reader <small class="reader-version" dir="ltr">v${readerVersion}</small></div><button id="sync-devices" type="button">סנכרון מכשירים</button></header>
<main class="library"><div class="hero"><h1>הספרייה שלי</h1></div>
<div class="actions">${isPaired() ? '<button type="button" id="share-library">סנכרן ספרים</button>' : ''}<h2>הספרים שלי <small>(${state.books.length})</small></h2><label class="primary">＋ הוספת ספרים<input id="pick" type="file" accept=".epub,.pdf" multiple hidden></label></div>
<div class="grid">${state.books.map(b=>`<article class="tile"><button class="cover" data-open="${esc(b.id)}"><span class="cover-icon">${b.type==='pdf'?'PDF':'EPUB'}</span><strong>${esc(b.title)}</strong></button><div class="tile-foot"><button class="book-name" data-open="${esc(b.id)}">${esc(b.title)}</button><small>${esc(libraryProgress(b))}</small>${b.remote ? '' : `<button class="delete" data-delete="${esc(b.id)}" aria-label="מחק עותק מקומי">🗑</button>`}</div></article>`).join('')}</div>
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
<div class="stage" data-theme="${book.type === 'epub' ? state.theme : 'day'}"><div id="viewport" class="viewport">${labels.loading}</div></div>
<footer class="controls" ${book.type === 'epub' ? 'aria-describedby="position"' : ''}><div class="nav"><button id="prev" aria-label="${labels.previous}">${labels.previous}</button>${book.type === 'epub' ? '' : '<span id="position">—</span>'}<button id="next" aria-label="${labels.next}">${labels.next}</button></div><div class="settings"><div class="appearance-controls"><button id="smaller" ${book.type === 'epub' ? `aria-label="${labels.smaller}"` : ''}>−</button><span id="size-label"></span><button id="larger" ${book.type === 'epub' ? `aria-label="${labels.larger}"` : ''}>＋</button></div></div>${book.type === 'epub' ? `<div id="position" class="epub-progress"><span class="progress-summary" dir="ltr">—</span></div>` : ''}</footer>
<aside class="toc-panel" id="toc-panel" hidden><button id="close-toc">${labels.close}</button><h3>${labels.toc}</h3><div id="toc-list"></div></aside>
</div><div id="notice" class="notice" hidden></div>`;
app.querySelector('#back').onclick=closeBook;
app.querySelector('#prev').onclick=()=>navigate(-1);app.querySelector('#next').onclick=()=>navigate(1);
app.querySelector('#smaller').onclick=()=>changeSize(-1);app.querySelector('#larger').onclick=()=>changeSize(1);
app.querySelector('#size-label').textContent=book.type==='pdf'?Math.round(state.zoom*100)+'%':state.font+'%';
if(book.type==='epub'){app.querySelector('#toc').onclick=()=>app.querySelector('#toc-panel').hidden=false;app.querySelector('#close-toc').onclick=()=>app.querySelector('#toc-panel').hidden=true;}
}
async function openBook(id){if (!isPaired()) return;await destroy();const book=await getBook(id);if(!book)return;state.book=book;const token=++state.token;let labels=readerLabels.he;shell(book);try{await syncBook(book, saveBook).catch(console.error);if(state.token!==token)return;if(book.type==='pdf'){const buffer=await book.file.arrayBuffer();state.pdf=await pdfjs.getDocument({data:new Uint8Array(buffer)}).promise;if(state.token!==token)return;state.page=Math.max(1,Math.min(state.pdf.numPages,Number(book.location)||1));await drawPdf();}else{const data=await book.file.arrayBuffer();state.epub=ePub(data);await state.epub.ready;if(state.token!==token)return;
const language = await getReaderLanguage(state.epub);
if (state.token !== token) return;
labels = readerLabels[language];
shell(book, language);
const view = app.querySelector('#viewport');
view.replaceChildren();
const continuous = state.epub.packaging?.metadata?.layout !== 'pre-paginated' &&
  state.epub.displayOptions?.fixedLayout !== 'true';
if (continuous) view.classList.add('continuous-epub');
const direction = state.epub.packaging?.metadata?.direction === 'rtl' ||
  (!state.epub.packaging?.metadata?.direction && language === 'he') ? 'rtl' : 'ltr';
setReaderLayout(app.querySelector('.stage'), {...defaultLayout, ...book.layout});
state.rendition = state.epub.renderTo(view, {width:'100%', height:'100%', flow:continuous ? 'scrolled-doc' : 'paginated',
  manager:continuous ? 'continuous' : 'default', offset:view.clientHeight * 2,
  spread:'none', defaultDirection:direction});
if (continuous) {
  await state.rendition.started;
  if (state.token !== token) return;
  // EPUB.js uses the rendition direction for scroll calculations. Keep text direction in the content.
  state.rendition.direction('ltr');
}
for (const [name, [background, color]] of Object.entries(readingThemes)) {
  const className = 'mp-display-' + name;
  state.rendition.themes.register(className, {['body.' + className]: {background: background + ' !important', color: color + ' !important'}});
}
state.rendition.themes.select("mp-display-" + state.theme);
state.rendition.themes.fontSize(state.font+'%');const progress = trackEpubProgress(state.epub, state.rendition, book, labels, token);
progress.continuous = continuous;
state.epubProgress = progress;
state.readerTools = new AbortController();
const tools = attachReaderTools({root: app, book, rendition: state.rendition, language,
  direction: state.epub.packaging?.metadata?.direction || direction, progress, navigate, changeSize, fontAt, theme: state.theme, setTheme,
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
  const canApply = () => !signal.aborted && !progress.resizing && !progress.navigating && !progress.followScroll && Boolean(progress.anchor) && tools.canRefresh();
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
  const readerViewport = app.querySelector('#viewport');
  const clearZoomEdge = progress.clearZoomEdge = () => {
    readerViewport.style.removeProperty('--zoom-clip');
  };

  function update() {
    if (!location?.start || token !== state.token) return false;
    const {cfi, displayed} = location.start;
    const anchor = progress.anchor || cfi;
    let pageNumber = displayed.page;
    if (progress.continuous) {
      const frame = rendition.getContents().find(contents => contents.sectionIndex === location.start.index)
        ?.window.frameElement;
      const scroller = rendition.manager.container;
      if (frame && scroller.clientHeight) {
        const offset = scroller.getBoundingClientRect().top - frame.getBoundingClientRect().top;
        pageNumber = Math.min(displayed.total, Math.floor(Math.max(0, offset) / scroller.clientHeight) + 1);
      }
    }
    const page = pageNumber > 0 && displayed.total > 0 ? pageNumber + ' / ' + displayed.total : '—';
    const index = locationCount > 0 ? epub.locations.locationFromCfi(anchor) : -1;
    const percent = index >= 0 ? Math.min(100, Math.round(100 * index / Math.max(1, locationCount - 1))) : null;
    summary.textContent = percent === null ? page : page + ' · ' + percent + '%';
    summary.setAttribute('aria-label', percent === null ? page : page + ' · ' + labels.bookProgress(percent));
    if (percent === null ||
        (book.readingPercent?.location === anchor && book.readingPercent.value === percent)) return false;
    book.readingPercent = {location: anchor, value: percent};
    return true;
  }

  rendition.on('relocated', current => {
    if (token !== state.token || progress.resizing || !current.start?.cfi) return;
    location = current;
    if (progress.followScroll || !progress.anchor) progress.anchor = current.start.cfi;
    progress.followScroll = false;
    const changedPercent = update();
    if (book.location === progress.anchor && !changedPercent) return;
    book.location = progress.anchor;
    book.progress = 'בקריאה';
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
    if (update()) await saveBook(book).catch(console.error);
  };

  progress.flush = async () => {
    if (!progress.followScroll || progress.resizing) return;
    const current = rendition.currentLocation();
    if (!current?.start?.cfi) return;
    location = current;
    progress.followScroll = false;
    progress.anchor = book.location = current.start.cfi;
    update();
    await saveReadingState(book);
  };

  progress.reflow = async (font, viewport) => {
    if (progress.resizing || !location) return;
    progress.resizing = true;
    try {
      const liveAnchor = progress.followScroll ? rendition.currentLocation()?.start?.cfi : null;
      const anchor = liveAnchor || progress.anchor || location.start.cfi;
      clearZoomEdge();
      if (font !== null) rendition.themes.fontSize(font + '%');
      if (viewport) rendition.resize(viewport.clientWidth, viewport.clientHeight, anchor);
      rendition.clear();
      await rendition.display(anchor);
      if (token !== state.token) return;
      if (progress.continuous && font !== null) {
        const scroller = rendition.manager.container;
        const fontPromises = rendition.getContents().map(contents => contents.document?.fonts?.ready);
        await Promise.all(fontPromises);
        await new Promise(requestAnimationFrame);
        if (token !== state.token) return;
        const contents = rendition.getContents();
        const bounds = scroller.getBoundingClientRect();
        const top = bounds.top + scroller.clientTop;
        const line = textLineAt(contents, top, {crossing: true});
        if (line) scroller.scrollTop -= Math.ceil(top - line.top);

        // Measure again after the top adjustment. The CSS inset is relative to the border box.
        const bottom = Math.min(window.innerHeight, top + scroller.clientHeight);
        const lastLine = textLineAt(contents, bottom, {crossing: true});
        if (lastLine) {
          const inset = Math.ceil(bounds.bottom - lastLine.top);
          readerViewport.style.setProperty('--zoom-clip', `inset(0 0 ${inset}px 0)`);

        }
      }
      location = rendition.currentLocation();
      update();
    } finally {
      progress.resizing = false;
    }
  };
  return progress;
}

async function drawPdf(){if(!state.pdf||!state.book)return;const token=state.token;const pageNumber=state.page;const page=await state.pdf.getPage(pageNumber);if(token!==state.token||pageNumber!==state.page)return;const scale=state.zoom;const viewport=page.getViewport({scale});const canvas=document.createElement('canvas');const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.ceil(viewport.width*dpr);canvas.height=Math.ceil(viewport.height*dpr);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';const context=canvas.getContext('2d');await page.render({canvasContext:context,viewport,transform:dpr!==1?[dpr,0,0,dpr,0,0]:undefined}).promise;if(token!==state.token||pageNumber!==state.page)return;const target=app.querySelector('#viewport');target.replaceChildren(canvas);target.classList.add('pdf');app.querySelector('#position').textContent=pageNumber+' / '+state.pdf.numPages;state.book.location=pageNumber;state.book.readingPercent={location:pageNumber,value:Math.round(100*pageNumber/state.pdf.numPages)};await saveBook(state.book);}
async function navigate(n) {
  if (state.pdf) {
    state.page = Math.max(1, Math.min(state.pdf.numPages, state.page + n));
    await drawPdf();
    return;
  }
  const {rendition, epub, epubProgress: progress} = state;
  if (!rendition || !progress || progress.resizing || progress.navigating) return;

  if (progress.continuous) {
    const scroller = rendition.manager.container;
    if (!scroller?.clientHeight) return;
    const start = scroller.scrollTop;
    scroller.scrollTop = readingPageOffset(scroller, rendition.getContents(), n);
    if (scroller.scrollTop !== start) {
      progress.clearZoomEdge();
      progress.followScroll = true;
    }
    return;
  }

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
  const font = fontAt(n);
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
async function closeBook(){await state.epubProgress?.flush().catch(console.error);await destroy();await refresh();}
refresh().catch(err=>{console.error(err);app.textContent='לא ניתן לפתוח את הספרייה המקומית בדפדפן הזה.';});

window.addEventListener('focus', () => {
  if (isPaired() && !state.book && !document.querySelector('dialog[open]')) refresh().catch(console.error);
});
