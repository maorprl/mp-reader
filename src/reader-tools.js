import ePub from 'epubjs';

const translations = {
  he: {
    tools: 'כלי קריאה', close: 'סגור', bookmarks: 'סימניות', add: 'הוסף סימנייה כאן',
    bookmark: 'סימנייה', search: 'חיפוש בספר', find: 'חפש', searching: 'מחפש…',
    noResults: 'לא נמצאו תוצאות.', limit: 'מוצגות 100 התוצאות הראשונות.',
    layout: 'פריסת הקריאה', width: 'רוחב', spacing: 'ריווח שורות', margins: 'שוליים מהצדדים',
    apply: 'החל', reset: 'ברירת מחדל', highlights: 'הדגשות והערות',
    select: 'בחר טקסט בספר כדי להדגיש אותו או להוסיף הערה.', note: 'הערה',
    save: 'שמור הדגשה', edit: 'ערוך הערה', update: 'שמור הערה', remove: 'הסר',
    noItems: 'אין פריטים שמורים.', error: 'הפעולה נכשלה. אפשר לנסות שוב.',
  },
  en: {
    tools: 'Reading tools', close: 'Close', bookmarks: 'Bookmarks', add: 'Bookmark this location',
    bookmark: 'Bookmark', search: 'Search book', find: 'Search', searching: 'Searching…',
    noResults: 'No matches found.', limit: 'Showing the first 100 matches.',
    layout: 'Reading layout', width: 'Width', spacing: 'Line spacing', margins: 'Side margins',
    apply: 'Apply', reset: 'Reset', highlights: 'Highlights and notes',
    select: 'Select text in the book to highlight it or add a note.', note: 'Note',
    save: 'Save highlight', edit: 'Edit note', update: 'Save note', remove: 'Remove',
    noItems: 'No saved items.', error: 'Something went wrong. Please try again.',
  },
};

export const defaultLayout = {width: 900, spacing: 0, margins: 18};

export function setReaderLayout(stage, layout) {
  stage.style.setProperty('--reading-width', layout.width + 'px');
  stage.style.setProperty('--reading-margins', layout.margins + 'px');
}

