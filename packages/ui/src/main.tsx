import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

try {
  const theme = localStorage.getItem('cb.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  const accent = localStorage.getItem('cb.accent');
  if (accent) document.documentElement.dataset.accent = accent;
  const colors = JSON.parse(localStorage.getItem('cb.colors') ?? '{}') as Record<string, string>;
  for (const [key, value] of Object.entries(colors)) {
    if (/^st-[a-z]+$/.test(key) && /^#[0-9a-fA-F]{6}$/.test(value)) {
      document.documentElement.style.setProperty(`--${key}`, value);
    }
  }
} catch {
  /* storage unavailable */
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
