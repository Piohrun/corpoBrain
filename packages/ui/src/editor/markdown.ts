import { markdownKeymap, markdownLanguage, pasteURLAsLink } from '@codemirror/lang-markdown';
import { LanguageSupport } from '@codemirror/language';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';

/**
 * Markdown (GFM) for the editor and the previews, put together by hand
 * instead of calling @codemirror/lang-markdown's `markdown()`.
 *
 * `markdown()` also mounts an HTML parser on embedded tags, and that one
 * brings the JavaScript and CSS parsers with it to highlight `<script>` and
 * `<style>`: about 137 KB of the startup bundle for something notes never
 * show — the few tags a note may use are rendered from the text
 * (safeHtml.ts). What `markdown()` gave the editor is kept: list and quote
 * continuation on Enter, markup-aware Backspace, and pasting a URL over a
 * selection to make it a link. Its heading fold service and HTML tag
 * completion were never reachable here (no folding; completion is overridden).
 */
export function markdownSupport(): LanguageSupport {
  return new LanguageSupport(markdownLanguage, [
    pasteURLAsLink,
    Prec.high(keymap.of(markdownKeymap)),
  ]);
}
