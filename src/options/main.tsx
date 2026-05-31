import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../sidepanel/index.css'; // 共用 tailwind 入口
import { OptionsApp } from './OptionsApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
