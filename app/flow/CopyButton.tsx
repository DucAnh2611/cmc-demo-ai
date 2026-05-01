'use client';

import { useState } from 'react';

/**
 * Client-only copy-to-clipboard pill. Used inline next to demo credentials
 * on the public /flow page. Falls back to a 1.5s "Copied" label flash so
 * the user gets visual confirmation without a toast / modal.
 */
export default function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers without the Clipboard API: fall back to a hidden
      // <textarea> + execCommand. Best-effort; no error UI for the demo.
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // give up silently
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`ml-2 inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${
        copied
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
          : 'border-slate-300 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
      aria-label={copied ? 'Copied' : `Copy ${label ?? value}`}
      title={copied ? 'Copied' : `Copy ${label ?? 'value'}`}
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}
