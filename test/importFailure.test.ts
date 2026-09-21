import { describe, expect, it, vi } from 'vitest';
import { fetchDiscussionThreadWithImports } from '../src/index';

const anchorUri =
  'at://did:plc:pubchat/app.bsky.feed.post/anchor-rkey';
const importedUri =
  'at://did:plc:imported/app.bsky.feed.post/imported-rkey';
const importedUrl =
  'https://bsky.app/profile/imported.example/post/imported-rkey';

function anchorThread() {
  return {
    data: {
      thread: {
        $type: 'app.bsky.feed.defs#threadViewPost',
        post: {
          uri: anchorUri,
          cid: 'anchor-cid',
          record: { text: 'Anchor', createdAt: '2026-09-21T00:00:00Z' },
          author: { handle: 'pubchat.org' },
          replyCount: 1,
        },
        replies: [{
          $type: 'app.bsky.feed.defs#threadViewPost',
          post: {
            uri: 'at://did:plc:reader/app.bsky.feed.post/import-rkey',
            cid: 'import-cid',
            record: {
              text: 'bsky.app/profile/impo...',
              facets: [{
                features: [{
                  $type: 'app.bsky.richtext.facet#link',
                  uri: importedUrl,
                }],
              }],
              createdAt: '2026-09-21T00:01:00Z',
            },
            author: { handle: 'reader.example' },
            replyCount: 0,
          },
          replies: [],
        }],
      },
    },
  };
}

describe('Bluesky thread imports', () => {
  it('fails the discussion when an import handle cannot be resolved', async () => {
    const agent = {
      app: { bsky: { feed: { getPostThread: vi.fn(async () => anchorThread()) } } },
      com: { atproto: { identity: {
        resolveHandle: vi.fn(async () => { throw new Error('temporary failure'); }),
      } } },
    } as any;

    await expect(fetchDiscussionThreadWithImports(agent, anchorUri)).rejects
      .toThrow(`Could not resolve imported Bluesky thread URL ${importedUrl}`);
  });

  it('fails the discussion when the imported thread cannot be fetched', async () => {
    const getPostThread = vi.fn(async ({ uri }: { uri: string }) => {
      if (uri === anchorUri) return anchorThread();
      throw new Error('temporary failure');
    });
    const agent = {
      app: { bsky: { feed: { getPostThread } } },
      com: { atproto: { identity: {
        resolveHandle: vi.fn(async () => ({ data: { did: 'did:plc:imported' } })),
      } } },
    } as any;

    await expect(fetchDiscussionThreadWithImports(agent, anchorUri)).rejects
      .toThrow(`Could not fetch imported Bluesky thread ${importedUri}`);
  });
});
