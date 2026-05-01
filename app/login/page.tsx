'use client';

import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import Link from 'next/link';
import { loginRequest } from '@/lib/auth/msalConfig';

export default function LoginPage() {
  const { instance } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const router = useRouter();

  useEffect(() => {
    if (isAuthenticated) router.replace('/');
  }, [isAuthenticated, router]);

  const handleLogin = () => {
    instance.loginRedirect(loginRequest).catch((e) => console.error(e));
  };

  return (
    <main className="flex h-screen items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="text-2xl font-semibold text-slate-900">Secure RAG Demo</h1>
        <p className="mt-2 text-sm text-slate-600">
          Permission-aware Document Q&A using Microsoft Entra ID + Azure AI Search + Claude.
        </p>
        <button
          type="button"
          onClick={handleLogin}
          className="mt-6 w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
        >
          Sign in with Microsoft
        </button>
        <p className="mt-4 text-xs text-slate-500">
          Use a demo account (e.g. <code>alice@yourtenant.onmicrosoft.com</code>) provisioned in Entra ID.
        </p>
        <div className="mt-6 border-t border-slate-200 pt-4 text-xs text-slate-500">
          <Link href="/flow" className="underline hover:text-slate-900">
            How it works — security &amp; document flow →
          </Link>
        </div>
      </div>
    </main>
  );
}
