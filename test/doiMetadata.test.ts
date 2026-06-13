import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chatPathForInput,
  crossrefPdfCandidates,
  fetchOpenAlexSsrnUrlMetadata,
  fetchSsrnMetadata,
  openAlexPdfCandidates,
  selectDoiAbstract,
  selectDoiTitle,
  selectPdfUrl,
  unpaywallPdfCandidates,
} from '../src/index';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('DOI metadata helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('strips provider HTML formatting from DOI titles', () => {
    expect(selectDoiTitle([
      {
        provider: 'crossref',
        matchedBy: 'exact-doi',
        title: 'AI Suppression: E-Discovery Software and <i>Brady</i>',
      },
    ])).toBe('AI Suppression: E-Discovery Software and Brady');
  });

  it('extracts Crossref PDF links from structured link metadata', () => {
    const candidates = crossrefPdfCandidates({
      link: [
        {
          URL: 'https://publisher.test/doi/pdf/10.1234/example',
          'content-type': 'application/pdf',
          'content-version': 'vor',
        },
        {
          URL: 'https://publisher.test/doi/abs/10.1234/example',
          'content-type': 'text/html',
        },
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      url: 'https://publisher.test/doi/pdf/10.1234/example',
      provider: 'crossref',
      kind: 'publisher',
      version: 'published',
      verifiedPdf: true,
    });
  });

  it('uses OpenAlex location DOI abstracts when registry abstracts are missing', () => {
    expect(selectDoiAbstract([
      {
        provider: 'crossref',
        matchedBy: 'exact-doi',
        abstract: null,
      },
      {
        provider: 'openalex',
        matchedBy: 'location-doi',
        abstract: 'Recovered from OpenAlex.',
      },
    ])).toBe('Recovered from OpenAlex.');
  });

  it('prefers OpenAlex repository PDFs over publisher PDFs', () => {
    const candidates = [
      ...crossrefPdfCandidates({
        link: [
          {
            URL: 'https://publisher.test/doi/pdf/10.1234/example',
            'content-type': 'application/pdf',
            'content-version': 'vor',
          },
        ],
      }),
      ...openAlexPdfCandidates({
        best_oa_location: {
          pdf_url: 'https://arxiv.org/pdf/1604.06443',
          source: { type: 'repository' },
        },
      }),
    ];

    expect(selectPdfUrl(candidates)).toBe('https://arxiv.org/pdf/1604.06443');
  });

  it('extracts Unpaywall PDF locations', () => {
    const candidates = unpaywallPdfCandidates({
      best_oa_location: {
        url_for_pdf: 'https://arxiv.org/pdf/1604.06443',
        host_type: 'repository',
        version: 'submittedVersion',
      },
      oa_locations: [
        {
          url_for_pdf: 'https://publisher.test/open/example.pdf',
          host_type: 'publisher',
          version: 'publishedVersion',
        },
      ],
    });

    expect(candidates).toHaveLength(2);
    expect(selectPdfUrl(candidates)).toBe('https://arxiv.org/pdf/1604.06443');
  });

  it('does not select landing pages as PDFs', () => {
    expect(selectPdfUrl([
      {
        url: 'https://publisher.test/articles/10.1234/example',
        provider: 'crossref',
        kind: 'publisher',
        matchedBy: 'exact-doi',
      },
    ])).toBeUndefined();
  });

  it('routes SSRN URLs to the SSRN chat source', () => {
    expect(chatPathForInput(
      'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3817621',
    )).toBe('/chat/ssrn/3817621');

    expect(chatPathForInput(
      'https://ssrn.com/abstract=3817621',
    )).toBe('/chat/ssrn/3817621');

    expect(chatPathForInput(
      'https://autopapers.ssrn.com/sol3/papers.cfm?abstract_id=143834',
    )).toBe('/chat/ssrn/143834');

    expect(chatPathForInput(
      'https://papers.ssrn.com/sol3/Delivery.cfm/nber_w5661.pdf?abstractid=7788',
    )).toBe('/chat/ssrn/7788');
  });

  it('resolves SSRN metadata through the DOI composite workflow', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('https://api.crossref.org/works/')) {
        return jsonResponse({
          message: {
            DOI: '10.2139/ssrn.6602721',
            title: [
              'Aerodynamic and Propulsion Optimization Design of Electric Aircraft',
            ],
            abstract: '<jats:p>Recovered from Crossref.</jats:p>',
            author: [
              { given: 'Zhang', family: 'Ruilin' },
              { given: 'Dan', family: 'Min' },
            ],
            published: { 'date-parts': [[2026]] },
            URL: 'https://doi.org/10.2139/ssrn.6602721',
          },
        });
      }

      if (url.startsWith('https://api.datacite.org/')) {
        return jsonResponse({}, 404);
      }

      if (url.startsWith('https://api.openalex.org/')) {
        return jsonResponse({ results: [] });
      }

      return jsonResponse({}, 404);
    }));

    const metadata = await fetchSsrnMetadata({} as any, '6602721');

    expect(metadata).toMatchObject({
      title: 'Aerodynamic and Propulsion Optimization Design of Electric Aircraft',
      abstract: 'Recovered from Crossref.',
      authors: ['Zhang Ruilin', 'Dan Min'],
      year: 2026,
      source: 'ssrn',
      sourceId: '6602721',
      homeUrl: 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6602721',
      doi: '10.2139/ssrn.6602721',
      metadataProvider: 'doi-composite',
    });
  });

  it('resolves SSRN metadata from OpenAlex SSRN landing-page locations', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const parsed = new URL(url);

      expect(parsed.searchParams.get('filter')).toBe(
        'locations.landing_page_url:https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1496199',
      );

      return jsonResponse({
        results: [
          {
            id: 'https://openalex.org/W3124182182',
            doi: null,
            title: 'The Theory of Economic Development',
            publication_year: 1934,
            abstract_inverted_index: {
              Recovered: [0],
              from: [1],
              OpenAlex: [2],
            },
            authorships: [
              { author: { display_name: 'Joseph A. Schumpeter' } },
            ],
            primary_location: {
              landing_page_url: 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1496199',
              pdf_url: null,
            },
            locations: [
              {
                landing_page_url: 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1496199',
                pdf_url: null,
              },
            ],
          },
        ],
      });
    }));

    const metadata = await fetchOpenAlexSsrnUrlMetadata({} as any, '1496199');

    expect(metadata).toMatchObject({
      title: 'The Theory of Economic Development',
      abstract: 'Recovered from OpenAlex',
      authors: ['Joseph A. Schumpeter'],
      year: 1934,
      source: 'ssrn',
      sourceId: '1496199',
      homeUrl: 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1496199',
      metadataProvider: 'openalex',
    });
  });
});
