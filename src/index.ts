
import { AtpAgent } from "@atproto/api";

export interface Env {
  ATP_HANDLE: string;
  ATP_APP_PASSWORD: string;
  ASSETS: Fetcher;
  ENVIRONMENT: string; // "dev" or undefined
}

const ANCHOR_COLLECTION = "org.pubchat.anchor";
const POST_COLLECTION = "app.bsky.feed.post";

const POST_TEMPLATE = "“{{title}}”\nby {{authors}}\n\nCC: PubChat";

function fillTemplate(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? "");
}

function isDev(env: Env): boolean {
  return env.ENVIRONMENT === "dev";
}

function extractRkeyFromUri(uri: string): string {
  return uri.split("/").pop()!;
}


type Source = "arxiv";

type Route =
  | { kind: "at"; source: Source; id: string }
  | { kind: "chat"; source: Source; id: string; format: "html" | "json" }
  | { kind: "reply" };


type SourceId = {
  source: Source;
  id: string;
};

type AnchorRecord = {
  $type: typeof ANCHOR_COLLECTION;
  source: Source;
  sourceId: string;
  discussion?: {
    uri: string;
    cid: string;
  };
};

const ARXIV_ID_PATH = String.raw`\d{4}\.\d{4,5}(?:v\d+)?`;
const ARXIV_ID_RE = new RegExp(`^(${ARXIV_ID_PATH})$`);


function parseArxivId(raw: string): SourceId | null {
  const m = raw.trim().match(ARXIV_ID_RE);
  if (!m) return null;

  return {
    source: "arxiv",
    id: m[1].replace(/v\d+$/, ""),
  };
}



type DiscussionPost = {
  uri: string;
  cid: string;
  text: string;
  facets: any[];
  embed: any;
  authorHandle: string;
  authorDisplayName: string;
  createdAt: string;
  blueskyUrl: string;
  depth: number;
  isRoot: boolean;
  avatar: string | undefined;
  hasReplies: boolean;
};


function blueskyUrlForPost(post: any): string {
  const rkey = extractRkeyFromUri(post.uri);
  const handle = post.author?.handle;
  if (!handle) return "";
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

async function fetchDiscussionThread(
  agent: AtpAgent,
  rootUri: string,
): Promise<DiscussionPost[]> {
  const res = await agent.app.bsky.feed.getPostThread({
    uri: rootUri,
    depth: 100,
    parentHeight: 0,
  });

  const out: DiscussionPost[] = [];

  function walk(node: any, depth: number) {
    if (!node || node.$type !== "app.bsky.feed.defs#threadViewPost") return;

    const post = node.post;
    const record = post.record as any;

    const replies = [...(node.replies ?? [])].sort((a: any, b: any) => {
      const at = a.post?.record?.createdAt ?? "";
      const bt = b.post?.record?.createdAt ?? "";
      return at.localeCompare(bt);
    });
    
    out.push({
      uri: post.uri,
      cid: post.cid,
      text: record.text ?? "",
      facets: record.facets ?? [],
      embed: post.embed ?? null,
      authorHandle: post.author?.handle ?? "",
      authorDisplayName: post.author?.displayName ?? "",
      createdAt: record.createdAt ?? "",
      blueskyUrl: blueskyUrlForPost(post),
      depth,
      isRoot: depth === 0,
      avatar: post.author?.avatar,
      hasReplies: replies.length > 0,
    });



    for (const reply of replies) {
      walk(reply, depth + 1);
    }

  }

  walk(res.data.thread, 0);
  return out;
}

function rkeyComponent(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function anchorRkey(x: SourceId): string {
  return `${rkeyComponent(x.source)}-${rkeyComponent(x.id)}`;
}


async function getAgent(env: Env): Promise<AtpAgent> {
  const agent = new AtpAgent({ service: "https://bsky.social" });

  await agent.login({
    identifier: env.ATP_HANDLE,
    password: env.ATP_APP_PASSWORD,
  });

  return agent;
}




function shortDescriptionWithAuthors(
  abstract: string | null | undefined,
  authors: string[] | undefined,
): string {
  const authorStr =
    authors && authors.length > 0 ? `by ${authors.join(", ")}\n\n` : "";

  const body = (abstract ?? "").replace(/\s+/g, " ").trim();

  const maxLen = 280;
  const full = authorStr + body;

  if (full.length <= maxLen) return full;

  const truncated = full.slice(0, maxLen - 1).trimEnd();

  return `${truncated}…`;  // standard ellipsis
}



async function getAnchorRecord(agent: AtpAgent, source: Source, id: string) {
  const did = agent.session?.did;

  if (!did) throw new Error("Could not determine PubChat DID after login");

  const rkey = anchorRkey({ source, id });
  const uri = `at://${did}/${ANCHOR_COLLECTION}/${rkey}`;

  try {
    const existing = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: ANCHOR_COLLECTION,
      rkey,
    });

    return {
      exists: true as const,
      source,
      sourceId: id,
      rkey,
      uri,
      cid: existing.data.cid,
      record: existing.data.value as AnchorRecord,
    };
  } catch {
    return {
      exists: false as const,
      source,
      sourceId: id,
      rkey,
      uri,
    };
  }
}

