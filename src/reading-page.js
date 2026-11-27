// Start at the first line that was not fully visible, including a partial line.
export function readingPageOffset(scroller, contents, direction) {
  const bounds = scroller.getBoundingClientRect();
  const top = bounds.top + scroller.clientTop;
  const distance = Math.min(scroller.clientHeight, Math.max(0, window.innerHeight - top));
  const boundary = top + direction * distance;
  const firstLine = textLineAt(contents, boundary)?.top ?? Infinity;
  const target = Number.isFinite(firstLine) ? Math.floor(firstLine - top) : direction * distance;
  return scroller.scrollTop + (Math.sign(target) === direction ? target : direction * distance);
}

export function textLineAt(contents, boundary) {
  const limit = boundary + 64;
  let firstLine;

  for (const content of contents) {
    const frame = content.window?.frameElement?.getBoundingClientRect();
    const doc = content.document;
    if (!frame || !doc?.body || frame.top > limit || frame.bottom < boundary) continue;
    const visit = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    for (let node = visit.nextNode(); node; node = visit.nextNode()) {
      if (!node.data.trim()) continue;
      const parent = node.parentElement.getBoundingClientRect();
      if (parent.bottom + frame.top < boundary || parent.top + frame.top > limit) continue;
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        const lineTop = line.top + frame.top;
        if (line.height && line.bottom + frame.top > boundary + 1 &&
            lineTop <= limit && (!firstLine || lineTop < firstLine.top)) {
          firstLine = {top: lineTop, bottom: line.bottom + frame.top};
        } else if (firstLine?.top === lineTop) {
          firstLine.bottom = Math.max(firstLine.bottom, line.bottom + frame.top);
        }
      }
    }
  }

  return firstLine;
}
