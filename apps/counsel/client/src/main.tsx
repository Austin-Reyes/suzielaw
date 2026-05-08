import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfirmDialogProvider, SidePanelProvider } from '@teamsuzie/ui';
import { DocSidePanelProvider } from './components/document-side-panel.js';
import App from './App.js';
import './csrf.js';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ConfirmDialogProvider>
        <SidePanelProvider>
          <DocSidePanelProvider>
            <App />
          </DocSidePanelProvider>
        </SidePanelProvider>
      </ConfirmDialogProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