async function createBlueskyAnchorPost(
  agent: AtpAgent,
  source: Source,
  id: string,
  metadata: Awaited<ReturnType<typeof fetchMetadata>>,
) {


  const pubchatUrl = `https://pubchat.org/chat/${source}/${id}`;

  const title = metadata.title ?? "PubChat discussion";
  const description =
  shortDescriptionWithAuthors(metadata.abstract, metadata.authors) ||
  "Discuss this paper on PubChat.";

  const post = await agent.post({
    $type: POST_COLLECTION,
    text: fillTemplate(POST_TEMPLATE, {
      title,
      authors: (metadata.authors ?? []).join(", "),
    }),
    createdAt: new Date().toISOString(),
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: pubchatUrl,
        title,
        description,
      },
    },
  });

  const rkey = extractRkeyFromUri(post.uri);

  const handle = agent.session?.handle;
  if (!handle) throw new Error("No handle in session");

  
  return {
    uri: post.uri,
    cid: post.cid,
    rkey,
    blueskyUrl: `https://bsky.app/profile/${handle}/post/${rkey}`,
  };
}

async function createAnchorWithPost(
  agent: AtpAgent,
  source: Source,
  id: string,
  rkey: string,
  uri: string,
  anchorPost: { uri: string; cid: string },
) {
  const did = agent.session?.did;

  if (!did) throw new Error("Could not determine PubChat DID after login");

  const record: AnchorRecord = {
    $type: ANCHOR_COLLECTION,
    source,
    sourceId: id,
    discussion: {
      uri: anchorPost.uri,
      cid: anchorPost.cid,
    },
  };

  const created = await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: ANCHOR_COLLECTION,
    rkey,
    record,
  });

  return {
    source,
    sourceId: id,
    rkey,
    uri,
    cid: created.data.cid,
    record,
  };
}

function anchorPostFromAnchor(
  agent: AtpAgent,
  anchor: { record: AnchorRecord },
) {
  if (!anchor.record.discussion) {
    throw new Error("Anchor exists but has no discussion pointer");
  }

  const { uri, cid } = anchor.record.discussion;
  const rkey = extractRkeyFromUri(uri);

  const handle = agent.session?.handle;
  if (!handle) throw new Error("No handle in session");
  
  return {
    uri,
    cid,
    rkey,
    blueskyUrl: `https://bsky.app/profile/${handle}/post/${rkey}`,
  };
}


function parseRoute(request: Request): Route | null {
  const url = new URL(request.url);
  const path = url.pathname;


  let m = path.match(new RegExp(`^/at/arxiv/(${ARXIV_ID_PATH})$`));
  if (request.method === "GET" && m) {
    const sid = parseArxivId(m[1]);
    if (!sid) return null;
    return { kind: "at", source: sid.source, id: sid.id };
  }
  
  m = path.match(new RegExp(`^/chat/arxiv/(${ARXIV_ID_PATH})(\\.json)?$`));
  if (request.method === "GET" && m) {
    const sid = parseArxivId(m[1]);
    if (!sid) return null;
    return {
      kind: "chat",
      source: sid.source,
      id: sid.id,
      format: m[2] ? "json" : "html",
    };
  }
  

  if (request.method === "POST" && path === "/reply") {
    return { kind: "reply" };
  }

  return null;
}


type RequestContext = {
  url: URL;
  simulate?: "rateLimited" | "notFound";
  debug?: boolean;
};

