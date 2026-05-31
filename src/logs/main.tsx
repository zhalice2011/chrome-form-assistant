import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../sidepanel/index.css';
import { LogsApp } from './LogsApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LogsApp />
  </StrictMode>,
);
