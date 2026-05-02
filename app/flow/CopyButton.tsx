'use client';

import { useState } from 'react';

interface CopyButtonProps {
  value: string;
  label?: string;
  /** 'pill' (default) renders the bordered "Copy" / "✓ Copied" pill used
   *  inline next to demo credentials on /flow. 'icon' renders just a
   *  clipboard glyph (→ checkmark on success), suitable for tight rows
   *  like the demo-questions list on the home page. */
  variant?: 'pill' | 'icon';
}

const ClipboardIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const CheckIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/**
 * Client-only copy-to-clipboard button. Default 'pill' variant is the
 * bordered "Copy" / "✓ Copied" pill used inline next to demo credentials
 * on the public /flow page. 'icon' variant is a tighter clipboard-glyph
 * button used in row-style lists. Both fall back to a hidden-textarea +
 * execCommand path when navigator.clipboard isn't available.
 */
export default function CopyButton({ value, label, variant = 'pill' }: CopyButtonProps) {
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

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={handleCopy}
        className={`inline-flex shrink-0 items-center justify-center rounded p-1 transition-colors ${
          copied
            ? 'text-emerald-600'
            : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
        }`}
        aria-label={copied ? 'Copied' : `Copy ${label ?? value}`}
        title={copied ? 'Copied' : 'Copy to clipboard'}
      >
        {copied ? CheckIcon : ClipboardIcon}
      </button>
    );
  }

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
