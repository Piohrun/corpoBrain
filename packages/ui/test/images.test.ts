import { describe, expect, it } from 'vitest';
import { imagesInLine, isImageTarget } from '../src/editor/images.ts';

describe('image syntax', () => {
  it('finds embeds with widths and markdown images, in order', () => {
    const line = 'see ![[Pasted image 1.png|300]] and ![chart|200](sub/c.JPG "t") then ![[x.svg]]';
    expect(imagesInLine(line).map(({ ref, width, alt }) => ({ ref, width, alt }))).toEqual([
      { ref: 'Pasted image 1.png', width: 300, alt: 'Pasted image 1.png' },
      { ref: 'sub/c.JPG', width: 200, alt: 'chart' },
      { ref: 'x.svg', width: null, alt: 'x.svg' },
    ]);
  });

  it('leaves remote images, notes and plain links alone', () => {
    expect(imagesInLine('![](https://tracker.example.com/p.png)')).toEqual([]);
    expect(imagesInLine('![[Meeting notes]] [[shot.png]] ![a](<my file.png>)')).toMatchObject([
      { ref: 'my file.png' },
    ]);
    expect(isImageTarget('a.PNG')).toBe(true);
    expect(isImageTarget('notes/a.md')).toBe(false);
  });
});
