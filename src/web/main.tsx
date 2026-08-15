import { createRoot } from 'react-dom/client';

const root = document.querySelector<HTMLDivElement>('#root');
if (!root) {
  throw new Error('NUAI web root is missing');
}

createRoot(root).render(
  <main>
    <h1>NUAI</h1>
    <p>not ur avg ai</p>
  </main>,
);
