// webhooks.js
import Stripe from "stripe";
import bodyParser from "body-parser";

/**
 * FlavorCoach — Stripe Webhooks → GHL v1 Contacts Upsert (tags + audit fields)
 * - Server's only job: upsert contact, add tags, stamp audit fields.
 * - Pipeline movement is handled INSIDE GHL via your Tag-Added workflows.
 *
 * Live today:   checkout.session.completed  -> adds fc:trial_checkout + evt:cs_*
 * Ready later:  invoice.payment_succeeded   -> adds fc:payment_succeeded + evt:in_* (+ evt:sub_*)
 *               invoice.payment_failed      -> adds fc:payment_failed    + evt:in_* (+ evt:sub_*)
 *               customer.subscription.deleted -> adds fc:sub_canceled    + evt:sub_*
 *               customer.subscription.updated(status=active) -> adds fc:payment_succeeded (and fc:sub_active) + evt:sub_*
 */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// ---------------- Tag helpers ----------------
const TAGS = {
  STABLE: {
    TRIAL: "fc:trial_checkout",
    ACTIVE: "fc:payment_succeeded",
    SUB_ACTIVE: "fc:sub_active",
    DUNNING: "fc:payment_failed",
    CANCELED: "fc:sub_canceled",
  },
  evt: {
    cs: (id)  => `evt:cs_${id}`,   // checkout session
    in: (id)  => `evt:in_${id}`,   // invoice
    sub: (id) => `evt:sub_${id}`,  // subscription
  },
};

// --------------- GHL v1 upsert ----------------
async function ghlV1UpsertContact({ email, firstName, lastName, phone, tags = [], customFields = {} }) {
  if (!email) { console.warn("[GHL upsert] skipped: missing email"); return; }

  const apiKey = process.env.GHL_V1_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!apiKey || !locationId) {
    console.error("[GHL upsert] Missing GHL_V1_API_KEY or GHL_LOCATION_ID");
    return;
  }

  const payload = { email, firstName, lastName, phone, tags, customFields };

  const res = await fetch("https://rest.gohighlevel.com/v1/contacts/upsert", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      LocationId: locationId,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[GHL upsert] Failed:", res.status, text?.slice(0, 500));
    return;
  }
  const data = await res.json().catch(() => ({}));
  console.log("[GHL upsert] OK → contactId:", data?.contact?.id || "(unknown)");
  return data;
}

// --------------- helpers ----------------
function splitName(full = "") {
  const parts = (full || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "" };
}

function expressRawJson() {
  return bodyParser.raw({ type: "application/json" });
}