function canonicalRedirect(request: Request): Response | null {
  if (request.method !== "GET") return null;

  const url = new URL(request.url);

  const m = url.pathname.match(
    new RegExp(`^/(chat|at)/arxiv/(${ARXIV_ID_PATH})(\\.json)?$`)
  );

  if (!m) return null;

  const [, kind, rawId, jsonSuffix] = m;
  const canonicalId = rawId.replace(/v\d+$/, "");

  if (canonicalId === rawId) return null;

  url.pathname = `/${kind}/arxiv/${canonicalId}${jsonSuffix ?? ""}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
    },
  });
}

export default {

  async fetch(request: Request, env: Env): Promise<Response> {

    const redirect = canonicalRedirect(request);
    if (redirect) return redirect;
    
    const agent = await getAgent(env);
    
    const url = new URL(request.url);

    const ctx: RequestContext = {
      url,
      simulate:
      isDev(env) && url.searchParams.get("simulate") === "rateLimited"
	? "rateLimited"
	: isDev(env) && url.searchParams.get("simulate") === "notFound"
        ? "notFound"
        : undefined,
      debug: url.searchParams.has("debug"),
    };
    
    // serve static assets first
    if (request.method === "GET" && url.pathname.startsWith("/static/")) {
      return env.ASSETS.fetch(request);
    }
    
    if (isDev(env)) {
      // debug: list anchors
      if (request.method === "GET" && url.pathname === "/debug/anchors") {
	return renderDebugList(agent, ANCHOR_COLLECTION, "anchors");
      }
      
      // debug: list posts
      if (request.method === "GET" && url.pathname === "/debug/posts") {
	return renderDebugList(agent, POST_COLLECTION, "posts");
      }
      
      // debug: delete anchor
      let m = url.pathname.match(/^\/debug\/anchors\/delete\/([^/]+)$/);
      if (request.method === "GET" && m) {
	return debugDelete(agent, ANCHOR_COLLECTION, m[1], "/debug/anchors");
      }
      
      // debug: delete post
      m = url.pathname.match(/^\/debug\/posts\/delete\/([^/]+)$/);
      if (request.method === "GET" && m) {
	return debugDelete(agent, POST_COLLECTION, m[1], "/debug/posts");
      }
    }
	
    const route = parseRoute(request);
    
    if (!route) return new Response("Not found", { status: 404 });

    
    switch (route.kind) {
    case "at":
      return handleAt(agent,route);
      
    case "chat":
      return handleChat(ctx,agent,route);
      
    case "reply":
      return json({ error: "Not implemented yet" }, 501);
    }
  },
};



async function blueskyPostExists(
  agent: AtpAgent,
  uri: string,
): Promise<boolean> {
  try {
    const parts = uri.split("/");
    const rkey = parts.pop()!;
    const collection = parts.pop()!;
    const repo = uri.split("/")[2];

    await agent.com.atproto.repo.getRecord({
      repo,
      collection,
      rkey,
    });

    return true;
  } catch {
    return false;
  }
}



async function handleAt(
    agent: AtpAgent,
  route: Extract<Route, { kind: "at" }>,
): Promise<Response> {


  const anchor = await getAnchorRecord(agent, route.source, route.id);

  if (!anchor.exists) {
    return json({ error: "Anchor not found" }, 404);
  }

  return json(anchor);
}


async function handleChat(
  ctx: RequestContext,
  agent: AtpAgent,
  route: Extract<Route, { kind: "chat" }>,
): Promise<Response> {
  // 1. First check arXiv.
  const metadata = await fetchMetadata(route.source, route.id);

  if (ctx.simulate === "rateLimited") {
    (metadata as any).rateLimited = true;
  }

  if (ctx.simulate === "notFound") {
    (metadata as any).notFound = true;
  }

  
  // 2. Then check anchor/post.
  const existingAnchor = await getAnchorRecord(agent, route.source, route.id);

  let anchor;
  let anchorPost;

  const hasUsableAnchorPost =
    existingAnchor.exists &&
    existingAnchor.record.discussion &&
    await blueskyPostExists(agent, existingAnchor.record.discussion.uri);

  // 3. arXiv rate limited, but existing PubChat page exists.
  if ((metadata as any).rateLimited && hasUsableAnchorPost) {
    anchor = existingAnchor;
    anchorPost = anchorPostFromAnchor(agent, anchor);

    const fallbackMetadata = await metadataFromBlueskyPost(
      agent,
      anchorPost.uri,
      route.source,
      route.id,
    );

    const thread = await fetchDiscussionThread(agent, anchorPost.uri);

    const data = {
      source: route.source,
      sourceId: route.id,
      anchor: {
        uri: anchor.uri,
        cid: anchor.cid,
      },
      anchorPost,
      metadata: fallbackMetadata,
      thread,
      warning:
        "arXiv is rate limiting requests. Paper metadata is being shown from the existing PubChat anchor post and may be truncated.",
    };



    
    if (route.format === "json") return json(data);
    return html(renderChatPage(data));
  }

  // 4. arXiv failed and no usable anchor post exists.
  if ((metadata as any).rateLimited) {
    return html(renderUnavailablePage({
      title: "arXiv is rate limiting requests",
      message: "PubChat could not create or display this page because arXiv temporarily rejected the metadata request.",
      arxivId: route.id,
    }), 429);
  }

  if ((metadata as any).notFound) {
    return html(renderUnavailablePage({
      title: "arXiv paper not found",
      message: "PubChat could not find this arXiv paper.",
      arxivId: route.id,
    }), 404);
  }

  // 5. Normal path.
  if (hasUsableAnchorPost) {
    anchor = existingAnchor;
    anchorPost = anchorPostFromAnchor(agent, anchor);
  } else {
    anchorPost = await createBlueskyAnchorPost(
      agent,
      route.source,
      route.id,
      metadata,
    );

    anchor = await createAnchorWithPost(
      agent,
      route.source,
      route.id,
      existingAnchor.rkey,
      existingAnchor.uri,
      anchorPost,
    );
  }

  const thread = await fetchDiscussionThread(agent, anchorPost.uri);

  const data = {
    source: route.source,
    sourceId: route.id,
    anchor: {
      uri: anchor.uri,
      cid: anchor.cid,
    },
    anchorPost,
    metadata,
    thread,
  };

  if (ctx.debug) {
    (data as any)._debug = {
      cached: metadata.cached,
      rateLimited: metadata.rateLimited,
      notFound: metadata.notFound,
      anchorExists: existingAnchor.exists,
      hasDiscussion: !!existingAnchor.record?.discussion,
    };
  }

  
  if (route.format === "json") return json(data);
  return html(renderChatPage(data));
}



async function fetchMetadata(source: Source, id: string) {
  switch (source) {
    case "arxiv":
      return fetchCachedArxiv(id);
  }
  throw new Error(`Unsupported source: ${source}`);
}


function getAllAuthors(entry: string): string[] {
  return [...entry.matchAll(/<author[^>]*>([\s\S]*?)<\/author>/g)]
    .map(m => {
      const block = m[1];
      const name = block.match(/<name[^>]*>([\s\S]*?)<\/name>/);
      return name
        ? decodeXml(name[1].trim().replace(/\s+/g, " "))
        : null;
    })
    .filter((x): x is string => x !== null);
}

async function metadataFromBlueskyPost(
  agent: AtpAgent,
  uri: string,
  source: Source,
  id: string,
) {
  const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) throw new Error("Bad Bluesky post URI");

  const [, repo, collection, rkey] = m;

  const res = await agent.com.atproto.repo.getRecord({
    repo,
    collection,
    rkey,
  });

  const record = res.data.value as any;
  const external = record.embed?.external;

  return {
    title: external?.title ?? "PubChat discussion",
    abstract: external?.description ?? null,
    link: `https://arxiv.org/abs/${id}`,
    authors: [],
    rateLimited: true,
  };
}

