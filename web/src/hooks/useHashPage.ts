import { useCallback, useEffect, useState } from 'react';

export const PAGE_IDS = ['overview', 'claims', 'approvals', 'customers', 'finance', 'ledger', 'audit', 'policies', 'breakit'] as const;
export type PageId = (typeof PAGE_IDS)[number];

function readHash(): PageId {
  const id = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return (PAGE_IDS as readonly string[]).includes(id) ? (id as PageId) : 'overview';
}

export function useHashPage(): [PageId, (page: PageId) => void] {
  const [page, setPage] = useState<PageId>(readHash);

  useEffect(() => {
    const onHashChange = () => setPage(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: PageId) => {
    window.location.hash = next === 'overview' ? '' : `/${next}`;
    setPage(next);
  }, []);

  return [page, navigate];
}
