'use client';

import { useEffect, useMemo, useState } from 'react';
import { PublicClientApplication, EventType } from '@azure/msal-browser';
import { MsalProvider as MsalReactProvider } from '@azure/msal-react';
import { msalConfig } from '@/lib/auth/msalConfig';

export default function MsalProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const pca = useMemo(() => new PublicClientApplication(msalConfig), []);

  useEffect(() => {
    pca.initialize().then(() => {
      pca.handleRedirectPromise().finally(() => {
        const accounts = pca.getAllAccounts();
        if (accounts.length > 0) {
          pca.setActiveAccount(accounts[0]);
        }
        setReady(true);
      });
    });

    const callbackId = pca.addEventCallback((event) => {
      if (event.eventType === EventType.LOGIN_SUCCESS && event.payload && 'account' in event.payload) {
        // @ts-expect-error - payload narrowing
        pca.setActiveAccount(event.payload.account);
      }
    });

    return () => {
      if (callbackId) pca.removeEventCallback(callbackId);
    };
  }, [pca]);

  if (!ready) {
    return <div className="flex h-screen items-center justify-center text-slate-500">Loading…</div>;
  }

  return <MsalReactProvider instance={pca}>{children}</MsalReactProvider>;
}
