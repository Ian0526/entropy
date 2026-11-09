import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { UnlockPage } from './builder/UnlockPage';
import Wallpaper from './Wallpaper';
import MorphoLab from './morpho/MorphoLab';
import './index.css';

const route = window.location.pathname.replace(/\/+$/, '') || '/';
// /builder is kept as a link that opens the app with the Builder chat open.
if (route === '/builder') window.history.replaceState(null, '', '/?builder=1');
const Page = route === '/unlock' ? UnlockPage : route === '/wallpaper' ? Wallpaper : route === '/morpho' ? MorphoLab : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