async function fetchArxiv(id: string) {
  const res = await fetch(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
    {
      headers: {
        "user-agent": "PubChat/0.1",
        accept: "application/atom+xml, application/xml, text/xml",
      },
    },
  );

  if (res.status === 429) {
    return {
      title: null,
      abstract: null,
      link: `https://arxiv.org/abs/${id}`,
      authors: [],
      rateLimited: true,
    };
  }

  if (!res.ok) {
    return {
      title: null,
      abstract: null,
      link: `https://arxiv.org/abs/${id}`,
      authors: [],
      notFound: true,
    };
  }


  const text = await res.text();

  const entryMatch = text.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) {
    return {
    title: null,
      abstract: null,
      link: `https://arxiv.org/abs/${id}`,
      authors: [],
      notFound: true,
    };
  }


  const entry = entryMatch[1];

  const get = (tag: string) => {
    const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? decodeXml(m[1].trim().replace(/\s+/g, " ")) : null;
  };

  const getSummary = () => {
  const m = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
  return m
    ? decodeXml(m[1].trim().replace(/[ \t]+/g, " "))
    : null;
  };
  
  return {
    title: get("title"),
    abstract: getSummary(),
    link: get("id"),
    authors: getAllAuthors(entry),
  };
}


async function fetchCachedArxiv(id: string) {
  const cache = caches.default;
  const cacheKey = new Request(`https://pubchat.org/cache/arxiv/${id}`);

  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    return { ...data, cached: true };
  }

  const metadata = await fetchArxiv(id);

  // Do not cache rate limits or transient failures.
  if (!(metadata as any).rateLimited && !(metadata as any).notFound) {
    const response = new Response(JSON.stringify(metadata), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });

    await cache.put(cacheKey, response);
  }

  return { ...metadata, cached: false };
}



