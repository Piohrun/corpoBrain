import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

describe('server scaffold', () => {
  it('answers /api/health', async () => {
    const res = await createApp().request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
