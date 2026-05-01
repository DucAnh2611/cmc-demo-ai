'use client';

import { useEffect, useState } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { graphTokenRequest } from '@/lib/auth/msalConfig';

interface SourceDoc {
  id: string;
  title: string;
  department?: string;
  sourceUrl?: string;
  content: string;
}

export default function SourcePage({ params }: { params: { id: string } }) {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const router = useRouter();
  const [doc, setDoc] = useState<SourceDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  const acquireToken = async (): Promise<string> => {
    const account = accounts[0];
    if (!account) throw new Error('No active account');
    try {
      const r = await instance.acquireTokenSilent({ ...graphTokenRequest, account });
      return r.accessToken;
    } catch {
      const r = await instance.acquireTokenPopup({ ...graphTokenRequest, account });
      return r.accessToken;
    }
  };

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/login');
      return;
    }
    if (accounts.length === 0) return;

    (async () => {
      try {
        const token = await acquireToken();

        const res = await fetch(`/api/source/${encodeURIComponent(params.id)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (res.status === 404) {
          setError(
            "Document not found, or your account doesn't have permission to view it. " +
              "(This is the ACL filter doing its job — try a user in the right group.)"
          );
        } else if (!res.ok) {
          setError(`Error ${res.status}: ${await res.text()}`);
        } else {
          setDoc(await res.json());
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, accounts, instance, params.id, router]);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const token = await acquireToken();
      const res = await fetch(`/api/source/${encodeURIComponent(params.id)}/raw`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        setError(`Download failed: ${res.status} ${await res.text()}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${params.id}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`Download error: ${(e as Error).message}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="text-sm text-slate-500 underline hover:text-slate-900">
          ← Back to chat
        </Link>

        {loading && <div className="mt-6 text-slate-500">Loading source…</div>}

        {error && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        )}

        {doc && (
          <article className="mt-6 rounded-xl bg-white p-8 shadow">
            <header className="mb-4 flex items-start justify-between gap-4 border-b pb-4">
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold text-slate-900">{doc.title}</h1>
                <div className="mt-1 flex gap-3 text-xs uppercase tracking-wide text-slate-500">
                  {doc.department && <span>{doc.department}</span>}
                  <span>id: {doc.id}</span>
                </div>
                {doc.sourceUrl && !/example\.com/.test(doc.sourceUrl) && (
                  <p className="mt-2 text-xs text-slate-500">
                    Original location:{' '}
                    <a
                      href={doc.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {doc.sourceUrl}
                    </a>
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={handleDownload}
                disabled={downloading}
                className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
                title="Download the original document as Markdown"
              >
                {downloading ? 'Downloading…' : '↓ Download original'}
              </button>
            </header>
            <div className="markdown text-sm text-slate-800">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
            </div>
          </article>
        )}
      </div>
    </main>
  );
}