// --------------- Route registration ----------------
export function registerStripeWebhooks(app) {
  // IMPORTANT: mount this route BEFORE app.use(express.json())
  app.post("/api/stripe/webhook", expressRawJson(), async (req, res) => {
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("[Stripe] Signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        // ======== LIVE TODAY: TRIAL ========
        case "checkout.session.completed": {
          const s = event.data.object;
          const email = s?.customer_details?.email || s?.customer_email || "";
          if (!email) { console.warn("[Trial] Missing email; skip upsert."); break; }

          const { first, last } = splitName(s?.customer_details?.name || "");
          const phone       = s?.customer_details?.phone || "";
          const customerId  = s?.customer || "";      // cus_*
          const sessionId   = s?.id || "";            // cs_*

          const customFields = {
            "Last Checkout Session ID": sessionId,
            "Stripe Customer ID": customerId,
            "Last Stripe Event Type": event.type,
            "Last Stripe Event Time": new Date(event.created * 1000).toISOString(),
          };

          const tags = [TAGS.STABLE.TRIAL, TAGS.evt.cs(sessionId)];

          await ghlV1UpsertContact({ email, firstName: first, lastName: last, phone, tags, customFields });
          break;
        }

        // ======== READY LATER: ACTIVE (invoice success) ========
        case "invoice.payment_succeeded": {
          const inv = event.data.object;
          const email = inv?.customer_email || "";  // present for hosted Checkout invoices
          if (!email) { console.warn("[Active] Missing email on invoice; skip upsert."); break; }

          const invoiceId   = inv?.id || "";          // in_*
          const subId       = inv?.subscription || ""; // sub_*
          const customerId  = inv?.customer || "";     // cus_*

          const customFields = {
            "Last Invoice ID": invoiceId,            // (create this field later if you want)
            "Last Subscription ID": subId,           // (create later)
            "Stripe Customer ID": customerId,
            "Last Stripe Event Type": event.type,
            "Last Stripe Event Time": new Date(event.created * 1000).toISOString(),
          };

          const tags = [TAGS.STABLE.ACTIVE, TAGS.evt.in(invoiceId)];
          if (subId) tags.push(TAGS.evt.sub(subId));

          await ghlV1UpsertContact({ email, tags, customFields });
          break;
        }

        // ======== READY LATER: DUNNING (invoice failed) ========
        case "invoice.payment_failed": {
          const inv = event.data.object;
          const email = inv?.customer_email || "";
          if (!email) { console.warn("[Dunning] Missing email on invoice; skip upsert."); break; }

          const invoiceId   = inv?.id || "";
          const subId       = inv?.subscription || "";
          const customerId  = inv?.customer || "";

          const customFields = {
            "Last Invoice ID": invoiceId,
            "Last Subscription ID": subId,
            "Stripe Customer ID": customerId,
            "Last Stripe Event Type": event.type,
            "Last Stripe Event Time": new Date(event.created * 1000).toISOString(),
          };

          const tags = [TAGS.STABLE.DUNNING, TAGS.evt.in(invoiceId)];
          if (subId) tags.push(TAGS.evt.sub(subId));

          await ghlV1UpsertContact({ email, tags, customFields });
          break;
        }

        // ======== READY LATER: CANCELED (subscription deleted) ========
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const customerId = sub?.customer;
          let email = "";

          // fetch customer email when not present
          if (customerId) {
            try {
              const customer = await stripe.customers.retrieve(customerId);
              email = customer?.email || "";
            } catch (e) {
              console.warn("[Canceled] Could not fetch customer email", e?.message);
            }
          }
          if (!email) { console.warn("[Canceled] Missing email; skip upsert."); break; }

          const subId = sub?.id || "";

          const customFields = {
            "Last Subscription ID": subId,
            "Stripe Customer ID": customerId || "",
            "Last Stripe Event Type": event.type,
            "Last Stripe Event Time": new Date(event.created * 1000).toISOString(),
          };

          const tags = [TAGS.STABLE.CANCELED, TAGS.evt.sub(subId)];

          await ghlV1UpsertContact({ email, tags, customFields });
          break;
        }

        // ======== READY LATER: SUB UPDATED → ACTIVE (status=active) ========
        case "customer.subscription.updated": {
          const sub = event.data.object;
          if (sub?.status !== "active") break;  // only act on active

          const customerId = sub?.customer;
          let email = "";

          if (customerId) {
            try {
              const customer = await stripe.customers.retrieve(customerId);
              email = customer?.email || "";
            } catch (e) {
              console.warn("[Sub Active] Could not fetch customer email", e?.message);
            }
          }
          if (!email) { console.warn("[Sub Active] Missing email; skip upsert."); break; }

          const subId = sub?.id || "";

          const customFields = {
            "Last Subscription ID": subId,
            "Stripe Customer ID": customerId || "",
            "Last Stripe Event Type": event.type,
            "Last Stripe Event Time": new Date(event.created * 1000).toISOString(),
          };

          // You can use either/both tags to trigger your future Active workflow
          const tags = [TAGS.STABLE.ACTIVE, TAGS.STABLE.SUB_ACTIVE, TAGS.evt.sub(subId)];

          await ghlV1UpsertContact({ email, tags, customFields });
          break;
        }

        default:
          // ignore everything else for now
          break;
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("[Webhook handler] Error:", err);
      return res.status(500).send("Server error");
    }
  });
}
