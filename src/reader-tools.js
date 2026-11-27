import ePub from 'epubjs';
import {createReaderSelection} from './reader-selection.js';

const translations = {
  he: {
    tools: 'כלי קריאה', close: 'סגור', bookmarks: 'סימניות', add: 'הוסף סימנייה כאן',
    bookmark: 'סימנייה', search: 'חיפוש בספר', find: 'חפש', searching: 'מחפש…',
    noResults: 'לא נמצאו תוצאות.', limit: 'מוצגות 100 התוצאות הראשונות.',
    appearance: 'גופן ותצוגה', theme: 'מצב צבע', brightness: 'בהירות העמוד', system: 'אפס עמעום', themes: ['יום', 'ספיה', 'לילה', 'קונסול'], layout: 'פריסת הקריאה', width: 'רוחב', spacing: 'ריווח שורות', margins: 'שוליים מהצדדים',
    apply: 'החל', reset: 'ברירת מחדל', highlights: 'הדגשות והערות',
    select: 'בחר טקסט בספר כדי להדגיש אותו או להוסיף הערה.', note: 'הערה',
    selectionHandles: ['תחילת הסימון', 'סוף הסימון'], save: 'שמור הדגשה', cancel: 'בטל', edit: 'ערוך הערה', update: 'שמור הערה', remove: 'הסר',
    passage: 'עבור לקטע', location: percent => 'מיקום בספר: ' + percent + '%',
    noItems: 'אין פריטים שמורים.', error: 'הפעולה נכשלה. אפשר לנסות שוב.',
  },
  en: {
    tools: 'Reading tools', close: 'Close', bookmarks: 'Bookmarks', add: 'Bookmark this location',
    bookmark: 'Bookmark', search: 'Search book', find: 'Search', searching: 'Searching…',
    noResults: 'No matches found.', limit: 'Showing the first 100 matches.',
    appearance: 'Font and display', theme: 'Color mode', brightness: 'Page brightness', system: 'Reset dimming', themes: ['Day', 'Sepia', 'Night', 'Console'], layout: 'Reading layout', width: 'Width', spacing: 'Line spacing', margins: 'Side margins',
    apply: 'Apply', reset: 'Reset', highlights: 'Highlights and notes',
    select: 'Select text in the book to highlight it or add a note.', note: 'Note',
    selectionHandles: ['Selection start', 'Selection end'], save: 'Save highlight', cancel: 'Cancel', edit: 'Edit note', update: 'Save note', remove: 'Remove',
    passage: 'Go to passage', location: percent => 'Book position: ' + percent + '%',
    noItems: 'No saved items.', error: 'Something went wrong. Please try again.',
  },
};

export const defaultLayout = {width: 900, spacing: 0, margins: 18};

export function setReaderLayout(stage, layout) {
  stage.style.setProperty('--reading-width', layout.width + 'px');
  stage.style.setProperty('--reading-margins', layout.margins + 'px');
}

function chapterLookup(epub, signal) {
  const entriesBySection = epub.loaded.navigation.then(navigation => {
    const sections = new Map();
    function collect(entries) {
      for (const {href, label, subitems} of entries) {
        const section = epub.spine.get(href);
        if (section && label?.trim()) {
          if (!sections.has(section.index)) sections.set(section.index, []);
          sections.get(section.index).push({label: label.trim(), fragment: href.split('#')[1]});
        }
        collect(subitems ?? []);
      }
    }
    if (!signal.aborted) collect(navigation.toc ?? []);
    return sections;
  });
  const anchorsBySection = new Map();
  const compare = new ePub.CFI().compare;

  async function anchorsFor(section, entries) {
    let document;
    if (entries.some(entry => entry.fragment)) {
      // Use a separate parsed document so this lookup does not affect rendering or indexing.
      document = await epub.load(section.url);
    }
    const anchors = [];
    for (const entry of entries) {
      if (!entry.fragment) {
        anchors.push({...entry, cfi: null});
        continue;
      }
      let id = entry.fragment;
      try { id = decodeURIComponent(id); } catch {}
      const element = document.getElementById(id);
      if (element) anchors.push({...entry, cfi: section.cfiFromElement(element)});
    }
    return anchors.sort((a, b) => a.cfi && b.cfi ? compare(a.cfi, b.cfi) : Number(Boolean(a.cfi)) - Number(Boolean(b.cfi)));
  }

  return async cfi => {
    const entries = await entriesBySection;
    if (signal.aborted) return;
    const {spinePos} = new ePub.CFI(cfi);
    const indices = [...entries.keys()].filter(index => index <= spinePos).sort((a, b) => b - a);
    for (const index of indices) {
      if (!anchorsBySection.has(index)) {
        const section = epub.spine.get(index);
        anchorsBySection.set(index, anchorsFor(section, entries.get(index)).catch(() => []));
      }
      const anchors = await anchorsBySection.get(index);
      if (signal.aborted) return;
      const match = anchors.findLast(anchor => index < spinePos || !anchor.cfi || compare(anchor.cfi, cfi) <= 0);
      if (match) return match.label;
    }
  };
}

