import { describe, expect, it } from 'vitest';
import { bootHandler, loadingPage } from '../src/boot.ts';

describe('loading screen while the vault opens', () => {
  it('serves the loading page for pages, waits API calls, and reports boot state', async () => {
    let error: string | null = null;
    let pages = 0;
    const handle = bootHandler(
      '/vaults/My <vault>',
      () => ({ error }),
      () => pages++,
    );
    const get = (path: string) => handle(new Request(`http://127.0.0.1:4747${path}`));

    const page = await get('/#view=jira');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Opening My &#60;vault&#62;…');
    expect(html).not.toContain('<vault>');
    expect(pages).toBe(1);

    expect((await get('/assets/index-abc.js')).status).toBe(404);
    expect(pages).toBe(1); // only pages count as a browser having arrived

    expect((await get('/api/notes')).status).toBe(503);
    expect(await (await get('/api/boot')).json()).toEqual({ ready: false, error: null });
    error = 'unable to open database file';
    expect(await (await get('/api/boot')).json()).toEqual({ ready: false, error });
  });

  it('needs nothing from the server to render', () => {
    const html = loadingPage('/v');
    expect(html).not.toMatch(/<(img|link|script)[^>]+(src|href)=/);
  });
});
