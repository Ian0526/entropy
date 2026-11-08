import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { UnlockPage } from './builder/UnlockPage';
import './index.css';

const route = window.location.pathname.replace(/\/+$/, '') || '/';
// /builder is kept as a link that opens the app with the Builder chat open.
if (route === '/builder') window.history.replaceState(null, '', '/?builder=1');
const Page = route === '/unlock' ? UnlockPage : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