function renderUnavailablePage(args: {
  title: string;
  message: string;
  arxivId: string;
}): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(args.title)} — PubChat</title>
  <link rel="icon" href="/static/favicon.png" sizes="32x32" type="image/png">
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f3f7fb;
      color: #0f1419;
    }

    main {
      max-width: 680px;
      margin: 40px auto;
      padding: 20px;
      background: white;
      border: 1px solid #dbe3ec;
      border-radius: 12px;
    }

    a {
      color: #0a7cff;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(args.title)}</h1>
    <p>${escapeHtml(args.message)}</p>
    <p>
      arXiv:
      <a href="https://arxiv.org/abs/${escapeAttr(args.arxivId)}" target="_blank" rel="noopener">
        ${escapeHtml(args.arxivId)}
      </a>
    </p>
  </main>
</body>
</html>`;
}

function renderPostText(text: string, facets: any[]): string {
  if (!facets || facets.length === 0) {
    return escapeHtml(text);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const bytes = encoder.encode(text);
  const sorted = [...facets].sort(
    (a, b) => a.index.byteStart - b.index.byteStart,
  );

  let out = "";
  let pos = 0;

  for (const facet of sorted) {
    const start = facet.index.byteStart;
    const end = facet.index.byteEnd;

    out += escapeHtml(decoder.decode(bytes.slice(pos, start)));

    const raw = decoder.decode(bytes.slice(start, end));
    const feature = facet.features?.[0];

    if (feature?.$type === "app.bsky.richtext.facet#link") {
      out += `<a href="${escapeAttr(feature.uri)}" target="_blank" rel="noopener">${escapeHtml(raw)}</a>`;
    } else if (feature?.$type === "app.bsky.richtext.facet#mention") {
      out += `<a href="https://bsky.app/profile/${escapeAttr(feature.did)}" target="_blank" rel="noopener">${escapeHtml(raw)}</a>`;
    } else if (feature?.$type === "app.bsky.richtext.facet#tag") {
      out += `<a href="https://bsky.app/hashtag/${escapeAttr(feature.tag)}" target="_blank" rel="noopener">${escapeHtml(raw)}</a>`;
    } else {
      out += escapeHtml(raw);
    }

    pos = end;
  }

  out += escapeHtml(decoder.decode(bytes.slice(pos)));
  return out;
}

function renderPostDate(createdAt: string): string {
  if (!createdAt) return "";

  return new Date(createdAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function renderArxivAbstract(abstract: string | null | undefined): string {
  return escapeHtml(abstract ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, "\n<br>");
}

function renderPostEmbed(embed: any): string {
  if (!embed) return "";

  if (embed.$type === "app.bsky.embed.external#view") {
    const e = embed.external;
    return `
  <div class="embed">
        ${
          e.thumb
            ? `<img src="${escapeAttr(e.thumb)}" style="max-width: 240px;">`
            : ""
        }
        <p><a href="${escapeAttr(e.uri)}" target="_blank" rel="noopener">${escapeHtml(e.title ?? e.uri)}</a></p>
        ${e.description ? `<p>${escapeHtml(e.description)}</p>` : ""}
    </div>
    `;
  }

  if (embed.$type === "app.bsky.embed.images#view") {
    return `
      <div style="margin-top: 8px;">
        ${embed.images.map((img: any) => `
          <img src="${escapeAttr(img.fullsize ?? img.thumb)}"
               alt="${escapeAttr(img.alt ?? "")}"
               style="max-width: 240px; margin-right: 8px; margin-bottom: 8px;">
        `).join("")}
      </div>
    `;
  }

  if (embed.$type === "app.bsky.embed.recordWithMedia#view") {
    return renderPostEmbed(embed.media);
  }

  return "";
}

function marginX(level: number): number {
  return (2 / 3) * (1 - Math.pow(1.5, -level));
}


function threadAvatarLeft(level: number): number {
  const marginWidth = 72;
  return marginX(level) * marginWidth;
}

function threadLineWidth(level: number): number {
  const marginWidth = 72;
  return (marginX(level + 1) - marginX(level)) * marginWidth;
}

function blueskyReplyLink(url: string, text = "Reply on Bluesky"): string {
  return `
    <a class="reply-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">
      <svg
        class="bluesky-icon"
        viewBox="0 0 600 530"
        aria-hidden="true"
      >
        <path
          fill="currentColor"
          d="m123.121 34.664c66.479 49.918 137.996 151.11 176.879 231.527 38.883-80.417 110.4-181.609 176.879-231.527 47.96-36.017 125.621-63.868 125.621 24.771 0 17.694-10.152 148.639-16.111 169.899-20.711 73.891-96.192 92.736-163.337 81.306 117.366 19.981 147.228 86.153 82.746 152.325-122.428 125.652-175.922-31.533-189.632-71.804-2.513-7.381-3.689-10.834-4.166-7.896-.477-2.938-1.653.515-4.166 7.896-13.71 40.271-67.204 197.456-189.632 71.804-64.482-66.172-34.62-132.344 82.746-152.325-67.145 11.43-142.626-7.415-163.337-81.306-5.959-21.26-16.111-152.205-16.111-169.899 0-88.639 77.661-60.788 125.621-24.771z"
        />
      </svg>

      <span>${escapeHtml(text)}</span>
    </a>
  `;
}


function renderChatPage(data: {
  source: Source;
  sourceId: string;
  anchor: { uri: string; cid: string;};
  anchorPost: { uri: string; cid: string; blueskyUrl: string };
  metadata: Awaited<ReturnType<typeof fetchMetadata>>;
  thread: DiscussionPost[];
  warning?: string;
  debug?: any;
}): string {
  const title = data.metadata.title ?? `${data.source}:${data.sourceId}`;
  const authors = data.metadata.authors ?? [];


  const url = `https://pubchat.org/chat/${data.source}/${data.sourceId}`;

  
  const description = (data.metadata.abstract ?? "")
  .replace(/\s+/g, " ")
  .slice(0, 200);

  const image = "https://pubchat.org/static/pubchat-card.png";

  
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">


  <title>${escapeHtml(title)} — PubChat</title>

  <!-- favicon -->
  <link rel="icon" href="/static/favicon.png" sizes="32x32" type="image/png">

  <!-- Open Graph -->
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeAttr(title)}">
  <meta property="og:description" content="${escapeAttr(description)}">
  <meta property="og:url" content="${escapeAttr(url)}">
  <meta property="og:image" content="${escapeAttr(image)}">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttr(title)}">
  <meta name="twitter:description" content="${escapeAttr(description)}">
  <meta name="twitter:image" content="${escapeAttr(image)}">