export function attachReaderTools({root, book, rendition, language, direction, progress, navigate, persist, signal}) {
  const t = translations[language];
  const bookmarks = book.bookmarks ??= [];
  const highlights = book.highlights ??= [];
  book.layout = {...defaultLayout, ...book.layout};
  const stage = root.querySelector('.stage');
  const viewport = root.querySelector('#viewport');
  const toolsButton = document.createElement('button');
  toolsButton.textContent = t.tools;
  toolsButton.setAttribute('aria-expanded', 'false');
  toolsButton.setAttribute('aria-controls', 'reader-tools');

  const panel = document.createElement('aside');
  panel.id = 'reader-tools';
  panel.className = 'toc-panel reader-tools';
  panel.setAttribute('aria-label', t.tools);
  panel.hidden = true;
  panel.innerHTML = `
    <button type="button" data-close>${t.close}</button>
    <details data-search>
      <summary>${t.search}</summary>
      <form data-search-form>
        <input type="search" aria-label="${t.search}" dir="auto" required>
        <button>${t.find}</button>
      </form>
      <p role="status" data-search-status></p>
      <ul data-results></ul>
    </details>
    <details data-bookmarks>
      <summary>${t.bookmarks}</summary>
      <button type="button" data-add>${t.add}</button>
      <ul data-bookmark-list></ul>
    </details>
    <details data-layout>
      <summary>${t.layout}</summary>
      <form data-layout-form>
        <label>${t.width} (px)<input name="width" type="number" min="420" max="1600" required></label>
        <label>${t.spacing}<select name="spacing">
          <option value="0">${t.reset}</option><option value="1.3">1.3</option>
          <option value="1.5">1.5</option><option value="1.8">1.8</option><option value="2">2</option>
        </select></label>
        <label>${t.margins} (px)<input name="margins" type="number" min="0" max="160" required></label>
        <button>${t.apply}</button>
        <button type="button" data-reset>${t.reset}</button>
      </form>
    </details>
    <details data-highlights>
      <summary>${t.highlights}</summary>
      <p>${t.select}</p>
      <form data-highlight-form hidden>
        <blockquote dir="auto"></blockquote>
        <label>${t.note}<textarea dir="auto"></textarea></label>
        <button>${t.save}</button>
      </form>
      <ul data-highlight-list></ul>
    </details>
    <p data-error role="status"></p>`;
  root.querySelector('.settings').append(toolsButton);
  root.querySelector('.reader').append(panel);
  const query = selector => panel.querySelector(selector);
  let selected;
  let editing;
  let searchSequence = 0;

  function report(error) {
    if (signal.aborted) return;
    console.error(error);
    query('[data-error]').textContent = t.error;
  }

  function showPanel(show) {
    panel.hidden = !show;
    toolsButton.setAttribute('aria-expanded', String(show));
    if (show) root.querySelector('#toc-panel').hidden = true;
  }

  toolsButton.onclick = () => showPanel(panel.hidden);
  query('[data-close]').onclick = () => {
    showPanel(false);
    toolsButton.focus();
  };
  root.querySelector('#toc').addEventListener('click', () => showPanel(false), {signal});

  function handleKeys(event) {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey ||
        event.shiftKey || event.isComposing || progress.resizing ||
        (event.target?.closest?.('input, textarea, select, button, summary, a, [contenteditable]'))) return;
    const rtl = direction === 'rtl';
    const moves = {ArrowLeft: rtl ? 1 : -1, ArrowRight: rtl ? -1 : 1, ' ': 1};
    if (!Object.hasOwn(moves, event.key)) return;
    event.preventDefault();
    navigate(moves[event.key]).catch(report);
  }

  window.addEventListener('keydown', handleKeys, {signal});
  rendition.on('keydown', handleKeys);
  rendition.hooks.content.register(contents => {
    const spacing = book.layout.spacing;
    if (spacing) {
      contents.addStylesheetRules({
        'body, p, li, blockquote': {'line-height': spacing + ' !important'},
      }, 'reader-line-spacing');
    }
  });

  async function jump(cfi) {
    if (progress.resizing) return;
    progress.anchor = cfi;
    await rendition.display(cfi);
    if (!signal.aborted) showPanel(false);
  }

  function listButton(text, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.dir = 'auto';
    button.onclick = () => Promise.resolve().then(action).catch(report);
    return button;
  }

  function showList(target, entries, render) {
    target.replaceChildren();
    if (!entries.length) {
      const item = document.createElement('li');
      item.textContent = t.noItems;
      target.append(item);
    }
    entries.forEach((entry, index) => {
      const item = document.createElement('li');
      render(item, entry, index);
      target.append(item);
    });
  }

  function showBookmarks() {
    showList(query('[data-bookmark-list]'), bookmarks, (item, entry, index) => {
      item.append(listButton(entry.label, () => jump(entry.cfi)), listButton(t.remove, async () => {
        bookmarks.splice(index, 1);
        await persist();
        showBookmarks();
      }));
    });
  }

  query('[data-add]').onclick = async () => {
    const cfi = progress.anchor || rendition.location?.start?.cfi;
    if (!cfi || bookmarks.some(entry => entry.cfi === cfi)) return;
    const range = rendition.getRange(cfi);
    const excerpt = range?.startContainer?.textContent?.slice(range.startOffset).trim().slice(0, 100);
    bookmarks.push({cfi, label: excerpt || t.bookmark + ' ' + (bookmarks.length + 1)});
    showBookmarks();
    await persist().catch(report);
  };
  showBookmarks();

  query('[data-search-form]').onsubmit = async event => {
    event.preventDefault();
    const term = event.currentTarget.querySelector('input').value.trim();
    const sequence = ++searchSequence;
    const status = query('[data-search-status]');
    const results = query('[data-results]');
    results.replaceChildren();
    status.textContent = '';
    if (!term) return;

    status.textContent = t.searching;
    let searchable;
    try {
      const data = await book.file.arrayBuffer();
      if (signal.aborted || sequence !== searchSequence) return;
      searchable = ePub(data);
      await searchable.ready;
      const sections = [];
      searchable.spine.each(section => sections.push(section));
      let count = 0;
      for (const section of sections) {
        if (signal.aborted || sequence !== searchSequence) return;
        await section.load(searchable.load.bind(searchable));
        if (signal.aborted || sequence !== searchSequence) return;
        for (const match of section.find(term)) {
          const item = document.createElement('li');
          item.append(listButton(match.excerpt, () => jump(match.cfi)));
          results.append(item);
          if (++count === 100) break;
        }
        section.unload();
        if (count === 100) break;
      }
      status.textContent = count === 100 ? t.limit : count ? '' : t.noResults;
    } catch (error) {
      if (sequence === searchSequence) {
        status.textContent = '';
        report(error);
      }
    } finally {
      searchable?.destroy();
    }
  };

  const layoutForm = query('[data-layout-form]');
  function fillLayout() {
    for (const [name, value] of Object.entries(book.layout)) layoutForm.elements[name].value = value;
  }
  async function applyLayout(layout) {
    if (progress.resizing) return;
    book.layout = layout;
    setReaderLayout(stage, layout);
    fillLayout();
    await progress.reflow(null, viewport);
    await persist();
  }
  layoutForm.onsubmit = event => {
    event.preventDefault();
    const layout = Object.fromEntries([...new FormData(layoutForm)].map(([key, value]) => [key, Number(value)]));
    applyLayout(layout).catch(report);
  };
  query('[data-reset]').onclick = () => applyLayout({...defaultLayout}).catch(report);
  fillLayout();

  const highlightForm = query('[data-highlight-form]');
  function openHighlightEditor(entry, existing) {
    selected = entry;
    editing = existing;
    highlightForm.querySelector('blockquote').textContent = entry.text;
    highlightForm.querySelector('textarea').value = entry.note || '';
    highlightForm.querySelector('button').textContent = existing ? t.update : t.save;
    highlightForm.hidden = false;
    query('[data-highlights]').open = true;
    showPanel(true);
  }

  function showHighlights() {
    showList(query('[data-highlight-list]'), highlights, (item, entry, index) => {
      item.append(listButton(entry.text, () => jump(entry.cfi)));
      if (entry.note) {
        const note = document.createElement('p');
        note.dir = 'auto';
        note.textContent = entry.note;
        item.append(note);
      }
      item.append(listButton(t.edit, () => openHighlightEditor(entry, true)), listButton(t.remove, async () => {
        rendition.annotations.remove(entry.cfi, 'highlight');
        highlights.splice(index, 1);
        if (selected === entry) {
          selected = null;
          highlightForm.hidden = true;
        }
        await persist();
        showHighlights();
      }));
    });
  }
  function paint(entry) {
    rendition.annotations.highlight(entry.cfi, {}, () => openHighlightEditor(entry, true), 'reader-highlight', {
      fill: '#ffd548', 'fill-opacity': '0.38', 'mix-blend-mode': 'normal',
    });
  }
  rendition.on('selected', (cfi, contents) => {
    const existing = highlights.find(entry => entry.cfi === cfi);
    const text = contents.window.getSelection()?.toString().trim();
    if (existing || text) openHighlightEditor(existing || {cfi, text}, Boolean(existing));
  });
  highlightForm.onsubmit = async event => {
    event.preventDefault();
    if (!selected) return;
    selected.note = highlightForm.querySelector('textarea').value.trim();
    if (!editing) {
      highlights.push(selected);
      paint(selected);
    }
    selected = null;
    highlightForm.hidden = true;
    showHighlights();
    await persist().catch(report);
  };
  highlights.forEach(paint);
  showHighlights();
}
