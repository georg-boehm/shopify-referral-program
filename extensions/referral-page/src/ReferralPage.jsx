import '@shopify/ui-extensions/preact';
import {render} from "preact";
import {useState, useEffect, useCallback} from "preact/hooks";

const CREDIT_PER_REFERRAL = 7.5;

const t = {
  heading: "Meine Empfehlungen",
  loading: "Empfehlungsdaten werden geladen...",
  yourCode: "Dein Empfehlungscode",
  shareLink: "Oder teile diesen Link — der Rabatt wird automatisch angewendet:",
  shareText: "Teile diesen Code oder Link mit Freunden. Sie erhalten 20 % Rabatt auf ihre erste Bestellung und du verdienst 7,50 € Guthaben pro erfolgreicher Empfehlung.",
  lifetimeReferrals: "Empfehlungen gesamt",
  availableBalance: "Verfügbares Guthaben",
  noBalance: "Noch kein Guthaben vorhanden. Teile deinen Empfehlungscode und fang an zu verdienen!",
  redeemButton: (amount) => `${amount} € einlösen`,
  confirmText: (amount) => `Es wird ein einmalig verwendbarer Rabattcode über ${amount} € erstellt. Dein Empfehlungszähler wird auf 0 zurückgesetzt.`,
  confirmYes: "Ja, einlösen",
  confirmCancel: "Abbrechen",
  redeemSuccess: (code) => `Dein Rabattcode lautet: ${code} — gültig für 90 Tage.`,
  toastSuccess: "Rabattcode erstellt!",
  redemptionHistory: "Einlöseverlauf",
  headerDate: "Datum",
  headerReferrals: "Empfehlungen",
  headerAmount: "Betrag",
  headerCode: "Code",
  headerStatus: "Status",
  statusUsed: "Eingelöst",
  statusUnused: "Offen",
  notEnrolled: "Unser Empfehlungsprogramm ist bald für alle verfügbar! Empfiehl uns weiter und verdiene Guthaben für deinen nächsten Einkauf. Schreib uns gerne, wenn du jetzt schon dabei sein möchtest!",
  errorLoad: "Empfehlungsdaten konnten nicht geladen werden",
  errorRedeem: "Einlösung fehlgeschlagen",
};

export default async () => {
  render(<ReferralPage />, document.body);
}

function ReferralPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [redeeming, setRedeeming] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [redeemResult, setRedeemResult] = useState(null);

  const loadData = useCallback(async () => {
    try {
      // Fetch all referral data from the app backend
      // (metafields aren't directly queryable from the extension without customerAccessToken)
      const result = await callBackend("/api/referral-data", "GET");
      if (result.error) {
        setError(result.error);
        return;
      }
      setData(result);
    } catch (e) {
      console.error("Failed to load referral data:", e);
      setError(t.errorLoad);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRedeem = useCallback(async () => {
    setShowConfirm(false);
    setRedeeming(true);
    setRedeemResult(null);

    try {
      const result = await callBackend("/api/redeem", "POST");
      if (result.error) {
        setError(result.error);
      } else {
        setRedeemResult(result.discountCode);
        await loadData();
        shopify.toast.show(t.toastSuccess);
      }
    } catch {
      setError(t.errorRedeem);
    } finally {
      setRedeeming(false);
    }
  }, [loadData]);

  if (loading) {
    return (
      <s-section heading={t.heading}>
        <s-text>{t.loading}</s-text>
      </s-section>
    );
  }

  if (error && !data) {
    return (
      <s-section heading={t.heading}>
        <s-banner tone="critical">
          <s-text>{error}</s-text>
        </s-banner>
      </s-section>
    );
  }

  if (data?.enrolled === false) {
    return (
      <s-section heading={t.heading}>
        <s-text color="subdued">{t.notEnrolled}</s-text>
      </s-section>
    );
  }

  const balance = (data?.successfulCount ?? 0) * CREDIT_PER_REFERRAL;
  const hasBalance = balance > 0;

  return (
    <s-section heading={t.heading}>
      <s-stack direction="block" gap="large">
        <s-banner tone="info">
          <s-text>Dieses Feature befindet sich in der Testphase. Bei Fragen oder Problemen erreichst du uns unter <s-link to="mailto:support@example.com">support@example.com</s-link> — wir kümmern uns sofort darum.</s-text>
        </s-banner>

        {error && (
          <s-banner tone="critical">
            <s-text>{error}</s-text>
          </s-banner>
        )}

        {redeemResult && (
          <s-banner tone="success">
            <s-text>{t.redeemSuccess(redeemResult)}</s-text>
          </s-banner>
        )}

        {/* Referral Code Section */}
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">{t.shareText}</s-text>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-heading>{data?.code}</s-heading>
              <s-button variant="tertiary" size="slim" commandFor="referral-code">
                Kopieren
              </s-button>
              <s-clipboard-item id="referral-code" text={data?.code ?? ""} />
            </s-stack>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-text>{data?.shareUrl}</s-text>
              <s-button variant="tertiary" size="slim" commandFor="share-url">
                Kopieren
              </s-button>
              <s-clipboard-item id="share-url" text={data?.shareUrl ?? ""} />
            </s-stack>
          </s-stack>
        </s-box>

        {/* Stats Section */}
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">{t.lifetimeReferrals}</s-text>
              <s-heading>{String(data?.lifetimeCount ?? 0)}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">{t.availableBalance}</s-text>
              <s-heading>{balance + " €"}</s-heading>
            </s-stack>
          </s-box>
        </s-grid>

        {/* Redeem Section */}
        {hasBalance ? (
          showConfirm ? (
            <s-banner tone="info">
              <s-text>{t.confirmText(balance)}</s-text>
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  onClick={handleRedeem}
                  disabled={redeeming}
                >
                  {t.confirmYes}
                </s-button>
                <s-button
                  variant="secondary"
                  onClick={() => setShowConfirm(false)}
                >
                  {t.confirmCancel}
                </s-button>
              </s-stack>
            </s-banner>
          ) : (
            <s-button
              variant="primary"
              onClick={() => setShowConfirm(true)}
              disabled={redeeming}
            >
              {t.redeemButton(balance)}
            </s-button>
          )
        ) : (
          <s-text color="subdued">{t.noBalance}</s-text>
        )}

        {/* Info Points */}
        <s-divider />
        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="small">
            <s-heading level="3">20 % für deine Freunde</s-heading>
            <s-text color="subdued">auf die erste Bestellung</s-text>
          </s-stack>
          <s-stack direction="block" gap="small">
            <s-heading level="3">7,50 € Guthaben für dich</s-heading>
            <s-text color="subdued">pro erfolgreicher Empfehlung</s-text>
          </s-stack>
          <s-stack direction="block" gap="small">
            <s-heading level="3">Ab 29,90 € Bestellwert</s-heading>
            <s-text color="subdued">für die erste Bestellung der Neukundin</s-text>
          </s-stack>
        </s-stack>

        {/* Terms & Conditions - opens in modal */}
        <s-divider />
        <s-button variant="secondary" commandFor="terms-modal" command="--show">
          Teilnahmebedingungen anzeigen
        </s-button>
        <s-modal id="terms-modal" heading="Teilnahmebedingungen">
          <s-stack direction="block" gap="base">
            <s-text>Mit dem ExampleShop-Empfehlungsprogramm können bestehende Kund:innen neue Kund:innen für den Einkauf im ExampleShop-Onlineshop empfehlen.</s-text>

            <s-text type="strong">1. Teilnahmeberechtigung</s-text>
            <s-text>Am Empfehlungsprogramm können nur natürliche Personen teilnehmen, die ein Kundenkonto bei ExampleShop besitzen und bereits mindestens eine Bestellung bei ExampleShop aufgegeben haben.</s-text>

            <s-text type="strong">2. Neukund:innen</s-text>
            <s-text>Als Neukundin oder Neukunde gilt nur, wer zuvor noch nie bei ExampleShop bestellt hat. Eine Person gilt insbesondere dann nicht als Neukundin oder Neukunde, wenn Name, Anschrift oder E-Mail-Adresse bereits bei einer früheren Bestellung verwendet wurden.</s-text>

            <s-text type="strong">3. Vorteil für geworbene Neukund:innen</s-text>
            <s-text>Geworbene Neukund:innen erhalten 20 % Rabatt auf ihre erste Bestellung im ExampleShop-Onlineshop. Der Rabatt gilt nur ab einem Mindestbestellwert von 29,90 €. Der Rabatt ist nicht mit anderen Rabattcodes, Gutscheinen oder Aktionen kombinierbar und kann nicht in bar ausgezahlt werden.</s-text>

            <s-text type="strong">4. Vorteil für empfehlende Kund:innen</s-text>
            <s-text>Für jede erfolgreich geworbene Neukundin bzw. jeden erfolgreich geworbenen Neukunden erhält die empfehlende Person einmalig 7,50 € Guthaben. Das Guthaben wird pro neu geworbener Person nur einmal gewährt, nicht in bar ausgezahlt und verfällt nicht.</s-text>

            <s-text type="strong">5. Wann eine Empfehlung erfolgreich ist</s-text>
            <s-text>Eine Empfehlung gilt nur dann als erfolgreich, wenn die geworbene Person tatsächlich Neukundin oder Neukunde ist, die erste Bestellung mindestens 29,90 € beträgt, die Bestellung vollständig bezahlt wurde und kein Verstoß gegen diese Teilnahmebedingungen vorliegt. Das Guthaben wird nach erfolgreicher Bezahlung der qualifizierten Erstbestellung freigegeben.</s-text>

            <s-text type="strong">6. Einlösung des Guthabens</s-text>
            <s-text>Das Guthaben kann im Kundenkonto über die Funktion „Einlösen" eingelöst werden. Dabei wird immer ein Gutscheincode über das gesamte aktuell verfügbare Guthaben erstellt. Eine automatische Aufteilung in mehrere Gutscheincodes ist nicht vorgesehen. Wer eine Aufteilung wünscht, kann sich an support@example.com wenden.</s-text>

            <s-text type="strong">7. Ausschluss von Selbstwerbung und Missbrauch</s-text>
            <s-text>Nicht erlaubt sind insbesondere Eigenempfehlungen, Selbstwerbung, Bestellungen über eigene oder mehrere E-Mail-Adressen, die Nutzung mehrerer Kundenkonten zur Umgehung der Teilnahmebedingungen, Scheingeschäfte, technische Manipulationen oder sonstige missbräuchliche Gestaltungen.</s-text>
            <s-text>ExampleShop ist berechtigt, Empfehlungen, Rabatte oder Guthaben bei Verdacht auf Missbrauch oder bei Verstößen gegen diese Teilnahmebedingungen abzulehnen, zu löschen oder rückgängig zu machen. Bei Missbrauch oder versuchtem Missbrauch kann die betreffende Person vom Empfehlungsprogramm ausgeschlossen werden. Bereits gewährtes Guthaben kann in diesem Fall gelöscht werden. Eine erneute Teilnahme ist dann nicht mehr möglich.</s-text>

            <s-text type="strong">8. Keine Kombination mit anderen Aktionen</s-text>
            <s-text>Der Rabatt für geworbene Neukund:innen ist nicht mit anderen Rabattaktionen, Gutscheinen, Sonderaktionen oder sonstigen Preisnachlässen kombinierbar.</s-text>

            <s-text type="strong">9. Änderung oder Beendigung des Empfehlungsprogramms</s-text>
            <s-text>ExampleShop behält sich das Recht vor, das Empfehlungsprogramm jederzeit ganz oder teilweise zu ändern, auszusetzen oder zu beenden, wenn hierfür ein sachlicher Grund besteht, insbesondere bei Missbrauch, technischen Problemen, rechtlichen Gründen oder wirtschaftlicher Unzumutbarkeit.</s-text>

            <s-text type="strong">10. Datenschutz</s-text>
            <s-text>Personenbezogene Daten werden im Rahmen des Empfehlungsprogramms nur insoweit verarbeitet, wie dies zur Durchführung des Programms, zur Zuordnung von Empfehlungen, zur Gewährung von Rabatten oder Guthaben und zur Missbrauchsverhinderung erforderlich ist. Weitere Informationen enthält die Datenschutzerklärung von ExampleShop.</s-text>
          </s-stack>
        </s-modal>

        {/* Redemption History Section */}
        {data?.history && data.history.length > 0 && (
          <s-stack direction="block" gap="base">
            <s-heading>{t.redemptionHistory}</s-heading>
            {/* Table header */}
            <s-grid gridTemplateColumns="1fr 1fr 1fr 2fr 1fr" gap="small">
              <s-text type="strong" color="subdued">{t.headerDate}</s-text>
              <s-text type="strong" color="subdued">{t.headerReferrals}</s-text>
              <s-text type="strong" color="subdued">{t.headerAmount}</s-text>
              <s-text type="strong" color="subdued">{t.headerCode}</s-text>
              <s-text type="strong" color="subdued">{t.headerStatus}</s-text>
            </s-grid>
            <s-divider />
            {/* Table rows */}
            {data.history.map((entry, i) => (
              <s-stack key={i} direction="block" gap="small">
                <s-grid gridTemplateColumns="1fr 1fr 1fr 2fr 1fr" gap="small">
                  <s-text>{new Date(entry.date).toLocaleDateString()}</s-text>
                  <s-text>{String(entry.referrals ?? "—")}</s-text>
                  <s-text type="strong">{entry.amount + " €"}</s-text>
                  <s-stack direction="inline" gap="small">
                    <s-text>{entry.discountCode}</s-text>
                    <s-clipboard-item text={entry.discountCode} />
                  </s-stack>
                  <s-badge tone={entry.used ? "success" : "info"}>
                    {entry.used ? t.statusUsed : t.statusUnused}
                  </s-badge>
                </s-grid>
                {i < data.history.length - 1 && <s-divider />}
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

async function callBackend(path, method) {
  const token = await shopify.sessionToken.get();
  // Use the app_url setting — must be configured in the extension settings
  const settingsUrl = shopify.settings.value?.app_url;
  if (!settingsUrl) {
    throw new Error("App URL not configured. Set it in the extension settings in the Shopify admin.");
  }
  const appUrl = String(settingsUrl).replace(/\/$/, "");
  const response = await fetch(appUrl + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });
  return response.json();
}
