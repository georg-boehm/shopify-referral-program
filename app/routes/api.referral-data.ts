import type { LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(
    request,
  );

  try {
    // dest may or may not have a protocol prefix
    const shop = sessionToken.dest.replace(/^https?:\/\//, "");
    const customerId = sessionToken.sub;

    console.log("Referral data request:", { shop, customerId });

    const { admin } = await unauthenticated.admin(shop);

    // Read customer metafields
    const customerResult = await admin.graphql(
      `#graphql
      query getCustomerReferralData($customerId: ID!) {
        customer(id: $customerId) {
          metafields(first: 10, namespace: "referral") {
            edges {
              node {
                key
                value
              }
            }
          }
        }
      }`,
      { variables: { customerId } },
    );

    const customerData = (await customerResult.json()).data;
    const metafields =
      customerData?.customer?.metafields?.edges?.map(
        (e: { node: { key: string; value: string } }) => e.node,
      ) ?? [];

    const code =
      metafields.find((m: { key: string }) => m.key === "code")?.value ?? null;
    const successfulCount = parseInt(
      metafields.find((m: { key: string }) => m.key === "successful_count")
        ?.value ?? "0",
      10,
    );
    const lifetimeCount = parseInt(
      metafields.find((m: { key: string }) => m.key === "lifetime_count")
        ?.value ?? "0",
      10,
    );
    const history = JSON.parse(
      metafields.find((m: { key: string }) => m.key === "history")?.value ??
        "[]",
    );

    // If no referral code exists, customer is not enrolled
    if (!code) {
      return cors(
        Response.json({ enrolled: false }),
      );
    }

    // Customer-facing share URL. Defaults to the shop's myshopify.com domain;
    // override SHOP_CUSTOMER_DOMAIN if the shop uses a custom domain.
    const customerDomain =
      process.env.SHOP_CUSTOMER_DOMAIN ?? `https://${shop}`;
    const shareUrl = `${customerDomain}/discount/${code}`;

    return cors(
      Response.json({ code, shareUrl, successfulCount, lifetimeCount, history }),
    );
  } catch (e) {
    console.error("Referral data error:", e);
    return cors(
      Response.json(
        { error: "Internal server error" },
        { status: 500 },
      ),
    );
  }
};