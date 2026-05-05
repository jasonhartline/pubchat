export interface Env {}

type Source = "arxiv";

type Route =
  | { kind: "at"; source: Source; id: string }
  | { kind: "chat"; source: Source; id: string; format: "html" | "json" }
  | { kind: "reply" };

const ARXIV_ID = String.raw`\d+\.\d+`;

function parseRoute(request: Request): Route | null {
  const url = new URL(request.url);
  const path = url.pathname;

  let m = path.match(new RegExp(`^/at/arxiv/(${ARXIV_ID})$`));
  if (request.method === "GET" && m) {
    return { kind: "at", source: "arxiv", id: m[1] };
  }

  m = path.match(new RegExp(`^/chat/arxiv/(${ARXIV_ID})(\\.json)?$`));
  if (request.method === "GET" && m) {
    return {
      kind: "chat",
      source: "arxiv",
      id: m[1],
      format: m[2] ? "json" : "html",
    };
  }

  if (request.method === "POST" && path === "/reply") {
    return { kind: "reply" };
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = parseRoute(request);

    if (!route) return new Response("Not found", { status: 404 });

    switch (route.kind) {
      case "at":
        return handleAt(route);

      case "chat":
        return handleChat(route);

      case "reply":
        return json({ error: "Not implemented yet" }, 501);
    }
  },
};

async function handleAt(route: Extract<Route, { kind: "at" }>): Promise<Response> {
  const discussion = discussionAnchor(route.source, route.id);
  return json(discussion);
}

async function handleChat(route: Extract<Route, { kind: "chat" }>): Promise<Response> {
  const discussion = discussionAnchor(route.source, route.id);
  const metadata = await fetchMetadata(route.source, route.id);
  const thread: unknown[] = [];

  const data = {
    source: route.source,
    sourceId: route.id,
    discussion,
    metadata,
    thread,
  };

  if (route.format === "json") return json(data);

  return html(renderChatPage(data));
}

function discussionAnchor(source: Source, id: string) {
  const rkey = `${source}-${id.replaceAll(".", "-")}`;

  return {
    source,
    sourceId: id,
    rkey,
    uri: `TODO at://did:plc:<pubchat-did>/org.pubchat.discussion/${rkey}`,
  };
}

async function fetchMetadata(source: Source, id: string) {
  switch (source) {
    case "arxiv":
      return fetchArxiv(id);
  }
}


function getAllAuthors(entry: string): string[] {
  const authors: string[] = [];
  const re = /<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g;

  let m;
  while ((m = re.exec(entry)) !== null) {
    authors.push(decodeXml(m[1].trim()));
  }
  return authors;
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

  if (!res.ok) throw new Error(`arXiv returned ${res.status}`);

  const text = await res.text();

  const entryMatch = text.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) {
    return { title: null, abstract: null, link: null };
  }

  const entry = entryMatch[1];

  const get = (tag: string) => {
    const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? decodeXml(m[1].trim().replace(/\s+/g, " ")) : null;
  };

  return {
    title: get("title"),
    abstract: get("summary"),
    link: get("id"),
    authors: getAllAuthors(entry),
  };
}



function renderChatPage(data: {
  source: Source;
  sourceId: string;
  discussion: ReturnType<typeof discussionAnchor>;
  metadata: Awaited<ReturnType<typeof fetchMetadata>>;
  thread: unknown[];
}): string {
  const title = data.metadata.title ?? `${data.source}:${data.sourceId}`;
  const authors = data.metadata.authors ?? [];

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} — PubChat</title>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>

    ${
      authors.length > 0
        ? `<p>${authors.map(escapeHtml).join(", ")}</p>`
        : ""
    }

    ${
      data.metadata.link
        ? `<p><a href="${escapeAttr(data.metadata.link)}">${escapeHtml(data.metadata.link)}</a></p>`
        : ""
    }

    <hr>

    <p>${escapeHtml(data.metadata.abstract ?? "")}</p>

    <hr>

    <h2>Discussion</h2>
    <p><code>${escapeHtml(data.discussion.uri)}</code></p>
    <p>No comments yet.</p>
  </main>
</body>
</html>`;
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
