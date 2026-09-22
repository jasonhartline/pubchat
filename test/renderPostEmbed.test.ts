import { describe, expect, it } from 'vitest';

import { renderPostEmbed } from '../src/index';
import quotedEmbed from './fixtures/quotedPostEmbed.json';

describe('renderPostEmbed', () => {
	it('renders the affected quoted post and its nested paper link', () => {
		const html = renderPostEmbed(quotedEmbed);
		expect(html).toContain('href="https://bsky.app/profile/pubchat.org/post/3mw3t5sb4cw2j"');
		expect(html).toContain('Algorithmic Collusion and the Complexity of Information-Value-Free Equilibria');
		expect(html).toContain('href="https://pubchat.org/chat/arxiv/2609.22757"');
	});

	it('renders both media and the quoted post when they appear together', () => {
		const html = renderPostEmbed({
			$type: 'app.bsky.embed.recordWithMedia#view',
			record: quotedEmbed,
			media: {
				$type: 'app.bsky.embed.images#view',
				images: [{ fullsize: 'https://example.com/diagram.png', alt: 'Diagram' }],
			},
		});
		expect(html).toContain('src="https://example.com/diagram.png"');
		expect(html).toContain('href="https://pubchat.org/chat/arxiv/2609.22757"');
	});

	it.each(['viewNotFound', 'viewBlocked', 'viewDetached'])('shows unavailable quotes (%s)', type => {
		const html = renderPostEmbed({
			$type: 'app.bsky.embed.record#view',
			record: { $type: `app.bsky.embed.record#${type}` },
		});
		expect(html).toContain('Quoted post');
		expect(html).not.toContain('undefined');
	});

	it('escapes quoted text and preserves rich-text links', () => {
		const html = renderPostEmbed({
			...quotedEmbed,
			record: {
				...quotedEmbed.record,
				value: {
					text: 'Link <script>alert(1)</script>',
					facets: [{ index: { byteStart: 0, byteEnd: 4 }, features: [{
						$type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/paper',
					}] }],
				},
			},
		});
		expect(html).toContain('href="https://example.com/paper"');
		expect(html).toContain('&lt;script&gt;');
		expect(html).not.toContain('<script>');
	});
	it('uses the URI as the visible label when an external embed has blank metadata', () => {
		const html = renderPostEmbed({
			$type: 'app.bsky.embed.external#view',
			external: {
				uri: 'https://arxiv.org/pdf/2107.07083',
				title: '',
				description: '',
				thumb: '',
			},
		});

		expect(html).toContain('href="https://arxiv.org/pdf/2107.07083"');
		expect(html).toContain('<span class="external-embed-title">https://arxiv.org/pdf/2107.07083</span>');
		expect(html).toContain('class="external-embed-source"');
		expect(html).toContain('<span>arxiv.org</span>');
		expect(html).not.toContain('<p></p>');
	});
});
