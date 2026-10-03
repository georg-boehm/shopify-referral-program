import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

interface ReferralCodeRow {
  id: number;
  code: string;
  customerId: string;
  email: string | null;
  createdAt: string;
  successfulCount: number;
  lifetimeCount: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const codes = await prisma.referralCode.findMany({
    orderBy: { createdAt: "desc" },
  });

  // Fetch metafield counts for each customer
  const rows: ReferralCodeRow[] = [];
  for (const code of codes) {
    let successfulCount = 0;
    let lifetimeCount = 0;

    try {
      const result = await admin.graphql(
        `#graphql
        query getCustomerCounts($customerId: ID!) {
          customer(id: $customerId) {
            metafields(first: 10, namespace: "referral") {
              edges {
                node { key value }
              }
            }
          }
        }`,
        { variables: { customerId: code.customerId } },
      );
      const data = (await result.json()).data;
      const mf =
        data?.customer?.metafields?.edges?.map(
          (e: { node: { key: string; value: string } }) => e.node,
        ) ?? [];
      successfulCount = parseInt(
        mf.find((m: { key: string }) => m.key === "successful_count")?.value ??
          "0",
        10,
      );
      lifetimeCount = parseInt(
        mf.find((m: { key: string }) => m.key === "lifetime_count")?.value ??
          "0",
        10,
      );
    } catch {
      // If customer fetch fails, show 0s
    }

    rows.push({
      id: code.id,
      code: code.code,
      customerId: code.customerId,
      email: code.email,
      createdAt: code.createdAt.toISOString(),
      successfulCount,
      lifetimeCount,
    });
  }

  return { rows };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const email = (formData.get("email") as string)?.trim();
  const code = (formData.get("code") as string)?.trim().toUpperCase();

  if (!email || !code) {
    return { error: "E-Mail und Code sind erforderlich." };
  }

  if (!/^[A-Z0-9-]+$/.test(code)) {
    return { error: "Code darf nur Buchstaben, Zahlen und Bindestriche enthalten." };
  }

  // Check if code already exists
  const existing = await prisma.referralCode.findUnique({ where: { code } });
  if (existing) {
    return { error: `Code „${code}" ist bereits vergeben.` };
  }

  // Look up customer by email
  const customerResult = await admin.graphql(
    `#graphql
    query findCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
          }
        }
      }
    }`,
    { variables: { query: `email:${email}` } },
  );

  const customerData = (await customerResult.json()).data;
  const customer = customerData?.customers?.edges?.[0]?.node;

  if (!customer) {
    return {
      error: `Kein Kunde mit E-Mail „${email}" gefunden. Der Kunde muss sich zuerst im Shop anmelden.`,
    };
  }

  // Check if customer already has a referral code
  const existingForCustomer = await prisma.referralCode.findFirst({
    where: { customerId: customer.id },
  });
  if (existingForCustomer) {
    // Check if the old code has ever been used — if not, allow override
    let canOverride = true;
    let reason = "";

    // Check lifetime_count metafield
    const metafieldResult = await admin.graphql(
      `#graphql
      query getCustomerCounts($customerId: ID!) {
        customer(id: $customerId) {
          metafields(first: 10, namespace: "referral") {
            edges { node { key value } }
          }
        }
      }`,
      { variables: { customerId: customer.id } },
    );
    const mfData = (await metafieldResult.json()).data;
    const mf = mfData?.customer?.metafields?.edges?.map(
      (e: { node: { key: string; value: string } }) => e.node,
    ) ?? [];
    const lifetimeCount = parseInt(
      mf.find((m: { key: string }) => m.key === "lifetime_count")?.value ?? "0",
      10,
    );
    if (lifetimeCount > 0) {
      canOverride = false;
      reason = `Code „${existingForCustomer.code}" hat bereits ${lifetimeCount} Empfehlung(en) gutgeschrieben.`;
    }

    // Check discount code usage
    if (canOverride) {
      const discountResult = await admin.graphql(
        `#graphql
        query checkDiscountUsage($code: String!) {
          codeDiscountNodeByCode(code: $code) {
            codeDiscount {
              ... on DiscountCodeBasic {
                asyncUsageCount
              }
            }
          }
        }`,
        { variables: { code: existingForCustomer.code } },
      );
      const discountData = (await discountResult.json()).data;
      const usageCount =
        discountData?.codeDiscountNodeByCode?.codeDiscount?.asyncUsageCount ?? 0;
      if (usageCount > 0) {
        canOverride = false;
        reason = `Code „${existingForCustomer.code}" wurde ${usageCount}-mal an der Kasse verwendet.`;
      }
    }

    if (!canOverride) {
      return {
        error: `Kann nicht überschrieben werden: ${reason}`,
      };
    }

    // Safe to override — delete old discount and DB record
    const oldDiscountResult = await admin.graphql(
      `#graphql
      query findOldDiscount($code: String!) {
        codeDiscountNodeByCode(code: $code) {
          id
        }
      }`,
      { variables: { code: existingForCustomer.code } },
    );
    const oldDiscountId = (await oldDiscountResult.json()).data
      ?.codeDiscountNodeByCode?.id;
    if (oldDiscountId) {
      await admin.graphql(
        `#graphql
        mutation deleteDiscount($id: ID!) {
          discountCodeDelete(id: $id) {
            userErrors { field message }
          }
        }`,
        { variables: { id: oldDiscountId } },
      );
    }

    await prisma.referralCode.delete({
      where: { id: existingForCustomer.id },
    });
  }

