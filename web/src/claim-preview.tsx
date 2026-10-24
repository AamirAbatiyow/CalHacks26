import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ClaimPage from './pages/Claim';
import { Sidebar } from './components/Sidebar';
import './index.css';
import './App.css';

function ClaimPreview() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <ClaimPage claimId="CLM-10021" />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClaimPreview />
  </StrictMode>,
);
