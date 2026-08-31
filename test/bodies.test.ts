import { describe, expect, it } from 'vitest';
import {
  articleText, decodeEntities, looksLikeArticle, skipClass,
} from '../src/pipeline/bodies.js';

const para = (n: number, word = 'sentence') =>
  `<p>${`This is a full ${word} of article prose that runs past the minimum length. `.repeat(n)}</p>`;

describe('pulling article text out of HTML', () => {
  it('takes the paragraphs a publisher marked up as prose', () => {
    const html = `<html><body><article>${para(2)}${para(2, 'clause')}</article></body></html>`;
    const t = articleText(html);
    expect(t).toContain('full sentence of article prose');
    expect(t).toContain('full clause of article prose');
    // Paragraphs stay separated, so the extractor sees structure rather than
    // one run-on string it has to date and attribute as a whole.
    expect(t).toContain('\n\n');
  });

  it('drops scripts, styles and navigation entirely', () => {
    const html = `<html><body>
      <script>var tracking = "should never appear";</script>
      <style>.x{color:red}</style>
      <nav><a href="/">Home should never appear</a></nav>
      <article>${para(3)}</article>
      <footer>Footer should never appear</footer>
    </body></html>`;
    const t = articleText(html);
    expect(t).not.toContain('tracking');
    expect(t).not.toContain('Home should never appear');
    expect(t).not.toContain('Footer should never appear');
    expect(t).toContain('full sentence of article prose');
  });

  // The container is only trusted once it holds enough text to be a story;
  // below that we fall back to the page, which is why this fixture is realistic
  // in length rather than minimal.
  it('prefers the article container over the whole page', () => {
    const html = `<html><body>
      <div><p>Sidebar teaser copy that is long enough to look like a paragraph here.</p></div>
      <article>${para(8, 'body')}</article>
    </body></html>`;
    const t = articleText(html);
    expect(t).toContain('full body of article prose');
    expect(t).not.toContain('Sidebar teaser');
  });

  it('finds the body in a publisher div when there is no article tag', () => {
    const html = `<html><body><div class="story-body wrapper">${para(3)}</div></body></html>`;
    expect(articleText(html)).toContain('full sentence of article prose');
  });

  it('decodes the entities that actually appear in news copy', () => {
    expect(decodeEntities('Trump&rsquo;s deal &amp; the &ldquo;terms&rdquo;'))
      .toBe('Trump’s deal & the “terms”');
    expect(decodeEntities('&#8212; dash')).toBe('— dash');
    expect(decodeEntities('&#x2014; dash')).toBe('— dash');
  });

  it('leaves an unknown entity alone rather than mangling it', () => {
    expect(decodeEntities('a &notarealentity; b')).toBe('a &notarealentity; b');
  });
});

describe('deciding whether we actually got an article', () => {
  const long = `This is a real paragraph of article prose. `.repeat(30);

  it('accepts a body that is long enough and reads as prose', () => {
    expect(looksLikeArticle(long, null)).toBe(true);
  });

  it('rejects a body too short to be a story', () => {
    expect(looksLikeArticle('Two short words.', null)).toBe(false);
  });

  // The dangerous failure is not an empty body, it is a plausible one: a
  // consent wall is several hundred words of real English, and storing it means
  // everything downstream treats it as the article.
  it('rejects a consent wall', () => {
    const wall = `Please enable javascript to continue. ${long}`;
    expect(looksLikeArticle(wall, null)).toBe(false);
  });

  it('rejects a paywall notice', () => {
    const wall = `Subscribe to continue reading this article. ${long}`;
    expect(looksLikeArticle(wall, null)).toBe(false);
  });

  it('rejects a bot check', () => {
    expect(looksLikeArticle(`Access denied. ${long}`, null)).toBe(false);
  });

  // No point storing a "body" that is the blurb we already hold.
  it('rejects a body no longer than the summary already on file', () => {
    const summary = long.slice(0, 900);
    expect(looksLikeArticle(long.slice(0, 1000), summary)).toBe(false);
    expect(looksLikeArticle(long, summary)).toBe(true);
  });
});

describe('reporting why a body was not stored', () => {
  // A reason carrying the URL makes every skip unique and the tally useless,
  // which is exactly what the first run printed.
  it('collapses a status code to its class, dropping the URL', () => {
    expect(skipClass('HTTP 403 Forbidden for https://www.nytimes.com/2026/08/28/business/x'))
      .toBe('blocked or paywalled');
    expect(skipClass('HTTP 401 for https://example.com/a')).toBe('blocked or paywalled');
    expect(skipClass('HTTP 404 for https://example.com/b')).toBe('HTTP 404');
  });

  it('names the other classes plainly', () => {
    expect(skipClass('no article text')).toBe('no article text found');
    expect(skipClass('not html')).toBe('not an HTML page');
    expect(skipClass('socket hang up')).toBe('fetch failed');
    expect(skipClass(null)).toBe('unknown');
  });

  it('groups two different blocked URLs under one heading', () => {
    const a = skipClass('HTTP 403 Forbidden for https://www.nytimes.com/one');
    const b = skipClass('HTTP 403 Forbidden for https://www.axios.com/two');
    expect(a).toBe(b);
  });
});
