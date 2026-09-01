import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { lsGet, lsJson } from './storage.ts';
import './styles.css';

// apply the per-browser look before the first paint
const theme = lsGet('cb.theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
const accent = lsGet('cb.accent');
if (accent) document.documentElement.dataset.accent = accent;
for (const [key, value] of Object.entries(lsJson<Record<string, string>>('cb.colors', {}))) {
  if (/^st-[a-z]+$/.test(key) && /^#[0-9a-fA-F]{6}$/.test(value)) {
    document.documentElement.style.setProperty(`--${key}`, value);
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
