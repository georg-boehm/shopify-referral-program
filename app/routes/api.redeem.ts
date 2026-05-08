import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";

const CREDIT_PER_REFERRAL = 7.5; // EUR

// Handle CORS preflight
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.public.customerAccount(request);
  return cors(new Response(null, { status: 204 }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(
    request,
  );

  const shop = sessionToken.dest.replace(/^https?:\/\//, "");
  const customerId = sessionToken.sub;
  const { admin } = await unauthenticated.admin(shop);

  // Read current metafields
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

  const successfulCount = parseInt(
    metafields.find((m: { key: string }) => m.key === "successful_count")
      ?.value ?? "0",
    10,
  );

  if (successfulCount <= 0) {
    return cors(
      Response.json({ error: "No referrals to redeem" }, { status: 400 }),
    );
  }

  const amount = successfulCount * CREDIT_PER_REFERRAL;
  const history: Array<{
    date: string;
    amount: number;
    discountCode: string;
    referrals?: number;
    used?: boolean;
  }> = JSON.parse(
    metafields.find((m: { key: string }) => m.key === "history")?.value ?? "[]",
  );

  // Generate a unique reward discount code
  const rewardCode = `REWARD-${randomString(6)}`;

  // Create a single-use fixed-amount discount code
  const discountResult = await admin.graphql(
    `#graphql
    mutation createRewardDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
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
        basicCodeDiscount: {
          title: `Referral Reward ${rewardCode}`,
          code: rewardCode,
          startsAt: new Date().toISOString(),
          endsAt: new Date(
            Date.now() + 90 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          customerGets: {
            value: {
              discountAmount: {
                amount: amount.toFixed(2),
                appliesOnEachItem: false,
              },
            },
            items: {
              all: true,
            },
          },
          customerSelection: {
            all: true,
          },
          usageLimit: 1,
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
    console.error("Failed to create reward discount:", discountErrors);
    return cors(
      Response.json(
        { error: "Failed to create reward discount" },
        { status: 500 },
      ),
    );
  }

  // Update metafields: reset count, append to history
  history.unshift({
    date: new Date().toISOString(),
    amount,
    discountCode: rewardCode,
    referrals: successfulCount,
  });

  await admin.graphql(
    `#graphql
    mutation updateAfterRedemption($input: CustomerInput!) {
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
          id: customerId,
          metafields: [
            {
              namespace: "referral",
              key: "successful_count",
              type: "number_integer",
              value: "0",
            },
            {
              namespace: "referral",
              key: "history",
              type: "json",
              value: JSON.stringify(history),
            },
          ],
        },
      },
    },
  );

  console.log(
    `Customer ${customerId} redeemed ${successfulCount} referrals for €${amount} → ${rewardCode}`,
  );

  return cors(
    Response.json({
      discountCode: rewardCode,
      amount,
      referralsRedeemed: successfulCount,
    }),
  );
};

function randomString(length: number): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
