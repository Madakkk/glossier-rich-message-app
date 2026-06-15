import express, { Request, Response } from "express";
import he from "he";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 3000);
const GLOSSIER_PRODUCTS_URL = "https://www.glossier.com/products.json?limit=250";
const ADD_USER_URL = "https://api.livechatinc.com/v3.6/agent/action/add_user_to_chat";
const SEND_EVENT_URL = "https://api.livechatinc.com/v3.5/agent/action/send_event";
const DEFAULT_AGENT_ID = "m.kosnik+wecandoit@text.com";

type ShopifyVariant = {
  title?: string;
  available?: boolean;
  price?: string;
};

type ShopifyImage = {
  src?: string;
};

type ShopifyProduct = {
  id: number;
  title: string;
  handle: string;
  body_html?: string;
  product_type?: string;
  tags?: string[];
  variants?: ShopifyVariant[];
  images?: ShopifyImage[];
};

type MatchedProduct = {
  product: ShopifyProduct;
  score: number;
};

function getToken(): string | undefined {
  return process.env.TEXT_ACCESS_TOKEN || process.env.TEXT_API_TOKEN;
}

function authHeader(token: string): string {
  const trimmed = token.trim();
  if (trimmed.toLowerCase().startsWith("basic ")) return trimmed;
  if (trimmed.toLowerCase().startsWith("bearer ")) return trimmed;
  return `Basic ${trimmed}`;
}