export function attachReaderTools({root, book, rendition, language, direction, progress, navigate, changeSize, fontAt, theme, setTheme, persist, signal}) {
  const t = translations[language];
  const chapterAt = chapterLookup(rendition.book, signal);
  const bookmarks = book.bookmarks ??= [];
  const highlights = book.highlights ??= [];
  book.layout = {...defaultLayout, ...book.layout};
  const stage = root.querySelector('.stage');
  const reader = root.querySelector('.reader');
  const compact = window.matchMedia('(max-width: 620px)');
  const viewport = root.querySelector('#viewport');
  const toolsButton = document.createElement('button');
  toolsButton.type = 'button';
  toolsButton.className = 'open-reader-tools';
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
    <details class="reader-appearance">
      <summary>${t.appearance}</summary>
      <div data-appearance></div>
      <div class="theme-choices" role="group" aria-label="${t.theme}">
        ${['day','sepia','night','console'].map((value, index) => `<button type="button" data-reading-theme="${value}" aria-pressed="${value === theme}">${t.themes[index]}</button>`).join('')}
      </div>
      <div>
        <label class="display-setting">${t.brightness}
          <input type="range" min="20" max="100" value="100" data-brightness-level>
        </label>
        <button type="button" data-brightness-reset>${t.system}</button>
      </div>
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
  root.querySelector('.reader').append(panel);
  const query = selector => panel.querySelector(selector);
  const settings = root.querySelector('.settings');
  const appearance = settings.querySelector('.appearance-controls');
  const footer = root.querySelector('.controls');
  const nav = footer.querySelector('.nav');
  const previous = nav.querySelector('#prev');
  const next = nav.querySelector('#next');
  const footerProgress = footer.querySelector('.epub-progress');
  for (const side of ['left', 'right']) {
    const rail = document.createElement('button');
    const forward = (side === 'left') === (direction === 'rtl');
    rail.type = 'button';
    rail.className = 'page-tap-rail page-tap-rail-' + side;
    rail.setAttribute('aria-label', root.querySelector(forward ? '#next' : '#prev').getAttribute('aria-label'));
    rail.tabIndex = -1;
    rail.onclick = () => navigate(forward ? 1 : -1).catch(report);
    stage.append(rail);
  }
  function arrangeAppearance() {
    if (compact.matches) {
      query('[data-appearance]').append(appearance);
      footerProgress.prepend(previous);
      footerProgress.append(toolsButton, next);
    } else {
      nav.append(previous, next);
      settings.prepend(appearance);
      settings.append(toolsButton);
    }
  }
  compact.addEventListener('change', arrangeAppearance, {signal});
  arrangeAppearance();
  const themeButtons = panel.querySelectorAll('[data-reading-theme]');
  for (const button of themeButtons) {
    button.onclick = () => {
      setTheme(button.dataset.readingTheme);
      for (const option of themeButtons) {
        option.setAttribute('aria-pressed', String(option === button));
      }
    };
  }
  const brightnessKey = 'reader-page-brightness';
  const slider = query('[data-brightness-level]');
  slider.value = localStorage.getItem(brightnessKey) ?? '100';
  function applyBrightness() {
    viewport.style.filter = Number(slider.value) === 100 ? '' : 'brightness(' + slider.value + '%)';
  }
  slider.oninput = () => {
    localStorage.setItem(brightnessKey, slider.value);
    applyBrightness();
  };
  query('[data-brightness-reset]').onclick = () => {
    slider.value = '100';
    localStorage.removeItem(brightnessKey);
    applyBrightness();
  };
  applyBrightness();
  const zoomStatus = document.createElement('output');
  zoomStatus.className = 'font-gesture-status';
  zoomStatus.hidden = true;
  stage.append(zoomStatus);
  let zoomTimeout;
  function showFont(steps) {
    clearTimeout(zoomTimeout);
    zoomStatus.textContent = fontAt(steps) + '%';
    zoomStatus.hidden = false;
  }
  signal.addEventListener('abort', () => clearTimeout(zoomTimeout), {once:true});
  const pinchSteps = ratio => ratio > 1.12 || ratio < 0.88
    ? Math.sign(ratio - 1) * Math.max(1, Math.round(Math.abs(ratio - 1) * 10)) : 0;
  let selected;
  let draft;
  const mouseSelecting = new WeakSet();
  const confirmation = document.createElement('div');
  confirmation.className = 'highlight-confirmation';
  confirmation.hidden = true;
  confirmation.innerHTML = `<button type="button" data-confirm>${t.save}</button>
    <button type="button" data-cancel>${t.cancel}</button><span role="status"></span>`;
  stage.append(confirmation);

  const selection = progress.continuous && createReaderSelection({
    stage, viewport, rendition, progress, signal, labels: t.selectionHandles,
    onChange: active => { confirmation.hidden = !active; },
  });

  function clearDraft() {
    draft?.contents.window.getSelection()?.removeAllRanges();
    draft = null;
    selection?.clear?.();
    confirmation.hidden = true;
    confirmation.querySelector('span').textContent = '';
  }
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

  toolsButton.onclick = () => {
    showPanel(true);
    query('[data-close]').focus();
  };
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

  // Listen inside the rendition so the page remains available for native text selection.
  function bindPageTaps(target, contents, options) {
    let press;
    let navigating = false;
    let pinch;
    let touchPress;
    const distance = touches => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
    target.addEventListener('touchstart', event => {
      touchPress = null;
      if (event.touches.length === 1 && !pinch) {
        const point = event.touches[0];
        touchPress = {
          id: point.identifier, x: point.clientX, y: point.clientY,
          start: event.timeStamp, target: event.target,
          hadSelection: Boolean(draft || selection?.active || contents?.window.getSelection()?.toString()),
        };
        return;
      }
      if (event.touches.length !== 2 || (!contents && !viewport.contains(event.target)) ||
          draft || selection?.active || contents?.window.getSelection()?.toString()) return;
      press = null;
      pinch = {start: distance(event.touches), ratio: 1};
      showFont(0);
      if (event.cancelable) event.preventDefault();
    }, {...options, passive: false});
    target.addEventListener('touchmove', event => {
      if (touchPress && event.touches.length === 1) {
        const point = event.touches[0];
        const dx = point.clientX - touchPress.x;
        const dy = point.clientY - touchPress.y;
        if (progress.continuous && contents && !progress.resizing &&
            !contents.window.getSelection()?.toString() &&
            (touchPress.scrolling || (Math.abs(dy) > 9 && Math.abs(dy) > Math.abs(dx)))) {
          if (event.cancelable) event.preventDefault();
          const scroller = rendition.manager.container;
          const top = scroller.scrollTop;
          scroller.scrollTop += (touchPress.lastY ?? touchPress.y) - point.clientY;
          if (scroller.scrollTop !== top) progress.followScroll = true;
          touchPress.scrolling = true;
          touchPress.lastY = point.clientY;
        } else if (Math.hypot(dx, dy) > 18) {
          touchPress = null;
        }
      }
      if (!pinch || event.touches.length !== 2) return;
      if (event.cancelable) event.preventDefault();
      if (pinch.start > 0) pinch.ratio = distance(event.touches) / pinch.start;
      showFont(pinchSteps(pinch.ratio));
    }, {...options, passive: false});
    target.addEventListener('touchend', event => {
      if (!pinch) {
        const start = touchPress;
        touchPress = null;
        const point = Array.from(event.changedTouches).find(touch => touch.identifier === start?.id);
        if (point && !start.scrolling && event.touches.length === 0) activateTap(start, point, event);
        return;
      }
      if (event.touches.length >= 2) return;
      const {ratio} = pinch;
      pinch = null;
      press = null;
      if (event.cancelable) event.preventDefault();
      const steps = pinchSteps(ratio);
      showFont(steps);
      if (steps) changeSize(steps).catch(report);
      zoomTimeout = setTimeout(() => { zoomStatus.hidden = true; }, 900);
    }, {...options, passive: false});
    target.addEventListener('touchcancel', () => {
      if (pinch) zoomStatus.hidden = true;
      pinch = null;
      press = null;
      touchPress = null;
    }, options);
    target.addEventListener('pointerdown', event => {
      if (pinch || event.pointerType === 'touch' || !event.isPrimary || event.button !== 0) return;
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        start: event.timeStamp,
        hadSelection: Boolean(draft || selection?.active || contents?.window.getSelection()?.toString()),
      };
    }, options);
    target.addEventListener('pointercancel', () => { press = null; }, options);
    async function activateTap(start, point, event) {
      if (event.timeStamp - start.start > 450 ||
          Math.hypot(point.clientX - start.x, point.clientY - start.y) > 18 ||
          event.defaultPrevented || navigating || progress.resizing || signal.aborted ||
          (start.target ?? event.target)?.closest?.('a, button, input, textarea, select, label, video, audio, [contenteditable], .reader-highlight, .highlight-confirmation')) return;
      if (contents?.window.getSelection()?.toString()) return;
      if (start.hadSelection || draft || selection?.active) return;
      const frame = contents?.window.frameElement;
      const x = point.clientX + (frame?.getBoundingClientRect().left ?? 0);
      const {left, width} = viewport.getBoundingClientRect();
      if (!width) return;
      const position = (x - left) / width;
      const edge = compact.matches ? 0.45 : 0.3;
      if (position > edge && position < 1 - edge) {
        if (compact.matches) {
          reader.classList.toggle('reading-clean');
        }
        return;
      }
      const forward = (position <= edge) === (direction === 'rtl');
      navigating = true;
      try {
        await navigate(forward ? 1 : -1);
      } catch (error) {
        report(error);
      } finally {
        navigating = false;
      }
    }
    target.addEventListener('click', event => {
      const start = press;
      press = null;
      if (start && event.detail === 1 && (!event.pointerId || event.pointerId === start.id)) {
        activateTap(start, event, event);
      }
    }, options);
  }

  bindPageTaps(stage, null, {signal});
  if (!progress.continuous) rendition.on('relocated', clearDraft);
  window.addEventListener('keydown', handleKeys, {signal});
  rendition.on('keydown', handleKeys);
  rendition.hooks.content.register(contents => {
    bindPageTaps(contents.document, contents);
    if (progress.continuous) {
      contents.document.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button === 0) mouseSelecting.add(contents);
      });
      contents.document.addEventListener('pointerup', () => {
        if (mouseSelecting.delete(contents)) captureSelection(contents);
      });
      contents.document.addEventListener('pointercancel', () => { mouseSelecting.delete(contents); });
    }
    contents.addStylesheetRules({html: {'touch-action': progress.continuous ? 'none' : 'pan-x pan-y'}});
    if (progress.continuous) {
      if (direction === 'rtl' && !contents.document.documentElement.hasAttribute('dir')) {
        contents.document.documentElement.setAttribute('dir', 'rtl');
      }
      contents.document.addEventListener('wheel', event => {
        if (event.ctrlKey || !event.deltaY || progress.resizing || !event.cancelable) return;
        event.preventDefault();
        const scroller = rendition.manager.container;
        const top = scroller.scrollTop;
        const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
        scroller.scrollTop += event.deltaY * scale;
        if (scroller.scrollTop !== top) progress.followScroll = true;
      }, {passive: false});
    }
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
  function openHighlightEditor(entry) {
    clearDraft();
    selected = entry;
    highlightForm.querySelector('blockquote').textContent = entry.text;
    highlightForm.querySelector('textarea').value = entry.note || '';
    highlightForm.querySelector('button').textContent = t.update;
    highlightForm.hidden = false;
    query('[data-highlights]').open = true;
    showPanel(true);
  }

  function showHighlights() {
    showList(query('[data-highlight-list]'), highlights, (item, entry, index) => {
      const chapter = document.createElement('strong');
      chapter.dir = 'auto';
      chapter.hidden = true;
      const quote = document.createElement('blockquote');
      quote.dir = 'auto';
      quote.textContent = entry.text;
      item.append(chapter, quote);

      const start = new ePub.CFI(entry.cfi);
      start.collapse(true);
      const target = start.toString();
      chapterAt(target).then(async title => {
        if (signal.aborted || !chapter.isConnected) return;
        if (!title) {
          await progress.indexed;
          if (signal.aborted || !chapter.isConnected) return;
          const percent = rendition.book.locations.percentageFromCfi(target);
          if (percent != null) title = t.location(Math.round(percent * 100));
        }
        if (title) {
          chapter.textContent = title;
          chapter.hidden = false;
        }
      }).catch(report);
      if (entry.note) {
        const note = document.createElement('p');
        note.dir = 'auto';
        note.textContent = entry.note;
        item.append(note);
      }
      item.append(listButton(t.passage, () => jump(target)),
        listButton(t.edit, () => openHighlightEditor(entry)), listButton(t.remove, async () => {
        for (const cfi of rangesOf(entry)) {
          rendition.annotations.remove(cfi, 'highlight');
          painted.delete(cfi);
        }
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
  const rangesOf = entry => [entry.cfi, ...(entry.additionalRanges ?? [])];
  function paint(entry) {
    for (const cfi of rangesOf(entry)) {
      if (painted.has(cfi)) continue;
      painted.add(cfi);
      rendition.annotations.highlight(cfi, {}, () => {
        const current = highlights.find(item => rangesOf(item).includes(cfi));
        if (current) openHighlightEditor(current);
      }, 'reader-highlight', {
        fill: '#ffd548', 'fill-opacity': '0.38', 'mix-blend-mode': 'normal',
      });
    }
  }
  function captureSelection(contents) {
    if (signal.aborted || progress.resizing || mouseSelecting.has(contents)) return;
    const selectionInBook = contents.window.getSelection();
    const text = selectionInBook?.toString().trim();
    if (!text || !selectionInBook.rangeCount) return;
    if (selection) {
      selection.start(contents, selectionInBook);
      return;
    }
    draft = {cfi: contents.cfiFromRange(selectionInBook.getRangeAt(0)), text, contents};
    confirmation.hidden = false;
  }
  rendition.on('selected', (_cfi, contents) => captureSelection(contents));
  const confirm = confirmation.querySelector('[data-confirm]');
  const cancel = confirmation.querySelector('[data-cancel]');
  cancel.onclick = clearDraft;
  confirm.onclick = async () => {
    if ((!draft && !selection?.active) || confirm.disabled) return;
    confirm.disabled = cancel.disabled = true;
    let entry;
    try {
      const parts = selection ? await selection.parts() : [draft];
      if (signal.aborted) return;
      const used = new Set(highlights.flatMap(rangesOf));
      const newParts = parts.filter(part => !used.has(part.cfi));
      if (newParts.length) {
        entry = {cfi: newParts[0].cfi, text: newParts.map(part => part.text).join(' ')};
        if (newParts.length > 1) entry.additionalRanges = newParts.slice(1).map(part => part.cfi);
        highlights.push(entry);
        await persist();
        if (signal.aborted) return;
        paint(entry);
        showHighlights();
      }
      clearDraft();
    } catch (error) {
      const index = highlights.indexOf(entry);
      if (index >= 0) highlights.splice(index, 1);
      report(error);
      if (!signal.aborted) confirmation.querySelector('span').textContent = t.error;
    } finally {
      confirm.disabled = cancel.disabled = false;
    }
  };
  highlightForm.onsubmit = async event => {
    event.preventDefault();
    if (!selected) return;
    selected.note = highlightForm.querySelector('textarea').value.trim();
    selected = null;
    highlightForm.hidden = true;
    showHighlights();
    await persist().catch(report);
  };
  let painted = new Set();
  highlights.forEach(paint);
  showHighlights();
  return {
    canRefresh: () => !selected && !draft && !selection?.active,
    refresh() {
      const current = new Set(highlights.flatMap(rangesOf));
      for (const cfi of painted) {
        if (!current.has(cfi)) rendition.annotations.remove(cfi, 'highlight');
      }
      for (const entry of highlights) {
        paint(entry);
      }
      painted = current;
      showBookmarks();
      showHighlights();
    },
  };
}