<style>
  * {
    box-sizing: border-box;
  }

  html {
    -webkit-text-size-adjust: 100%;
  }

  body {
    margin: 0;
    overflow-x: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f3f7fb;
    color: #0f1419;
  }


main {
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
  background: white;
  min-height: 100vh;
  border-left: 1px solid #dbe3ec;
  border-right: 1px solid #dbe3ec;

  display: flex;
  flex-direction: column;
}

.discussion {
  flex: 1;
}

.warning {
  padding: 10px 12px;
  border: 1px solid #f0c36d;
  border-radius: 8px;
  background: #fff8e5;
  color: #5f4b00;
}

  .paper {
    padding: 20px;
    border-bottom: 1px solid #dbe3ec;
  }

  .paper h1 {
    margin: 0 0 8px 0;
    font-size: 28px;
    line-height: 1.2;
  }

  .paper p {
    margin: 8px 0;
    line-height: 1.45;
  }

.abstract {
  margin: 8px 0;
  line-height: 1.45;
}

.descriptor {
  font-weight: 700;
  margin-right: 4px;
}

  .reply-box {
    padding: 14px 20px;

  }

  .reply-box a {
    color: #0a7cff;
    text-decoration: none;
    font-size: 14px;
  }

  .reply-box a:hover {
    text-decoration: underline;
  }

  .section-header {
    padding: 16px 20px;
    margin: 0;
    border-bottom: 1px solid #dbe3ec;
    font-size: 20px;
    font-weight: 600;
  }

  .post {
    border-bottom: 1px solid #dbe3ec;
  }

  .post-row {
    display: flex;
    gap: 12px;
    position: relative;
    align-items: stretch;
  }

  .thread-margin {
    position: relative;
    width: 72px;
    flex-shrink: 0;
  }

  .avatar-wrap {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    z-index: 1;
  }

  .avatar,
  .avatar-placeholder {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: white;
  }

  .avatar {
    object-fit: cover;
    display: block;
  }

  .branch-svg {
    position: absolute;
    top: 8px;
    height: calc(100% - 16px);
    overflow: visible;
    pointer-events: none;
    z-index: 0;
  }

  .post-body {
    flex: 1;
    min-width: 0;
    padding: 12px 0;
  }

  .post-meta {
    color: #536471;
    font-size: 14px;
    line-height: 1.35;
  }

  .post-author {
    font-weight: 700;
    color: #0f1419;
  }

  .post-meta a {
    color: #536471;
    text-decoration: none;
  }

  .post-meta a:hover {
    text-decoration: underline;
  }

  .post-text {
    white-space: pre-wrap;
    font-size: 15px;
    line-height: 1.45;
    margin: 6px 0 8px 0;
    overflow-wrap: anywhere;
  }

  .post-actions a {
    color: #0a7cff;
    text-decoration: none;
    font-size: 14px;
  }

  .post-actions a:hover {
    text-decoration: underline;
  }

  .embed {
    border: 1px solid #cfd9e3;
    border-radius: 12px;
    padding: 10px;
    margin-top: 8px;
    max-width: 100%;
    overflow: hidden;
  }

  .embed img,
  .post img,
  svg {
    max-width: 100%;
  }

  .embed img {
    border-radius: 8px;
  }

