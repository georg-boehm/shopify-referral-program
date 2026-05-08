/**
 * Update all VIP-prefixed discount codes from 10% to 20%.
 *
 * Usage:
 *   npx tsx scripts/update-discount-percentage.ts --shop your-shop.myshopify.com --token <token>
 */

import { parseArgs } from "util";

const API_VERSION = "2025-10";

const { values: args } = parseArgs({
  options: {
    shop: { type: "string" },
    token: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!args.shop || !args.token) {
  console.error("Usage: npx tsx scripts/update-discount-percentage.ts --shop <shop> --token <token>");
  process.exit(1);
}

const SHOP = args.shop;
const TOKEN = args.token;
const DRY_RUN = args["dry-run"] ?? false;
const GRAPHQL_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

async function shopifyGraphql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`\nUpdating VIP discounts to 20%`);
  console.log(`Shop: ${SHOP}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  // Find all discount codes with the VIP prefix
  let cursor: string | null = null;
  let updated = 0;
  let total = 0;

  while (true) {
    const result = await shopifyGraphql(
      `query findDiscounts($query: String!, $after: String) {
        codeDiscountNodes(first: 50, query: $query, after: $after) {
          edges {
            cursor
            node {
              id
              codeDiscount {
                ... on DiscountCodeBasic {
                  title
                  codes(first: 1) { edges { node { code } } }
                  customerGets {
                    value {
                      ... on DiscountPercentage { percentage }
                    }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }`,
      { query: "VIP-", after: cursor },
    );

    const edges = result.data?.codeDiscountNodes?.edges ?? [];
    if (edges.length === 0) break;

    for (const edge of edges) {
      cursor = edge.cursor;
      const node = edge.node;
      const code = node.codeDiscount?.codes?.edges?.[0]?.node?.code ?? "?";
      const currentPct = node.codeDiscount?.customerGets?.value?.percentage;

      total++;

      if (currentPct === 0.2) {
        console.log(`  - ${code} — already 20%, skipping`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  ~ ${code} — would update ${(currentPct * 100)}% → 20%`);
        updated++;
        continue;
      }

      const updateResult = await shopifyGraphql(
        `mutation updateDiscount($id: ID!, $discount: DiscountCodeBasicInput!) {
          discountCodeBasicUpdate(id: $id, basicCodeDiscount: $discount) {
            userErrors { field message }
          }
        }`,
        {
          id: node.id,
          discount: {
            customerGets: {
              value: { percentage: 0.2 },
              items: { all: true },
            },
          },
        },
      );

      const errors = updateResult.data?.discountCodeBasicUpdate?.userErrors ?? [];
      if (errors.length > 0) {
        console.log(`  ! ${code} — ERROR: ${errors[0].message}`);
      } else {
        console.log(`  + ${code} — updated to 20%`);
        updated++;
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    if (!result.data?.codeDiscountNodes?.pageInfo?.hasNextPage) break;
  }

  console.log(`\nDone! ${updated}/${total} discounts updated.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
