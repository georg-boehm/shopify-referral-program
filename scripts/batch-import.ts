/**
 * Batch import referral codes from CSV.
 *
 * 1. Calls Shopify Admin API directly to create discounts + set metafields
 * 2. Outputs a SQL file to pipe into the Fly production DB
 *
 * Usage:
 *   # Get the prod access token:
 *   fly ssh console -a your-app-name -C 'sqlite3 /app/prisma/dev.sqlite "SELECT accessToken FROM Session WHERE isOnline = 0 LIMIT 1;"'
 *
 *   # Run the import:
 *   npx tsx scripts/batch-import.ts --shop your-shop.myshopify.com --token <token> --csv path/to/customers.csv
 *
 *   # Dry run first (no Shopify changes, no SQL output):
 *   npx tsx scripts/batch-import.ts --shop your-shop.myshopify.com --token <token> --csv path/to/customers.csv --dry-run
 *
 *   # Then apply the generated SQL to prod:
 *   fly ssh console -a your-app-name -C 'sqlite3 /app/prisma/dev.sqlite' < scripts/import-result.sql
 */

import { readFileSync, writeFileSync } from "fs";
import { parseArgs } from "util";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_VERSION = "2025-10";
const MINIMUM_SUBTOTAL = "29.90";

const { values: args } = parseArgs({
  options: {
    shop: { type: "string" },
    token: { type: "string" },
    csv: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!args.shop || !args.token || !args.csv) {
  console.error("Usage: npx tsx scripts/batch-import.ts --shop <shop> --token <token> --csv <path>");
  process.exit(1);
}

const SHOP = args.shop;
const TOKEN = args.token;
const CSV_PATH = args.csv;
const DRY_RUN = args["dry-run"] ?? false;
const GRAPHQL_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

// --- GraphQL helper ---

async function shopifyGraphql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// --- CSV parser ---

function parseCsv(content: string): Array<Record<string, string>> {
  const lines = content.trim().split("\n");
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).filter((l) => l.trim()).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = values[i] ?? ""));
    return row;
  });
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// --- SQL escaping ---

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

// --- Core import logic per customer ---

interface ImportResult {
  status: "created" | "skipped" | "error" | "dry-run";
  detail: string;
  customerId?: string;
}

async function importOne(email: string, code: string): Promise<ImportResult> {
  // 1. Find customer by email
  const customerResult = await shopifyGraphql(
    `query findCustomer($query: String!) {
      customers(first: 1, query: $query) {
        edges { node { id } }
      }
    }`,
    { query: `email:${email}` },
  );
  const customer = customerResult.data?.customers?.edges?.[0]?.node;
  if (!customer) {
    return { status: "error", detail: `No customer found for ${email}` };
  }

  // 2. Check if customer already has a referral code metafield
  const metafieldResult = await shopifyGraphql(
    `query checkExisting($customerId: ID!) {
      customer(id: $customerId) {
        metafield(namespace: "referral", key: "code") { value }
      }
    }`,
    { customerId: customer.id },
  );
  const existingCode = metafieldResult.data?.customer?.metafield?.value;
  if (existingCode === code) {
    return { status: "skipped", detail: `Already has this code`, customerId: customer.id };
  }
  // If customer has a different code, we'll overwrite it (old discount should already be deleted)

  if (DRY_RUN) {
    return { status: "dry-run", detail: `Would create ${code} for ${customer.id}`, customerId: customer.id };
  }

  // 3. Create the 20% discount code
  const discountResult = await shopifyGraphql(
    `mutation createReferralDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`,
    {
      basicCodeDiscount: {
        title: `Referral ${code}`,
        code,
        startsAt: new Date().toISOString(),
        minimumRequirement: {
          subtotal: { greaterThanOrEqualToSubtotal: MINIMUM_SUBTOTAL },
        },
        customerGets: {
          value: { percentage: 0.2 },
          items: { all: true },
        },
        customerSelection: { all: true },
        usageLimit: null,
        appliesOncePerCustomer: true,
        combinesWith: {
          orderDiscounts: true,
          productDiscounts: true,
          shippingDiscounts: true,
        },
      },
    },
  );

  const discountErrors = discountResult.data?.discountCodeBasicCreate?.userErrors ?? [];
  if (discountErrors.length > 0) {
    return { status: "error", detail: `Discount failed: ${discountErrors[0].message}`, customerId: customer.id };
  }

  // 4. Set customer metafields
  const updateResult = await shopifyGraphql(
    `mutation initReferralMetafields($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        id: customer.id,
        metafields: [
          { namespace: "referral", key: "code", type: "single_line_text_field", value: code },
          { namespace: "referral", key: "successful_count", type: "number_integer", value: "0" },
          { namespace: "referral", key: "lifetime_count", type: "number_integer", value: "0" },
          { namespace: "referral", key: "history", type: "json", value: "[]" },
        ],
      },
    },
  );

  const updateErrors = updateResult.data?.customerUpdate?.userErrors ?? [];
  if (updateErrors.length > 0) {
    return { status: "error", detail: `Metafield update failed: ${updateErrors[0].message}`, customerId: customer.id };
  }

  return { status: "created", detail: `${code} → ${customer.id}`, customerId: customer.id };
}

// --- Main ---

async function main() {
  const csvContent = readFileSync(CSV_PATH, "utf-8");
  const rows = parseCsv(csvContent);

  console.log(`\nBatch import: ${rows.length} rows from ${CSV_PATH}`);
  console.log(`Shop: ${SHOP}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  const results = { created: 0, skipped: 0, error: 0, "dry-run": 0 };
  const sqlStatements: string[] = [
    "-- Generated by batch-import.ts",
    `-- ${new Date().toISOString()}`,
    "",
    "-- Clear any pre-existing referral codes",
    "DELETE FROM ReferralCode;",
    "",
  ];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = row["email"] || row["Kunden-E-Mail-Adresse"];
    const code = row["referral_code"];

    if (!email || !code) {
      console.log(`[${i + 1}/${rows.length}] SKIP — missing email or code`);
      results.error++;
      continue;
    }

    try {
      const result = await importOne(email, code);
      results[result.status as keyof typeof results]++;
      const icon = result.status === "created" ? "+" : result.status === "skipped" ? "-" : result.status === "error" ? "!" : "~";
      console.log(`[${i + 1}/${rows.length}] ${icon} ${email} — ${result.status}: ${result.detail}`);

      if (result.status === "created" && result.customerId) {
        sqlStatements.push(
          `INSERT INTO ReferralCode (code, customerId, email, shop, createdAt) VALUES ('${sqlEscape(code)}', '${sqlEscape(result.customerId)}', '${sqlEscape(email)}', '${sqlEscape(SHOP)}', datetime('now'));`,
        );
      }
    } catch (e) {
      results.error++;
      console.log(`[${i + 1}/${rows.length}] ! ${email} — EXCEPTION: ${e}`);
    }

    // Rate limit: ~4 requests per customer, stay under Shopify's 40/s
    if (!DRY_RUN) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log(`\nDone! Created: ${results.created}, Skipped: ${results.skipped}, Errors: ${results.error}${DRY_RUN ? `, Dry-run: ${results["dry-run"]}` : ""}`);

  if (!DRY_RUN && sqlStatements.length > 6) {
    const sqlPath = join(__dirname, "import-result.sql");
    writeFileSync(sqlPath, sqlStatements.join("\n") + "\n");
    console.log(`\nSQL written to: ${sqlPath}`);
    console.log(`Apply to prod:  fly ssh console -a your-app-name -C 'sqlite3 /app/prisma/dev.sqlite' < ${sqlPath}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
