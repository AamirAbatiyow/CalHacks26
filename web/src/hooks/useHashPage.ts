import { useCallback, useEffect, useState } from 'react';

export const PAGE_IDS = ['overview', 'claims', 'decisions', 'finance', 'policies', 'breakit', 'settings'] as const;
export type PageId = (typeof PAGE_IDS)[number];

/** Old routes that moved: Approvals merged into Claims; Ledger and Audit are Finance tabs. */
const REDIRECTS: Record<string, string> = {
  approvals: 'claims',
  ledger: 'finance/ledger',
  audit: 'finance/audit',
};

function normalizeHash() {
  const [id, ...rest] = window.location.hash.replace(/^#\/?/, '').split('/');
  const target = REDIRECTS[id.split('?')[0]];
  if (target) {
    const suffix = id === 'approvals' && rest.length ? `/${rest.join('/')}` : '';
    window.history.replaceState(null, '', `#/${target}${suffix}`);
  }
}

function readHash(): PageId {
  normalizeHash();
  const id = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return (PAGE_IDS as readonly string[]).includes(id) ? (id as PageId) : 'overview';
}

function readHashParam(): string | null {
  normalizeHash();
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
