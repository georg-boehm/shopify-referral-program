import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { payload, shop, topic } = await authenticate.webhook(request);

    console.log(`Received ${topic} webhook for ${shop}`);

    const order = payload as OrderPayload;

    // Check if any discount code on the order matches a referral code in our DB
    const discountCodes = order.discount_codes ?? [];
    let referralRecord = null;
    let code = "";

    for (const dc of discountCodes) {
      const upperCode = dc.code.toUpperCase();
      const record = await prisma.referralCode.findUnique({
        where: { code: upperCode },
      });
      if (record) {
        referralRecord = record;
        code = upperCode;
        break;
      }
    }

    if (!referralRecord) {
      return new Response();
    }

    // Idempotency: skip if we already processed this order
    const orderId = String(order.id);
    try {
      await prisma.processedOrder.create({ data: { orderId } });
    } catch {
      console.log(`Order ${orderId} already processed, skipping duplicate webhook`);
      return new Response();
    }

    const orderTotal = parseFloat(order.total_price ?? "0");
    console.log(`Order ${order.id} used referral code ${code} (total: €${orderTotal})`);

    const referrerId = referralRecord.customerId;

    // Self-referral prevention: compare customer IDs
    const orderCustomerId = order.customer?.id
      ? `gid://shopify/Customer/${order.customer.id}`
      : null;

    if (orderCustomerId && orderCustomerId === referrerId) {
      console.log(`Self-referral blocked for customer ${referrerId}`);
      return new Response();
    }

    const { admin } = await unauthenticated.admin(shop);

    // First order only check — query Shopify directly since webhook payload may be unreliable
    if (orderCustomerId) {
      const orderCountResult = await admin.graphql(
        `#graphql
        query getCustomerOrderCount($customerId: ID!) {
          customer(id: $customerId) {
            orders(first: 2) {
              edges { node { id } }
            }
          }
        }`,
        { variables: { customerId: orderCustomerId } },
      );
      const orderCountData = (await orderCountResult.json()).data;
      const numberOfOrders = orderCountData?.customer?.orders?.edges?.length ?? 0;
      console.log(`Customer ${orderCustomerId} has ${numberOfOrders} orders`);
      if (numberOfOrders > 1) {
        console.log(`Not a first-time buyer — referral not credited`);
        return new Response();
      }
    }

    // Read current counts from metafields
    const referrerResult = await admin.graphql(
      `#graphql
      query getReferrerCounts($customerId: ID!) {
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
      { variables: { customerId: referrerId } },
    );

    const referrerData = (await referrerResult.json()).data;
    const metafields =
      referrerData?.customer?.metafields?.edges?.map(
        (e: { node: { key: string; value: string } }) => e.node,
      ) ?? [];

    const currentSuccessful = parseInt(
      metafields.find((m: { key: string }) => m.key === "successful_count")
        ?.value ?? "0",
      10,
    );
    const currentLifetime = parseInt(
      metafields.find((m: { key: string }) => m.key === "lifetime_count")
        ?.value ?? "0",
      10,
    );

    // Increment counts
    await admin.graphql(
      `#graphql
      mutation incrementReferralCounts($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: {
            id: referrerId,
            metafields: [
              {
                namespace: "referral",
                key: "successful_count",
                type: "number_integer",
                value: String(currentSuccessful + 1),
              },
              {
                namespace: "referral",
                key: "lifetime_count",
                type: "number_integer",
                value: String(currentLifetime + 1),
              },
            ],
          },
        },
      },
    );

    console.log(
      `Credited referral to ${referrerId}: successful=${currentSuccessful + 1}, lifetime=${currentLifetime + 1}`,
    );
  } catch (e) {
    console.error("Webhook processing error:", e);
    throw e;
  }

  return new Response();
};

// Minimal type for the order webhook payload fields we use
interface OrderPayload {
  id: number;
  total_price?: string;
  discount_codes?: Array<{
    code: string;
    amount: string;
    type: string;
  }>;
  customer?: {
    id: number;
    orders_count?: number;
  };
}
