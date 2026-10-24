import { useCallback, useEffect, useState } from 'react';

export const PAGE_IDS = ['overview', 'claims', 'approvals', 'decisions', 'customers', 'finance', 'ledger', 'audit', 'policies', 'breakit', 'settings'] as const;
export type PageId = (typeof PAGE_IDS)[number];

function readHash(): PageId {
  const id = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return (PAGE_IDS as readonly string[]).includes(id) ? (id as PageId) : 'overview';
}

function readHashParam(): string | null {
  const param = window.location.hash.replace(/^#\/?/, '').split(/[?]/)[0].split('/')[1];
  return param ? decodeURIComponent(param) : null;
}

/** The record id after the page in the hash, e.g. `CLM-10021` in `#/claims/CLM-10021`. */
export function useHashParam(): string | null {
  const [param, setParam] = useState<string | null>(readHashParam);

  useEffect(() => {
    const onHashChange = () => setParam(readHashParam());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return param;
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