.debug {
  margin: 12px 0;
  padding: 10px;
  background: #fff8e5;
  color: #5f4b00;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  font-size: 12px;
  overflow-x: auto;
}

.reply-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #0a7cff;
  text-decoration: none;
}

.reply-link:hover {
  text-decoration: underline;
}

.bluesky-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.site-header {
  border-bottom: 1px solid #dbe3ec;
  padding: 10px 20px;
}

.site-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #0f1419;
  text-decoration: none;
  font-size: 14px;
  font-weight: 600;
}

.site-brand img {
  width: 16px;
  height: 16px;
  display: block;
}

.site-footer {
  border-top: 1px solid #dbe3ec;
  padding: 14px 20px;
  font-size: 13px;
  color: #536471;
}

  @media (max-width: 700px) {
    main {
      max-width: none;
      min-height: 100vh;
      border-left: 0;
      border-right: 0;
    }

    .paper {
      padding: 16px;
    }

    .paper h1 {
      font-size: 23px;
      line-height: 1.2;
    }



    .reply-box,
    .section-header {
      padding-left: 14px;
      padding-right: 14px;
    }

    .post-row {
      gap: 10px;
    }

    .thread-margin {
      width: 72px;
    }

    .post-meta {
      font-size: 13px;
    }

    .post-text {
      font-size: 15px;
      line-height: 1.4;
    }
  }
</style>

<script>
  window.MathJax = {
    options: {
      processHtmlClass: "mathjax",
      ignoreHtmlClass: "post-text|post-meta|post-actions"
    },
    tex: {
      inlineMath: [['$', '$']]
    }
  };
</script>

<script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>

</head>
<body>
<main>
<header class="site-header">
  <a href="/" class="site-brand">
    <img src="/static/favicon.png" alt="">
    <span>PubChat</span>
  </a>
</header>
  <section class="paper">
    <h1>${escapeHtml(title)}</h1>

    ${
      authors.length > 0
        ? `<p>${authors.map(escapeHtml).join(", ")}</p>`
        : ""
    }



<blockquote class="abstract mathjax">
  <span class="descriptor">Abstract:</span>
  ${renderArxivAbstract(data.metadata.abstract)}
</blockquote>

${
  data.warning
    ? `<p class="warning">${escapeHtml(data.warning)}</p>`
    : ""
}

${
  data._debug
    ? `<pre class="debug">${escapeHtml(JSON.stringify(data._debug, null, 2))}</pre>`
    : ""
}

    ${
      data.metadata.link
        ? `<p><a href="${escapeAttr(data.metadata.link)}"><tt>${escapeHtml(data.metadata.link)}</tt></a></p>`
        : ""
    }

      ${blueskyReplyLink(data.anchorPost.blueskyUrl,"Start a new discussion on Bluesky")}



</section>


<section class=discussion>

<h2 style="padding: 16px 20px; margin: 0; border-bottom: 1px solid #dbe3ec;">
  Bluesky Discussion
</h2>


