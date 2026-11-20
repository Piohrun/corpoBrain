/**
 * One line of Markdown as the words a reader would see: for places that show
 * a note's text inside a button or a list row, where the markup itself
 * (`[[people/Navid]]`, `**Structure:**`) is only noise and links cannot be
 * made live.
 */
export function plainMarkdown(
  text: string,
  titleFor: (target: string) => string | null | undefined,
): string {
  return (
    text
      // an embedded image or note is not text
      .replace(/!\[\[[^\]]*\]\]/g, '')
      // [[target#heading|alias]] → alias, else the linked note's title, else its name
      .replace(/\[\[([^[\]|#]*)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g, (_m, target, _h, alias) => {
        const bare = String(target ?? '').trim();
        if (alias?.trim()) return alias.trim();
        return titleFor(bare) ?? (bare.split('/').pop() || bare);
      })
      // a snippet cut in the middle of a link: the half link says nothing
      .replace(/\s*!?\[\[[^\]]*$/, '…')
      // [label](url) → label; <https://…> → the address
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      // comments (tracking markers, mirror markers) carry nothing to read
      .replace(/<!--[\s\S]*?-->/g, '')
      // the few inline tags notes may use
      .replace(/<\/?(?:u|sup|sub|kbd|mark|s|small|span|br)\b[^>]*>/gi, '')
      // what starts a line: quote, heading, list marker, task box
      .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+)?(?:[-*+]\s+|\d+[.)]\s+)?(?:[jJ]?\[[ xX]\]\s+)?/, '')
      // emphasis, highlight, strikethrough, inline code
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
      .replace(/==(?=\S)([\s\S]*?\S)==/g, '$1')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
