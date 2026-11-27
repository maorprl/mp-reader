import ePub from 'epubjs';

const cfiOrder = new ePub.CFI();

function location(contents, node, offset) {
  const range = contents.document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  return {index: contents.sectionIndex, cfi: contents.cfiFromRange(range)};
}

function sectionRange(doc, index, start, end) {
  const range = doc.createRange();
  range.selectNodeContents(doc.body);
  if (start.index === index) {
    const from = new ePub.CFI(start.cfi).toRange(doc);
    range.setStart(from.startContainer, from.startOffset);
  }
  if (end.index === index) {
    const to = new ePub.CFI(end.cfi).toRange(doc);
    range.setEnd(to.startContainer, to.startOffset);
  }
  return range;
}

export function createReaderSelection({stage, viewport, rendition, progress, signal, onChange, labels}) {
  const overlay = document.createElement('div');
  overlay.className = 'reader-selection';
  const marks = document.createElement('div');
  marks.setAttribute('aria-hidden', 'true');
  overlay.append(marks);
  stage.append(overlay);
  const endpoints = [];
  let drag;
  let frame = 0;
  let scroller;
  function repaint() {
    frame = 0;
    if (signal.aborted || !endpoints.length) return;
    const bounds = stage.getBoundingClientRect();
    const visible = viewport.getBoundingClientRect();
    const edge = 36;
    if (drag) {
      const above = visible.top + edge - drag.y;
      const below = drag.y - (visible.bottom - edge);
      const speed = below > 0 ? Math.min(12, below / 4) : above > 0 ? -Math.min(12, above / 4) : 0;
      if (speed) {
        const top = scroller.scrollTop;
        scroller.scrollTop += speed;
        if (scroller.scrollTop !== top) progress.followScroll = true;
      }
      const y = Math.max(visible.top + 3, Math.min(visible.bottom - 3, drag.y));
      const x = Math.max(visible.left + 3, Math.min(visible.right - 3, drag.x));
      const contents = rendition.getContents().find(contents => {
        const rect = contents.window.frameElement?.getBoundingClientRect();
        return rect && y >= rect.top && y < rect.bottom;
      });
      if (contents) {
        const rect = contents.window.frameElement.getBoundingClientRect();
        const doc = contents.document;
        const caret = doc.caretRangeFromPoint?.(x - rect.left, y - rect.top);
        if (caret && caret.startContainer.nodeType === Node.TEXT_NODE) {
          const target = location(contents, caret.startContainer, caret.startOffset);
          const order = cfiOrder.compare(target.cfi, endpoints[1 - drag.index].cfi);
          if (drag.index === 0 ? order < 0 : order > 0) endpoints[drag.index] = target;
        }
      }
    }

    const rectangles = document.createDocumentFragment();
    handles.forEach((handle, index) => { handle.hidden = drag?.index !== index; });
    const [start, end] = endpoints;
    for (const contents of rendition.getContents()) {
      const index = contents.sectionIndex;
      const rect = contents.window.frameElement?.getBoundingClientRect();
      if (!rect || rect.bottom <= visible.top || rect.top >= visible.bottom ||
          index < start.index || index > end.index) continue;
      const range = sectionRange(contents.document, index, start, end);
      for (const line of range.getClientRects()) {
        const top = Math.max(line.top + rect.top, visible.top);
        const bottom = Math.min(line.bottom + rect.top, visible.bottom);
        const left = Math.max(line.left + rect.left, visible.left);
        const right = Math.min(line.right + rect.left, visible.right);
        if (bottom <= top || right <= left) continue;
        const mark = document.createElement('i');
        Object.assign(mark.style, {
          left: left - bounds.left + 'px', top: top - bounds.top + 'px',
          width: right - left + 'px', height: bottom - top + 'px',
        });
        rectangles.append(mark);
      }
      endpoints.forEach((point, i) => {
        if (point.index !== index || drag?.index === i) return;
        const caret = new ePub.CFI(point.cfi).toRange(contents.document).getBoundingClientRect();
        const y = caret.bottom + rect.top;
        const x = caret.left + rect.left;
        if (!caret.height || y < visible.top || y > visible.bottom ||
            x < visible.left || x > visible.right) return;
        placeHandle(handles[i], x, y, bounds);
      });
    }
    if (drag) {
      placeHandle(handles[drag.index],
        Math.max(visible.left + 12, Math.min(visible.right - 12, drag.x)),
        Math.max(visible.top + 12, Math.min(visible.bottom - 12, drag.y)), bounds);
      schedule();
    }
    marks.replaceChildren(rectangles);
  }

  function placeHandle(handle, x, y, bounds) {
    handle.style.left = x - bounds.left + 'px';
    handle.style.top = y - bounds.top + 'px';
    handle.hidden = false;
  }

  function schedule() {
    if (!frame && endpoints.length && !signal.aborted) frame = requestAnimationFrame(repaint);
  }

  const handles = labels.map((label, index) => {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.hidden = true;
    handle.setAttribute('aria-label', label);
    overlay.append(handle);
    handle.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || drag) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const rect = handle.getBoundingClientRect();
      drag = {index, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    });
    handle.addEventListener('pointermove', event => {
      if (drag?.index !== index || !handle.hasPointerCapture(event.pointerId)) return;
      Object.assign(drag, {x: event.clientX, y: event.clientY});
      schedule();
    });
    handle.addEventListener('lostpointercapture', () => {
      drag = null;
      schedule();
    });
    return handle;
  });
  rendition.on('rendered', () => {
    if (!scroller) {
      scroller = rendition.manager.container;
      scroller.addEventListener('scroll', schedule, {signal, passive: true});
    }
    schedule();
  });
  rendition.on('relocated', schedule);
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame);
  }, {once: true});

  return {
    get active() { return endpoints.length > 0; },
    start(contents, range) {
      endpoints.splice(0, 2,
        location(contents, range.startContainer, range.startOffset),
        location(contents, range.endContainer, range.endOffset));
      schedule();
      onChange(true);
    },
    clear() {
      endpoints.length = 0;
      drag = null;
      marks.replaceChildren();
      handles.forEach(handle => { handle.hidden = true; });
      onChange(false);
    },
    async parts() {
      const [start, end] = endpoints;
      if (!start) return [];
      const output = [];
      for (let section = rendition.book.spine.get(start.index);
        section && section.index <= end.index; section = section.next()) {
        const contents = rendition.getContents().find(view => view.sectionIndex === section.index);
        if (!contents) await section.load(rendition.book.load.bind(rendition.book));
        const range = sectionRange(contents?.document ?? section.document, section.index, start, end);
        const text = range.toString().trim();
        if (text) output.push({cfi: section.cfiFromRange(range), text});
      }
      return output;
    },
  };
}