function stripHtml(html?: string): string {
  if (!html) return "";
  return he.decode(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function expandQuery(query: string): string {
  const q = normalizeText(query);
  const synonymMap: Record<string, string[]> = {
    blush: ["blush", "cheek", "cloud paint", "flush", "color"],
    cheek: ["blush", "cheek", "cloud paint", "flush"],
    sunscreen: ["sunscreen", "spf", "invisible shield", "sun", "uv"],
    spf: ["sunscreen", "spf", "invisible shield", "sun", "uv"],
    perfume: ["perfume", "fragrance", "you", "scent", "spray"],
    fragrance: ["perfume", "fragrance", "you", "scent", "spray"],
    lip: ["lip", "balm", "gloss", "lipstick", "balm dotcom", "ultralip"],
    balm: ["lip", "balm", "balm dotcom", "moisturizing"],
    cleanser: ["cleanser", "face wash", "milky jelly", "cleanse"],
    acne: ["acne", "breakout", "clarifying", "solution", "exfoliating"],
    dry: ["dry", "moisturizer", "cream", "balm", "rich", "nourishment"],
    moisturizer: ["moisturizer", "cream", "priming moisturizer", "after baume", "dry"],
    hoodie: ["hoodie", "merch", "apparel", "sweatshirt"],
    bag: ["bag", "tote", "errand", "beauty bag", "duffle", "merch"],
    mascara: ["mascara", "lash", "lashes"],
    eyebrow: ["brow", "eyebrow", "boy brow"],
    brows: ["brow", "eyebrow", "boy brow"],
    foundation: ["foundation", "skin tint", "complexion", "concealer"],
    concealer: ["concealer", "stretch", "complexion"],
    dog: ["dog", "pet", "leash", "collar", "waste bag"]
  };

  const extra = new Set<string>();
  for (const [key, values] of Object.entries(synonymMap)) {
    if (q.includes(key)) values.forEach((value) => extra.add(value));
  }
  return `${q} ${Array.from(extra).join(" ")}`.trim();
}

function productSearchText(product: ShopifyProduct): string {
  return normalizeText([
    product.title,
    product.handle,
    product.product_type,
    stripHtml(product.body_html),
    ...(product.tags || []),
    ...(product.variants || []).map((variant) => variant.title || "")
  ].join(" "));
}

function findMatchingProducts(products: ShopifyProduct[], query: string): ShopifyProduct[] {
  const expandedQuery = expandQuery(query);
  const terms = normalizeText(expandedQuery).split(" ").filter((term) => term.length > 2);
  const phrase = normalizeText(query);

  const scored: MatchedProduct[] = products
    .filter((product) => product.images?.[0]?.src)
    .map((product) => {
      const searchText = productSearchText(product);
      let score = 0;

      if (phrase && searchText.includes(phrase)) score += 12;
      if (normalizeText(product.title).includes(phrase)) score += 20;

      for (const term of terms) {
        if (normalizeText(product.title).includes(term)) score += 8;
        if (normalizeText(product.product_type || "").includes(term)) score += 5;
        if ((product.tags || []).some((tag) => normalizeText(tag).includes(term))) score += 4;
        if (stripHtml(product.body_html).toLowerCase().includes(term)) score += 2;
        if (product.handle.includes(term)) score += 3;
      }

      if ((product.variants || []).some((variant) => variant.available)) score += 1;

      return { product, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 10).map((item) => item.product);
}

function formatPrice(product: ShopifyProduct): string {
  const availableVariant = product.variants?.find((variant) => variant.available) || product.variants?.[0];
  const rawPrice = availableVariant?.price;
  if (!rawPrice || rawPrice === "0.00") return "View product";
  return `$${rawPrice}`;
}

function productUrl(product: ShopifyProduct): string {
  return `https://www.glossier.com/products/${product.handle}`;
}

function buildRichMessageEvent(products: ShopifyProduct[]) {
  return {
    type: "rich_message",
    template_id: "cards",
    elements: products.map((product) => {
      const description = stripHtml(product.body_html).slice(0, 110);
      const price = formatPrice(product);
      const subtitle = description ? `${description}\n${price}` : price;

      return {
        title: product.title,
        subtitle,
        image: {
          url: product.images?.[0]?.src
        },
        buttons: [
          {
            type: "url",
            text: "View product",
            postback_id: `view_${product.handle}`,
            user_ids: [],
            value: productUrl(product)
          }
        ]
      };
    })
  };
}

async function fetchGlossierProducts(): Promise<ShopifyProduct[]> {
  const response = await fetch(GLOSSIER_PRODUCTS_URL);
  if (!response.ok) {
    throw new Error(`Glossier products request failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as { products?: ShopifyProduct[] };
  return data.products || [];
}

async function addAgentToChat(chatId: string, token: string): Promise<void> {
  const agentId = process.env.TEXT_TARGET_AGENT_ID || DEFAULT_AGENT_ID;
  const response = await fetch(ADD_USER_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      user_id: agentId,
      user_type: "agent",
      visibility: "all",
      ignore_requester_presence: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`add_user_to_chat failed: ${response.status} ${body}`);
  }
}

async function sendRichMessage(chatId: string, products: ShopifyProduct[], token: string): Promise<void> {
  const response = await fetch(SEND_EVENT_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      event: buildRichMessageEvent(products)
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`send_event failed: ${response.status} ${body}`);
  }
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, version: "5.0.0" });
});

app.get("/debug-env", (_req: Request, res: Response) => {
  const accessToken = process.env.TEXT_ACCESS_TOKEN;
  const apiToken = process.env.TEXT_API_TOKEN;
  res.json({
    ok: true,
    hasTextAccessToken: Boolean(accessToken),
    textAccessTokenLength: accessToken?.length || 0,
    hasTextApiToken: Boolean(apiToken),
    textApiTokenLength: apiToken?.length || 0,
    hasResolvedToken: Boolean(getToken()),
    targetAgentId: process.env.TEXT_TARGET_AGENT_ID || DEFAULT_AGENT_ID
  });
});

app.post("/webhook/glossier-products", async (req: Request, res: Response) => {
  try {
    const token = getToken();
    if (!token) {
      return res.status(500).json({
        ok: false,
        error: "Missing TEXT_ACCESS_TOKEN or TEXT_API_TOKEN environment variable"
      });
    }

    const chatId = req.body.chat_id;
    const query = req.body.query || req.body.customer_query || req.body.message || "";

    if (!chatId) {
      return res.status(400).json({ ok: false, error: "chat_id is required" });
    }

    if (!query) {
      return res.status(400).json({ ok: false, error: "query is required" });
    }

    const products = await fetchGlossierProducts();
    const matchedProducts = findMatchingProducts(products, query);

    if (!matchedProducts.length) {
      return res.status(404).json({
        ok: false,
        error: "No matching products found",
        query
      });
    }

    await addAgentToChat(chatId, token);
    await sendRichMessage(chatId, matchedProducts, token);

    res.json({
      ok: true,
      query,
      matched_count: matchedProducts.length,
      matched_products: matchedProducts.map((product) => ({
        title: product.title,
        handle: product.handle,
        price: formatPrice(product),
        url: productUrl(product)
      }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(message);
    res.status(500).json({ ok: false, error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Glossier rich message app v5 running on port ${PORT}`);
});
