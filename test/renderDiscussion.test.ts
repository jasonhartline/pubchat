import { describe, expect, it } from 'vitest';
import { renderDiscussion } from '../src/index';

const anchorPost = {
  uri: 'at://did:plc:pubchat/app.bsky.feed.post/anchor',
  cid: 'anchor-cid',
  blueskyUrl: 'https://bsky.app/profile/pubchat.org/post/anchor',
};
const post = {
  uri: 'at://did:plc:reader/app.bsky.feed.post/reply',
  cid: 'reply-cid', text: 'A discussion reply', facets: [], embed: null,
  authorHandle: 'reader.example', authorDisplayName: 'Reader',
  createdAt: '', blueskyUrl: 'https://bsky.app/profile/reader.example/post/reply',
  depth: 0, isRoot: false, avatar: undefined, hasReplies: false,
};

describe('renderDiscussion', () => {
  it.each([
    { name: 'empty', thread: [] },
    { name: 'populated', thread: [post] },
    { name: 'imported', thread: [{ ...post, imported: true }] },
  ])(
    'keeps the anchor action above $name discussions',
    ({ thread }) => {
      const html = renderDiscussion({
        source: 'arxiv', sourceId: '2607.27128',
        metadata: {} as any, anchorPost,
        thread: [{ ...post, uri: anchorPost.uri, text: 'Hidden anchor' }, ...thread],
      });
      expect(html).toContain(`href="${anchorPost.blueskyUrl}"`);
      expect(html).not.toContain('Hidden anchor');
      if (thread.length) {
        expect(html.indexOf(`href="${anchorPost.blueskyUrl}"`)).toBeLessThan(html.indexOf('<article'));
        expect(html).toContain('A discussion reply');
      }
    },
  );
});