  // Create the discount code in Shopify
  const discountResult = await admin.graphql(
    `#graphql
    mutation createReferralDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        basicCodeDiscount: {
          title: `Referral ${code}`,
          code,
          startsAt: new Date().toISOString(),
          minimumRequirement: {
            subtotal: { greaterThanOrEqualToSubtotal: "29.90" },
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
    },
  );

  const discountData = (await discountResult.json()).data;
  const discountErrors =
    discountData?.discountCodeBasicCreate?.userErrors ?? [];
  if (discountErrors.length > 0) {
    return { error: `Rabattcode-Erstellung fehlgeschlagen: ${discountErrors[0].message}` };
  }

  // Set customer metafields
  const updateResult = await admin.graphql(
    `#graphql
    mutation initReferralMetafields($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          id: customer.id,
          metafields: [
            {
              namespace: "referral",
              key: "code",
              type: "single_line_text_field",
              value: code,
            },
            {
              namespace: "referral",
              key: "successful_count",
              type: "number_integer",
              value: "0",
            },
            {
              namespace: "referral",
              key: "lifetime_count",
              type: "number_integer",
              value: "0",
            },
            {
              namespace: "referral",
              key: "history",
              type: "json",
              value: "[]",
            },
          ],
        },
      },
    },
  );

  const updateErrors =
    (await updateResult.json()).data?.customerUpdate?.userErrors ?? [];
  if (updateErrors.length > 0) {
    return { error: `Metafeld-Aktualisierung fehlgeschlagen: ${updateErrors[0].message}` };
  }

  // Save to DB
  await prisma.referralCode.create({
    data: {
      code,
      customerId: customer.id,
      email,
      shop: session.shop,
    },
  });

  return { success: `Code „${code}" wurde für ${email} erstellt.` };
};

export default function Index() {
  const { rows } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state !== "idle";

  return (
    <s-page heading="Empfehlungsprogramm">
      <s-section heading="Empfehlungscode zuweisen">
        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            {fetcher.data && "error" in fetcher.data && (
              <s-banner tone="critical">
                <s-text>{fetcher.data.error}</s-text>
              </s-banner>
            )}
            {fetcher.data && "success" in fetcher.data && (
              <s-banner tone="success">
                <s-text>{fetcher.data.success}</s-text>
              </s-banner>
            )}
            <s-text-field
              label="E-Mail des Kunden"
              name="email"
              type="email"
              required
            />
            <s-text-field
              label="Empfehlungscode"
              name="code"
              required
              placeholder="z.B. REF-A7X3K"
            />
            <s-button variant="primary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Wird erstellt..." : "Code erstellen"}
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Alle Empfehlungscodes">
        {rows.length === 0 ? (
          <s-text color="subdued">Noch keine Empfehlungscodes erstellt.</s-text>
        ) : (
          <s-stack direction="block" gap="base">
            {/* Table header */}
            <s-stack direction="inline" gap="loose">
              <s-box inlineSize="200px">
                <s-text type="strong">Code</s-text>
              </s-box>
              <s-box inlineSize="200px">
                <s-text type="strong">E-Mail</s-text>
              </s-box>
              <s-box inlineSize="100px">
                <s-text type="strong">Offen</s-text>
              </s-box>
              <s-box inlineSize="100px">
                <s-text type="strong">Gesamt</s-text>
              </s-box>
              <s-box inlineSize="120px">
                <s-text type="strong">Erstellt</s-text>
              </s-box>
            </s-stack>
            <s-divider />
            {/* Table rows */}
            {rows.map((row) => (
              <s-stack key={row.id} direction="inline" gap="loose">
                <s-box inlineSize="200px">
                  <s-text type="strong">{row.code}</s-text>
                </s-box>
                <s-box inlineSize="200px">
                  <s-text>{row.email ?? "—"}</s-text>
                </s-box>
                <s-box inlineSize="100px">
                  <s-text>
                    {row.successfulCount > 0
                      ? `${row.successfulCount} (${row.successfulCount * 7.5} €)`
                      : "0"}
                  </s-text>
                </s-box>
                <s-box inlineSize="100px">
                  <s-text>{String(row.lifetimeCount)}</s-text>
                </s-box>
                <s-box inlineSize="120px">
                  <s-text color="subdued">
                    {new Date(row.createdAt).toLocaleDateString("de-DE")}
                  </s-text>
                </s-box>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
