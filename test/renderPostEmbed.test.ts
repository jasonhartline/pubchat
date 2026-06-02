import { describe, expect, it } from 'vitest';

import { renderPostEmbed } from '../src/index';

describe('renderPostEmbed', () => {
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
