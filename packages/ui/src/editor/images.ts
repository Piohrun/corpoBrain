/**
 * Images in live preview: `![[shot.png]]`, `![[shot.png|300]]` (width, like
 * Obsidian) and `![alt](path/shot.png)` render as the image. Off the cursor
 * line the syntax is replaced by the image; on it the text stays editable
 * and the image shows below it. Only images in the vault are loaded —
 * remote URLs stay links, so a note never pings a server by being opened.
 */
import { type EditorView, WidgetType } from '@codemirror/view';

const EXT = '(?:png|jpe?g|gif|webp|avif|bmp|svg)';
const EMBED = new RegExp(
  `!\\[\\[([^[\\]|#]+?\\.${EXT})(?:\\|(\\d{1,4})(?:x(\\d{1,4}))?)?\\]\\]`,
  'gi',
);
const MD_IMAGE = new RegExp(
  `!\\[([^\\]]*)\\]\\(\\s*(<[^>]+\\.${EXT}>|[^)\\s]+?\\.${EXT})(?:\\s+"([^"]*)")?\\s*\\)`,
  'gi',
);

export interface ImageRef {
  from: number;
  to: number;
  ref: string;
  width: number | null;
  alt: string;
}

/** Image references on one line (offsets relative to the line start). */
export function imagesInLine(text: string): ImageRef[] {
  const out: ImageRef[] = [];
  EMBED.lastIndex = 0;
  for (let m = EMBED.exec(text); m; m = EMBED.exec(text)) {
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      ref: (m[1] as string).trim(),
      width: m[2] ? Number(m[2]) : null,
      alt: (m[1] as string).trim(),
    });
  }
  MD_IMAGE.lastIndex = 0;
  for (let m = MD_IMAGE.exec(text); m; m = MD_IMAGE.exec(text)) {
    const ref = (m[2] as string).replace(/^<|>$/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue; // http(s), data: … stay as written
    // `![alt|300](x.png)` sets the width too, as in Obsidian
    const sized = /^(.*?)\|(\d{1,4})$/.exec(m[1] as string);
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      ref,
      width: sized ? Number(sized[2]) : null,
      alt: sized ? (sized[1] as string) : (m[1] as string),
    });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** `![[x.png]]` is an image embed, not a link to a note called "x.png". */
export const isImageTarget = (target: string): boolean =>
  new RegExp(`\\.${EXT}$`, 'i').test(target.trim());

export class ImageWidget extends WidgetType {
  constructor(
    readonly ref: string,
    readonly width: number | null,
    readonly alt: string,
    readonly resolve: ((ref: string) => Promise<string | null>) | undefined,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.ref === this.ref && other.width === this.width && other.alt === this.alt;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span');
    box.className = 'cm-cb-image';
    const img = document.createElement('img');
    img.alt = this.alt;
    img.title = this.ref;
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    img.addEventListener('load', () => view.requestMeasure());
    img.addEventListener('error', () => {
      box.classList.add('missing');
      box.textContent = `image not found: ${this.ref}`;
      view.requestMeasure();
    });
    box.appendChild(img);
    if (!this.resolve) {
      box.classList.add('missing');
      box.textContent = this.ref;
      return box;
    }
    this.resolve(this.ref).then(
      (path) => {
        if (path) img.src = imageUrl(path);
        else {
          box.classList.add('missing');
          box.textContent = `image not found: ${this.ref}`;
          view.requestMeasure();
        }
      },
      () => {
        box.classList.add('missing');
        box.textContent = `image not found: ${this.ref}`;
      },
    );
    return box;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export const imageUrl = (path: string): string =>
  `/api/attachments/file?path=${encodeURIComponent(path)}`;
