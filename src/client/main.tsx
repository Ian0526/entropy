import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { BuilderPage } from './builder/BuilderPage';
import { UnlockPage } from './builder/UnlockPage';
import './index.css';

const route = window.location.pathname.replace(/\/+$/, '') || '/';
const Page = route === '/builder' ? BuilderPage : route === '/unlock' ? UnlockPage : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
