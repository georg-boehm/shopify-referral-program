import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";

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

  // Check if the customer already has a referral code
  const customerResult = await admin.graphql(
    `#graphql
    query getCustomerReferralCode($customerId: ID!) {
      customer(id: $customerId) {
        metafield(namespace: "referral", key: "code") {
          value
        }
      }
    }`,
    { variables: { customerId } },
  );

  const customerData = (await customerResult.json()).data;
  const existingCode = customerData?.customer?.metafield?.value;

  if (existingCode) {
    return cors(Response.json({ code: existingCode, created: false }));
  }

  // Generate a unique referral code
  const code = await generateUniqueCode(admin);

  // Create the 10% discount code in Shopify
  const discountResult = await admin.graphql(
    `#graphql
    mutation createReferralDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              codes(first: 1) {
                edges {
                  node {
                    code
                  }
                }
              }
            }
          }
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
          title: `Referral ${code}`,
          code,
          startsAt: new Date().toISOString(),
          customerGets: {
            value: {
              percentage: 0.2,
            },
            items: {
              all: true,
            },
          },
          customerSelection: {
            all: true,
          },
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
    console.error("Failed to create referral discount:", discountErrors);
    return cors(
      Response.json(
        { error: "Failed to create referral discount" },
        { status: 500 },
      ),
    );
  }

  // Save the referral code and initialize counts on the customer
  const updateResult = await admin.graphql(
    `#graphql
    mutation initReferralMetafields($input: CustomerInput!) {
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
    console.error("Failed to save referral metafields:", updateErrors);
    return cors(
      Response.json(
        { error: "Failed to initialize referral data" },
        { status: 500 },
      ),
    );
  }

  // Save code→customer mapping in local DB
  await prisma.referralCode.create({
    data: { code, customerId, shop },
  });

  console.log(`Created referral code ${code} for customer ${customerId}`);
  return cors(Response.json({ code, created: true }));
};

async function generateUniqueCode(
  admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"],
): Promise<string> {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No 0/O/1/I to avoid confusion
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let code = "REF-";
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }

    // Check uniqueness against local DB
    const existing = await prisma.referralCode.findUnique({ where: { code } });
    if (!existing) {
      return code;
    }
  }

  throw new Error("Failed to generate unique referral code after max attempts");
}
