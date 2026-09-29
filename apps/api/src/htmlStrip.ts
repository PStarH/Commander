/** Delete one element, including a closing tag written as `</tag >`. */
export function removeHtmlElement(value: string, tag: string): string {
  let text = value;
  const open = `<${tag}`;
  const close = `</${tag}`;
  for (;;) {
    const start = text.toLowerCase().indexOf(open);
    if (start < 0) return text;
    const openEnd = text.indexOf('>', start + open.length);
    if (openEnd < 0) return text.slice(0, start);
    const closeStart = text.toLowerCase().indexOf(close, openEnd + 1);
    if (closeStart < 0) return text.slice(0, start);
    const closeEnd = text.indexOf('>', closeStart + close.length);
    if (closeEnd < 0) return text.slice(0, start);
    text = text.slice(0, start) + text.slice(closeEnd + 1);
  }
}

/** Remove every `<...>` span. A `<` with no `>` drops the rest of the string. */
export function stripAngleSpans(value: string): string {
  let text = value;
  for (;;) {
    const start = text.indexOf('<');
    if (start < 0) return text;
    const end = text.indexOf('>', start + 1);
    if (end < 0) return text.slice(0, start);
    text = text.slice(0, start) + text.slice(end + 1);
  }
}

export function stripHtmlComments(value: string): string {
  let text = value;
  for (;;) {
    const start = text.indexOf('<!--');
    if (start < 0) return text;
    const end = text.indexOf('-->', start + 4);
    if (end < 0) return text.slice(0, start);
    text = text.slice(0, start) + text.slice(end + 3);
  }
}
