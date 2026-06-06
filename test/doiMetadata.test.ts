import { describe, expect, it } from 'vitest';

import {
  crossrefPdfCandidates,
  openAlexPdfCandidates,
  selectDoiAbstract,
  selectDoiTitle,
  selectPdfUrl,
  unpaywallPdfCandidates,
} from '../src/index';

describe('DOI metadata helpers', () => {
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
});
