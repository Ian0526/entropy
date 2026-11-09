import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Hosted from './Hosted';
import MorphoLab from './morpho/MorphoLab';
import './index.css';

// ?view=wallpaper | preview: the bare world the desktop app hosts (also reachable as /wallpaper).
// Anything else: the lab (the website).
const view = new URLSearchParams(window.location.search).get('view')
  ?? (window.location.pathname.replace(/\/+$/, '') === '/wallpaper' ? 'wallpaper' : null);
const page = view === 'wallpaper' || view === 'preview' ? <Hosted view={view} /> : <MorphoLab />;

createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>);
