import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FloatingView } from './FloatingView';
import { applyStoredTheme } from './theme';
import './styles.css';
applyStoredTheme();
createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.hash==='#floating'?<FloatingView/>:<App />}</React.StrictMode>);
