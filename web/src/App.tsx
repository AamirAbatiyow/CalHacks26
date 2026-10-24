import { useState, useMemo, useCallback } from 'react';
import { Sidebar, type PageId } from './components/Sidebar';
import { KpiStrip } from './components/KpiStrip';
import { useSpacetimeDB } from './hooks/useSpacetimeDB';
import { OverviewPage } from './pages/Overview';
import { ClaimsPage } from './pages/Claims';
import { ApprovalsPage } from './pages/Approvals';
import { FinancePage } from './pages/Finance';
import { PoliciesPage } from './pages/Policies';
import { BreakItPage } from './pages/BreakIt';
import { ClaimStatus } from './types';
import './App.css';
    
function App() {
  const [activePage, setActivePage] = useState<PageId>('overview');
  
  const {
    connected,
    stations,
    satellites,
    passes,
    spaceWeather,
    simClock,
    kpi,
    claims,
    setPlaybackPlaying,
    setPlaybackSpeedDb,
    seekToTime,
    goLive,
    approveClaim,
    denyClaim,
    editClaim,
  } = useSpacetimeDB();

  const pendingApprovalsCount = useMemo(() => 
    claims.filter(c => c.status === ClaimStatus.Pending).length,
    [claims]
  );

  const handleNavigate = useCallback((page: PageId) => {
    setActivePage(page);
  }, []);

  const renderPage = () => {
    switch (activePage) {
      case 'overview':
        return (
          <OverviewPage
            stations={stations}
            satellites={satellites}
            passes={passes}
            spaceWeather={spaceWeather}
            simClock={simClock}
            setPlaybackPlaying={setPlaybackPlaying}
            setPlaybackSpeedDb={setPlaybackSpeedDb}
            seekToTime={seekToTime}
            goLive={goLive}
          />
        );
      case 'claims':
        return <ClaimsPage />;
      case 'approvals':
        return (
          <ApprovalsPage
            claims={claims}
            approveClaim={approveClaim}
            denyClaim={denyClaim}
            editClaim={editClaim}
          />
        );
      case 'finance':
        return <FinancePage />;
      case 'policies':
        return <PoliciesPage />;
      case 'breakit':
        return <BreakItPage />;
      default:
        return (
          <OverviewPage
            stations={stations}
            satellites={satellites}
            passes={passes}
            spaceWeather={spaceWeather}
            simClock={simClock}
            setPlaybackPlaying={setPlaybackPlaying}
            setPlaybackSpeedDb={setPlaybackSpeedDb}
            seekToTime={seekToTime}
            goLive={goLive}
          />
        );
    }
  };

  return (
    <div className="app">
      <Sidebar 
        activePage={activePage} 
        onNavigate={handleNavigate}
        pendingApprovalsCount={pendingApprovalsCount}
      />
      <main className="main">
        <KpiStrip kpi={kpi} connected={connected} />
        <div className="page-content">
          {renderPage()}
        </div>
      </main>
    </div>
  );
}

export default App;
