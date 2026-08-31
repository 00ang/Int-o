import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ALL-INT',
  description: 'Personal intelligence system: primary records, triaged and followed.',
};

const NAV = [
  { href: '/', label: 'Queue' },
  { href: '/map', label: 'Map' },
  { href: '/entities', label: 'Parties' },
  { href: '/search', label: 'Search' },
  { href: '/status', label: 'Status' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400&family=Special+Elite&display=swap"
        />
      </head>
      <body>
        {/* Not a real classification. The register is the point; the joke is not. */}
        <div className="classbar">
          Unclassified &middot; personal working file &middot; <em>machine judgement, not finding</em>
        </div>

        <header className="docheader">
          <div className="wrap">
            {/* The cable header block: field label, value, in a ruled grid. */}
            <div className="fieldblock">
              <div><b>Docn</b> ALL-INT/{today.replace(/-/g, '')}</div>
              <div><b>Clas</b> UNCLAS</div>
              <div><b>Sour</b> Open literature</div>
              <div><b>Hand</b> No restriction</div>
            </div>

            <div className="masthead">
              <div>
                <h1 className="wordmark"><a href="/">All-Int</a></h1>
                <p className="subtitle">All-source intelligence &mdash; reading queue</p>
              </div>
              <span className="stamp stamp-red">Working copy</span>
            </div>

            <nav className="docnav">
              {NAV.map((n) => <a key={n.href} href={n.href}>{n.label}</a>)}
            </nav>
          </div>
        </header>

        <main><div className="wrap">{children}</div></main>

        <footer>
          <div className="wrap">
            <p>
              ALL-INT reads primary records and credible press, judges what deserves a second
              look, and goes digging only when asked.<br />
              Verdicts here are machine judgements about <b>where to look</b>. They are not
              findings, and nothing asserts wrongdoing by any party.
            </p>
            <div className="blots" aria-hidden="true"><i /><i /><i /></div>
          </div>
        </footer>
        <div className="classbar">Unclassified &middot; end of document</div>
      </body>
    </html>
  );
}
