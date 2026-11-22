import ePub from 'epubjs';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {allBooks,getBook,saveBook,removeBook} from './db.js';
import './style.css';
pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const app=document.querySelector('#app');
const state={books:[],book:null,epub:null,rendition:null,pdf:null,page:1,zoom:1.2,font:105,night:false,token:0};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function message(t){const m=document.querySelector('#notice');if(m){m.textContent=t;m.hidden=false;setTimeout(()=>{if(m.textContent===t)m.hidden=true},4000);}else alert(t);}
async function refresh(){state.books=(await allBooks()).sort((a,b)=>b.addedAt-a.addedAt);library();}
function library(){document.title='mp-reader · הספרייה';app.innerHTML=`
<header class="top"><div class="brand">📖 mp-reader</div><span>הספרייה האישית</span></header>
<main class="library"><div class="hero"><div class="eyebrow">קורא ספרים אישי</div><h1>הספרייה שלי</h1><p>קוראים EPUB ו־PDF, ללא חשבון וללא העלאת הקבצים לענן.</p></div>
<div class="actions"><h2>הספרים שלי <small>(${state.books.length})</small></h2><label class="primary">＋ הוספת ספרים<input id="pick" type="file" accept=".epub,.pdf" multiple hidden></label></div>
<div class="grid">${state.books.map(b=>`<article class="tile"><button class="cover" data-open="${esc(b.id)}"><span class="cover-icon">${b.type==='pdf'?'PDF':'EPUB'}</span><strong>${esc(b.title)}</strong></button><div class="tile-foot"><button class="book-name" data-open="${esc(b.id)}">${esc(b.title)}</button><small>${esc(b.progress||'טרם נקרא')}</small><button class="delete" data-delete="${esc(b.id)}" aria-label="מחק ספר">🗑</button></div></article>`).join('')}</div>
${state.books.length?'':'<div class="empty">אין עדיין ספרים. בחר EPUB או PDF כדי להתחיל.</div>'}
<p class="privacy">הספרים נשמרים בדפדפן ובמכשיר הנוכחי בלבד. שמור עותק של הקבצים המקוריים.</p></main><div id="notice" class="notice" hidden></div>`;
app.querySelector('#pick').onchange=async e=>{for(const f of e.target.files){const ext=f.name.split('.').pop().toLowerCase();if(!['epub','pdf'].includes(ext))continue;try{await saveBook({id:crypto.randomUUID(),type:ext,title:f.name.replace(/\.(epub|pdf)$/i,''),file:f,addedAt:Date.now(),location:null,progress:null});}catch(err){console.error(err);message('שמירת הקובץ נכשלה. בדוק מקום פנוי.');}}await refresh();};
app.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openBook(b.dataset.open));
app.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const book=state.books.find(x=>x.id===b.dataset.delete);if(book&&confirm('למחוק את "'+book.title+'"?')){await removeBook(book.id);await refresh();}});
}
const readerLabels = {
  he: {
    back: '↩ לספרייה', toc: 'תוכן עניינים', previous: 'הקודם', next: 'הבא',
    close: 'סגור ✕', loading: 'טוען…', position: 'מיקום בספר',
    smaller: 'הקטנת גופן', larger: 'הגדלת גופן', theme: 'שינוי ערכת צבעים',
    openError: 'לא ניתן לפתוח את הספר. ייתכן שהקובץ פגום או מוגן.',
    errorNotice: 'אירעה שגיאה בפתיחת הספר',
  },
  en: {
    back: '↩ Library', toc: 'Table of contents', previous: 'Previous', next: 'Next',
    close: 'Close ✕', loading: 'Loading…', position: 'Reading position',
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

function shell(book, language = 'he'){const labels = readerLabels[language];app.innerHTML=`<div class="reader" lang="${language}" dir="${language === 'en' ? 'ltr' : 'rtl'}"><header class="reading-top"><button id="back">${labels.back}</button><strong dir="auto">${esc(book.title)}</strong><button id="toc" ${book.type==='pdf'?'hidden':''}>${labels.toc}</button></header>
<div class="stage ${state.night?'night':''}"><div id="viewport" class="viewport">${labels.loading}</div></div>
<footer class="controls"><div class="nav"><button id="prev" aria-label="${labels.previous}">${labels.previous}</button><span id="position">—</span><button id="next" aria-label="${labels.next}">${labels.next}</button></div><div class="settings"><button id="smaller" ${book.type === 'epub' ? `aria-label="${labels.smaller}"` : ''}>−</button><span id="size-label"></span><button id="larger" ${book.type === 'epub' ? `aria-label="${labels.larger}"` : ''}>＋</button><button id="theme" aria-label="${labels.theme}" ${book.type==='pdf'?'hidden':''}>◐</button></div></footer>
<aside class="toc-panel" id="toc-panel" hidden><button id="close-toc">${labels.close}</button><h3>${labels.toc}</h3><div id="toc-list"></div></aside>
</div><div id="notice" class="notice" hidden></div>`;
app.querySelector('#back').onclick=closeBook;
app.querySelector('#prev').onclick=()=>navigate(-1);app.querySelector('#next').onclick=()=>navigate(1);
app.querySelector('#smaller').onclick=()=>changeSize(-1);app.querySelector('#larger').onclick=()=>changeSize(1);
app.querySelector('#size-label').textContent=book.type==='pdf'?Math.round(state.zoom*100)+'%':state.font+'%';
if(book.type==='epub'){app.querySelector('#theme').onclick=()=>{state.night=!state.night;app.querySelector('.stage').classList.toggle('night',state.night);state.rendition?.themes.select(state.night?'night':'paper');};app.querySelector('#toc').onclick=()=>app.querySelector('#toc-panel').hidden=false;app.querySelector('#close-toc').onclick=()=>app.querySelector('#toc-panel').hidden=true;}
}
async function openBook(id){await destroy();const book=await getBook(id);if(!book)return;state.book=book;const token=++state.token;let labels=readerLabels.he;shell(book);try{if(book.type==='pdf'){const buffer=await book.file.arrayBuffer();state.pdf=await pdfjs.getDocument({data:new Uint8Array(buffer)}).promise;if(state.token!==token)return;state.page=Math.max(1,Math.min(state.pdf.numPages,Number(book.location)||1));await drawPdf();}else{const data=await book.file.arrayBuffer();state.epub=ePub(data);await state.epub.ready;if(state.token!==token)return;
const language = await getReaderLanguage(state.epub);
if (state.token !== token) return;
labels = readerLabels[language];
shell(book, language);
const view=app.querySelector('#viewport');view.replaceChildren();state.rendition=state.epub.renderTo(view,{width:'100%',height:'100%',flow:'paginated',spread:'none'});state.rendition.themes.register('paper',{body:{background:'#fffdf7 !important',color:'#302c28 !important'}});state.rendition.themes.register('night',{body:{background:'#20252b !important',color:'#f0eeee !important'}});state.rendition.themes.select(state.night?'night':'paper');state.rendition.themes.fontSize(state.font+'%');state.rendition.on('relocated',async loc=>{if(state.book?.id!==book.id)return;book.location=loc.start.cfi;book.progress='בקריאה';app.querySelector('#position').textContent=labels.position;await saveBook(book);});await state.rendition.display(book.location||undefined);if(state.token!==token)return;const navigation=await state.epub.loaded.navigation;if(state.token!==token)return;const toc=app.querySelector('#toc-list');toc.replaceChildren();for(const item of navigation.toc||[]){const b=document.createElement('button');b.textContent=item.label;b.dir='auto';b.style.textAlign='start';b.onclick=async()=>{app.querySelector('#toc-panel').hidden=true;await state.rendition.display(item.href);};toc.append(b);}}}catch(err){if(state.token!==token)return;console.error(err);app.querySelector('#viewport').textContent=labels.openError;message(labels.errorNotice);}}
async function drawPdf(){if(!state.pdf||!state.book)return;const token=state.token;const pageNumber=state.page;const page=await state.pdf.getPage(pageNumber);if(token!==state.token||pageNumber!==state.page)return;const scale=state.zoom;const viewport=page.getViewport({scale});const canvas=document.createElement('canvas');const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.ceil(viewport.width*dpr);canvas.height=Math.ceil(viewport.height*dpr);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';const context=canvas.getContext('2d');await page.render({canvasContext:context,viewport,transform:dpr!==1?[dpr,0,0,dpr,0,0]:undefined}).promise;if(token!==state.token||pageNumber!==state.page)return;const target=app.querySelector('#viewport');target.replaceChildren(canvas);target.classList.add('pdf');app.querySelector('#position').textContent=pageNumber+' / '+state.pdf.numPages;state.book.location=pageNumber;state.book.progress='עמוד '+pageNumber+' מתוך '+state.pdf.numPages;await saveBook(state.book);}
async function navigate(n){if(state.pdf){state.page=Math.max(1,Math.min(state.pdf.numPages,state.page+n));await drawPdf();}else if(state.rendition){if(n>0)await state.rendition.next();else await state.rendition.prev();}}
async function changeSize(n){if(state.pdf){state.zoom=Math.max(.5,Math.min(3,state.zoom+n*.2));app.querySelector('#size-label').textContent=Math.round(state.zoom*100)+'%';await drawPdf();}else{state.font=Math.max(70,Math.min(200,state.font+n*10));app.querySelector('#size-label').textContent=state.font+'%';state.rendition?.themes.fontSize(state.font+'%');}}
async function destroy(){state.token++;try{state.rendition?.destroy();}catch{}try{state.epub?.destroy();}catch{}try{await state.pdf?.destroy();}catch{}state.rendition=null;state.epub=null;state.pdf=null;state.book=null;}
async function closeBook(){await destroy();await refresh();}
refresh().catch(err=>{console.error(err);app.textContent='לא ניתן לפתוח את הספרייה המקומית בדפדפן הזה.';});
