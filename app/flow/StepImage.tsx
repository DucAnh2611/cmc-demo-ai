'use client';

import { useEffect, useState } from 'react';

interface StepImageProps {
  /** First half of the filename — e.g. 'group' or 'user'. */
  type: string;
  /** Step number — second half of the filename. */
  step: number;
  /** Optional alt text override. */
  alt?: string;
}

/**
 * Click-to-zoom screenshot for a Setup step. Looks for
 *   /assets/{type}_step_{step}.png
 * (i.e. file at `public/assets/<type>_step_<step>.png` in the repo).
 *
 * Behaviour:
 *   - If the image 404s, the component silently hides itself — the
 *     surrounding step text still renders. Lets you add screenshots
 *     incrementally without breaking the page when one is missing.
 *   - Thumbnail click opens a full-size modal preview. Modal closes on
 *     Escape, on backdrop click, or via the explicit Close button.
 */
export default function StepImage({ type, step, alt }: StepImageProps) {
  const src = `/assets/${type}_step_${step}.png`;
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState(false);
  const altText = alt ?? `${type} setup step ${step}`;

  // Esc closes the modal. Body scroll lock prevents the page from
  // jumping when the user opens the preview.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (missing) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group mt-2 block overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md"
        title="Click to view larger"
        aria-label={`View larger: ${altText}`}
      >
        {/* Plain <img> (not next/image) so we don't need to declare
            width/height upfront — screenshots vary in dimensions and
            we want to render whatever the user dropped in. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={altText}
          onError={() => setMissing(true)}
          className="block max-h-56 w-auto transition-transform group-hover:scale-[1.02]"
        />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={altText}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={altText}
            className="max-h-[95vh] max-w-[95vw] cursor-default rounded-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-4 top-4 rounded-full bg-white/95 px-3 py-1.5 text-sm font-medium text-slate-900 shadow hover:bg-white"
            aria-label="Close preview"
          >
            ✕ Close
          </button>
        </div>
      )}
    </>
  );
}
