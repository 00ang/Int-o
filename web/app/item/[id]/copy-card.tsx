'use client';

import { useState } from 'react';

/**
 * Copies the item's text card, rendered on the server from what is on file.
 *
 * The text arrives with the page so the copy happens inside the click itself;
 * a copy after a fetch loses the click in some browsers. The clipboard API
 * only exists on a secure origin, so opening the app over the LAN falls back to
 * selecting the text and the older copy command.
 */
export default function CopyCard({ text, label = 'Copy card for the group chat' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  function fallbackCopy(): boolean {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  async function copy() {
    let ok = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
    }
    if (!ok) ok = fallbackCopy();
    setState(ok ? 'copied' : 'failed');
    if (ok) setTimeout(() => setState('idle'), 2500);
  }

  return (
    <div>
      <button type="button" className="btn btn-go" onClick={copy}>
        {state === 'copied' ? 'Copied' : label}
      </button>
      {state === 'failed' ? (
        <span style={{ marginLeft: 12, color: 'var(--stamp)' }}>
          Could not reach the clipboard. Open the preview and copy it by hand.
        </span>
      ) : null}
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: 'pointer' }}>Preview</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 8, fontSize: '0.85rem' }}>
          {text}
        </pre>
      </details>
    </div>
  );
}
