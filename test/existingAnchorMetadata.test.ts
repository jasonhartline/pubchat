import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { abstractExcerptFromAnchorDescription } from '../src/index';

const fixture = vi.hoisted(() => ({ anchorExists: true }));

vi.mock('@atproto/api', () => ({
  AtpAgent: class {
    session = { did: 'did:plc:pubchat', handle: 'pubchat.org' };
    app = {
      bsky: {
        feed: {
          getPostThread: async () => ({
            data: {
              thread: {
                $type: 'app.bsky.feed.defs#threadViewPost',
                post: {
                  uri: 'at://did:plc:pubchat/app.bsky.feed.post/post-rkey',
                  cid: 'post-cid',
                  record: { text: 'Anchor', createdAt: '2026-06-06T11:18:55Z' },
                  author: { handle: 'pubchat.org', displayName: 'PubChat' },
                },
                replies: [{
                  $type: 'app.bsky.feed.defs#threadViewPost',
                  post: {
                    uri: 'at://did:plc:reply/app.bsky.feed.post/reply-rkey',
                    cid: 'reply-cid',
                    record: { text: 'A useful discussion reply', createdAt: '2026-06-07T00:00:00Z' },
                    author: { handle: 'reader.bsky.social', displayName: 'Reader' },
                  },
                  replies: [],
                }],
              },
            },
          }),
        },
      },
    };
    com = {
      atproto: {
        repo: {
          getRecord: async ({ collection }: { collection: string }) => {
            if (collection === 'org.pubchat.anchor') {
              if (!fixture.anchorExists) {
                throw Object.assign(new Error('RecordNotFound'), { status: 404 });
              }
              return {
                data: {
                  cid: 'anchor-cid',
                  value: {
                    source: 'doi',
                    sourceId: '10.1145/3788646.3789529',
                    discussion: {
                      uri: 'at://did:plc:pubchat/app.bsky.feed.post/post-rkey',
                      cid: 'post-cid',
                    },
                  },
                },
              };
            }

            return {
              data: {
                value: {
                  text: '“AI Suppression: E-Discovery Software and Brady” (2026)\nby Jason Hartline, Liren Shan\n\nCC: PubChat',
                  embed: {
                    external: {
                      uri: 'https://pubchat.org/chat/doi/10.1145/3788646.3789529',
                      title: 'AI Suppression: E-Discovery Software and Brady',
                      description: 'by Jason Hartline, Liren Shan\n\nProsecutors regularly rely on AI e-discovery software…',
                    },
                  },
                },
              },
            };
          },
        },
      },
    };

    constructor(_options: unknown) {}
    async login(_credentials: unknown) {}
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('existing DOI anchor metadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    fixture.anchorExists = true;
  });

  it('shows the saved abstract excerpt when providers no longer have one', async () => {
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://api.crossref.org/works/')) {
        return jsonResponse({ message: {
          DOI: '10.1145/3788646.3789529',
          title: ['AI Suppression: E-Discovery Software and Brady'],
          author: [{ given: 'Jason', family: 'Hartline' }],
          published: { 'date-parts': [[2026]] },
        } });
      }
      if (url.startsWith('https://api.openalex.org/')) {
        return jsonResponse({ results: [{
          id: 'https://openalex.org/W7162097538',
          doi: 'https://doi.org/10.1145/3788646.3789529',
          title: 'AI Suppression: E-Discovery Software and Brady',
          publication_year: 2026,
          abstract_inverted_index: null,
          authorships: [{ author: { display_name: 'Jason Hartline' } }],
          locations: [],
        }] });
      }
      return jsonResponse({}, 404);
    }));

    const url = 'https://pubchat.org/chat/doi/10.1145/3788646.3789529';
    const env = { ATP_HANDLE: 'pubchat.org', ATP_APP_PASSWORD: 'test' } as any;
    const response = await worker.fetch(new Request(url), env);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('Prosecutors regularly rely on AI e-discovery software…');
    expect(body).toContain('This abstract excerpt comes from the existing PubChat Bluesky post');
    expect(body).toContain('Abstract excerpt:');
    expect(body).toContain('format=discussion');
    expect(body).not.toContain('by Jason Hartline, Liren Shan Prosecutors');

    const discussionResponse = await worker.fetch(
      new Request(`${url}?format=discussion`), env,
    );
    expect(discussionResponse.status).toBe(200);
    expect(await discussionResponse.text()).toContain('A useful discussion reply');

    fixture.anchorExists = false;
    const missingAnchorResponse = await worker.fetch(new Request(url), env);
    expect(missingAnchorResponse.status).toBe(422);
    expect(await missingAnchorResponse.text()).toContain('Paper metadata is unavailable');
  });

  it('removes the author prefix and rejects a placeholder description', () => {
    expect(abstractExcerptFromAnchorDescription(
      'by Jason Hartline, Liren Shan\n\nProsecutors regularly rely on AI…',
      ['Jason Hartline', 'Liren Shan'],
    )).toBe('Prosecutors regularly rely on AI…');
    expect(abstractExcerptFromAnchorDescription(
      'Discuss this paper on PubChat.',
      ['Jason Hartline'],
    )).toBeNull();
  });
});
