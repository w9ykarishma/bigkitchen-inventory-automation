const API_VERSION = "2026-10";

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status, headers: { "content-type": "application/json; charset=utf-8" }
});

async function verifyHmac(rawBody, header, secret) {
  if (!header || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const expected = btoa(binary);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

async function getToken(env) {
  const res = await fetch(`https://${env.SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials"
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Token request failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function gql(env, token, query, variables = {}) {
  const res = await fetch(`https://${env.SHOPIFY_SHOP}.myshopify.com/admin/api/${env.SHOPIFY_API_VERSION || API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (!res.ok || data.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(data.errors || data)}`);
  return data.data;
}

const FIND_PRODUCT = `query($id: ID!) {
  inventoryItem(id: $id) {
    variant { product { id title status } }
  }
}`;

const GET_STOCK = `query($id: ID!) {
  product(id: $id) {
    id title status
    variants(first: 250) {
      edges {
        node {
          inventoryItem {
            inventoryLevels(first: 250, includeInactive: true) {
              edges {
                node {
                  quantities(names: ["available"]) { name quantity }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const CHANGE_STATUS = `mutation($productId: ID!, $status: ProductStatus!) {
  productChangeStatus(productId: $productId, status: $status) {
    product { id status }
    userErrors { field message }
  }
}`;

async function processWebhook(request, env) {
  const raw = await request.text();
  const valid = await verifyHmac(raw, request.headers.get("X-Shopify-Hmac-Sha256"), env.SHOPIFY_CLIENT_SECRET);
  if (!valid) return json({ ok: false, error: "Invalid Shopify webhook signature" }, 401);

  const topic = request.headers.get("X-Shopify-Topic") || "";
  if (topic !== "inventory_levels/update") return json({ ok: true, ignored: true, topic });

  const payload = JSON.parse(raw);
  if (!payload.inventory_item_id) return json({ ok: false, error: "Missing inventory_item_id" }, 400);

  const token = await getToken(env);
  const itemGid = `gid://shopify/InventoryItem/${payload.inventory_item_id}`;
  const linked = await gql(env, token, FIND_PRODUCT, { id: itemGid });
  const product = linked.inventoryItem?.variant?.product;
  if (!product) return json({ ok: true, ignored: true, reason: "No linked product" });

  const stockData = await gql(env, token, GET_STOCK, { id: product.id });
  const current = stockData.product;
  if (!current) throw new Error(`Product not found: ${product.id}`);

  let totalAvailable = 0;
  let levelRows = 0;
  for (const edge of current.variants.edges) {
    for (const level of (edge.node.inventoryItem?.inventoryLevels?.edges || [])) {
      const qty = (level.node.quantities || []).find(q => q.name === "available");
      totalAvailable += Number(qty?.quantity || 0);
      levelRows++;
    }
  }

  const suggested = totalAvailable > 0 ? "ACTIVE" : "DRAFT";
  const result = {
    ok: true,
    mode: env.DRY_RUN === "false" ? "LIVE" : "DRY_RUN",
    productId: current.id,
    productTitle: current.title,
    previousStatus: current.status,
    totalAvailable,
    inventoryLevelRows: levelRows,
    suggestedStatus: suggested,
    changed: false
  };

  if (levelRows === 0) return json({ ...result, ok: false, error: "No inventory levels; status not changed" }, 409);
  if (suggested === current.status) return json(result);
  if (env.DRY_RUN !== "false") return json({ ...result, message: "Preview only; no Shopify status update made" });

  const updated = await gql(env, token, CHANGE_STATUS, { productId: current.id, status: suggested });
  const outcome = updated.productChangeStatus;
  if (outcome.userErrors?.length) return json({ ...result, ok: false, errors: outcome.userErrors }, 502);
  return json({ ...result, changed: outcome.product?.status === suggested, confirmedStatus: outcome.product?.status });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ service: "BigKitchen inventory webhook", status: "online", mode: env.DRY_RUN === "false" ? "LIVE" : "DRY_RUN" });
    }
    if (request.method === "POST" && url.pathname === "/webhooks/inventory-levels-update") {
      try { return await processWebhook(request, env); }
      catch (e) { console.error(e); return json({ ok: false, error: e.message || "Internal error" }, 500); }
    }
    return json({ ok: false, error: "Not found" }, 404);
  }
};
