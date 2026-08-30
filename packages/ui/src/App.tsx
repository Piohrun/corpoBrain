import { useEffect, useState } from 'react';

export function App() {
  const [health, setHealth] = useState<string>('…');
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((j: { spec: string }) => setHealth(`spec ${j.spec}`))
      .catch(() => setHealth('server unreachable'));
  }, []);
  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem' }}>
      <h1>corpoBrain</h1>
      <p>Phase 0 scaffold. Server: {health}</p>
    </main>
  );
}