${
  data.thread.filter(post => !post.isRoot).length === 0
    ? '<div class="reply-box">' + blueskyReplyLink(data.anchorPost.blueskyUrl,"Start the discussion on Bluesky") + '</div>'
    : data.thread.filter(post => !post.isRoot).map(post => `
  <article class="post">
  <div class="post-row">
    <div class="thread-margin">
      <div
        class="avatar-wrap"
        style="left: ${threadAvatarLeft(post.depth)}px;"
      >
        ${
          post.avatar
            ? `<img class="avatar" src="${escapeAttr(post.avatar)}">`
            : `<div class="avatar-placeholder"></div>`
        }
      </div>

  ${
  post.hasReplies
    ? `<svg
         class="branch-svg"
         style="
           left: ${threadAvatarLeft(post.depth)}px;
           width: ${threadLineWidth(post.depth)}px;
         "
         viewBox="0 0 100 100"
         preserveAspectRatio="none"
       >
         <line
           x1="0" y1="0"
           x2="100" y2="100"
           stroke="#d1d9e0"
           stroke-width="1"
           vector-effect="non-scaling-stroke"
         />
       </svg>`
    : ""
  }
  
    </div>

    <div class="post-body">
      <div class="post-meta">
        <span class="post-author">
          ${escapeHtml(post.authorDisplayName || post.authorHandle)}
        </span>
        ${
          post.authorHandle
            ? `<a href="https://bsky.app/profile/${escapeAttr(post.authorHandle)}"
                  target="_blank"
                  rel="noopener">
                 @${escapeHtml(post.authorHandle)}
               </a>`
            : ""
        }
        ${
          post.createdAt
            ? `<span> · ${escapeHtml(renderPostDate(post.createdAt))}</span>`
            : ""
        }
      </div>

      <div class="post-text">${renderPostText(post.text, post.facets)}</div>

      ${renderPostEmbed(post.embed)}

      ${blueskyReplyLink(post.blueskyUrl)}
    </div>

  </div>
    </article>
          `).join("")
}
</section>
<footer class="site-footer">
  PubChat attaches Bluesky discussions to academic papers. Reply on Bluesky to join the discussion.
</footer>
  </main>
</body>
</html>`;
}


async function renderDebugList(
  agent: AtpAgent,
  collection: string,
  label: string,
): Promise<Response> {
  const did = agent.session!.did;

  const res = await agent.com.atproto.repo.listRecords({
    repo: did,
    collection,
    limit: 100,
  });

  const rows = res.data.records.map(r => {
    const rkey = extractRkeyFromUri(r.uri);
    const value = r.value as any;
    const json = JSON.stringify(
      { uri: r.uri, cid: r.cid, value: r.value },
      null,
      2,
    );

    const source = value.source ?? "";
    const sourceId = value.sourceId ?? "";
    const linked =
      value.discussion?.uri ??
      value.anchorPost?.uri ??
      value.embed?.external?.uri ??
      "";

    return `
      <tr>
        <td><code>${escapeHtml(rkey)}</code></td>
        <td>${escapeHtml(String(source))}</td>
        <td>${escapeHtml(String(sourceId))}</td>
        <td><code>${escapeHtml(String(linked))}</code></td>
        <td>
          <button type="button" data-json="${escapeAttr(json)}" onclick="showJson(this)">
            view
          </button>
        </td>
        <td>
          <a href="/debug/${label}/delete/${encodeURIComponent(rkey)}">
            delete
          </a>
        </td>
      </tr>
    `;
  }).join("");

  return html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Debug ${escapeHtml(label)}</title>
</head>
<body>
  <h1>${escapeHtml(label)}</h1>

  <table border="1" cellpadding="6" cellspacing="0">
    <tr>
      <th>rkey</th>
      <th>source</th>
      <th>sourceId</th>
      <th>linked</th>
      <th>record</th>
      <th>action</th>
    </tr>
    ${rows}
  </table>

  <dialog id="recordDialog" style="max-width: 900px; width: 90%;">
    <form method="dialog" style="text-align: right;">
      <button>close</button>
    </form>
    <pre id="recordJson" style="white-space: pre-wrap; overflow:auto;"></pre>
  </dialog>

  <script>
    function showJson(button) {
      document.getElementById("recordJson").textContent =
        button.getAttribute("data-json") || "";
      document.getElementById("recordDialog").showModal();
    }
  </script>
</body>
</html>`);
}


async function debugDelete(
  agent: AtpAgent,
  collection: string,
  rkey: string,
  redirectTo: string
): Promise<Response> {
  const did = agent.session!.did;

  await agent.com.atproto.repo.deleteRecord({
    repo: did,
    collection,
    rkey,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function decodeXml(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
