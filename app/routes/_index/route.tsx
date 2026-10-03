import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Two-sided referral program</h1>
        <p className={styles.text}>
          Customers share a referral code; both the referrer and the new
          customer receive credit.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Automatic attribution</strong>. Referral codes are matched
            against paid orders through HMAC-verified webhooks, with
            self-referral and first-order checks applied before credit is
            issued.
          </li>
          <li>
            <strong>Credit the merchant keeps</strong>. Balances and referral
            history live in Shopify customer metafields rather than the app
            database, so the data survives uninstalling the app.
          </li>
          <li>
            <strong>Self-service redemption</strong>. Customers view their code
            and referral count in their account, and convert accumulated credit
            into a single-use discount code.
          </li>
        </ul>
      </div>
    </div>
  );
}
