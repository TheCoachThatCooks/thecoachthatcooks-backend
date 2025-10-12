// webhooks.js (ESM)
import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import admin from "firebase-admin";

// --- GHL config (v1 = contacts, v2 = opportunities) ---
const GHL_LOCATION_ID     = process.env.GHL_LOCATION_ID;
const GHL_V1_API_KEY      = process.env.GHL_V1_API_KEY;        // Business Profile API key (v1)
const GHL_V2_ACCESS_TOKEN = process.env.GHL_V2_ACCESS_TOKEN;   // Private Integration token (v2)

// Optional safety logs (won't crash)
if (!GHL_LOCATION_ID)     console.warn("Missing GHL_LOCATION_ID");
if (!GHL_V1_API_KEY)      console.warn("Missing GHL_V1_API_KEY (v1 contacts)");
if (!GHL_V2_ACCESS_TOKEN) console.warn("Missing GHL_V2_ACCESS_TOKEN (v2 opportunities)");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

/* ---------- Firestore (optional but recommended) ---------- */
let db = null;
try {
  if (!admin.apps.length) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      admin.initializeApp({
        credential: admin.credential.cert(
          JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
        ),
      });
    } else {
      admin.initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS path if set
    }
  }
  db = admin.firestore();
} catch (e) {
  console.warn("Firestore init skipped:", e.message);
}

/* ---------- Single route: Stripe Webhook (raw body!) ---------- */
function registerStripeWebhooks(app) {
  app.post(
    "/api/stripe/webhook",
    bodyParser.raw({ type: "application/json" }), // must be raw for signature
    async (req, res) => {
      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error("Webhook signature failed:", err.message);
        return res.sendStatus(400);
      }

      try {
        switch (event.type) {
          case "checkout.session.completed": {
            const s = event.data.object;
            const email = s.customer_details?.email || "";
            const name = s.customer_details?.name || "";
            const phone = s.customer_details?.phone || "";
            const customerId = s.customer;         // "cus_..."
            const subscriptionId = s.subscription; // "sub_..."

            await upsertGhlContactAndTrialOpp({
              name, email, phone, customerId, subscriptionId,
            });
            await convertKitSubscribe({ email, firstName: name });

            // Mirror basic subscription state into Firestore
            let fields = { status: "trialing" };
            if (subscriptionId) {
              const sub = await stripe.subscriptions.retrieve(subscriptionId);
              fields = {
                status: sub.status,
                trial_end: sub.trial_end || null,
                current_period_end: sub.current_period_end || null,
                priceId: sub.items?.data?.[0]?.price?.id || null,
              };
            }
            await setStripeStatus(customerId, {
              email, sessionId: s.id, ...fields,
            });
            await attachToUserIfExists(customerId, fields);
            break;
          }

          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted": {
            const sub = event.data.object;
            const customerId = sub.customer;
            const fields = {
              status: sub.status,
              trial_end: sub.trial_end || null,
              current_period_end: sub.current_period_end || null,
              priceId: sub.items?.data?.[0]?.price?.id || null,
            };
            await setStripeStatus(customerId, fields);
            await attachToUserIfExists(customerId, fields);
            await moveGhlStageForStatus(customerId, fields.status);
            break;
          }

          case "invoice.payment_succeeded": {
            const customerId = event.data.object.customer;
            await moveGhlStageForStatus(customerId, "active");
            break;
          }

          case "invoice.payment_failed": {
            const customerId = event.data.object.customer;
            await moveGhlStageForStatus(customerId, "dunning");
            break;
          }
        }
        res.json({ received: true });
      } catch (err) {
        console.error("Webhook handler error:", err);
        res.sendStatus(500);
      }
    }
  );
}

/* ---------- GHL helpers (minimal) ---------- */
async function upsertGhlContactAndTrialOpp({ name, email, phone, customerId, subscriptionId }) {
  // ----- v1: upsert contact -----
  if (!GHL_V1_API_KEY || !GHL_LOCATION_ID) {
    console.warn("Skip GHL v1 upsert: missing GHL_V1_API_KEY or GHL_LOCATION_ID");
    return;
  }

  const v1Headers = {
    Authorization: `Bearer ${GHL_V1_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    LocationId: GHL_LOCATION_ID, // v1 accepts/uses this header
  };

  let contactId;
  try {
    const res = await fetch("https://rest.gohighlevel.com/v1/contacts/", {
      method: "POST",
      headers: v1Headers,
      body: JSON.stringify({
        email,
        firstName: (name || "").split(/\s+/)[0] || "",
        phone: phone || undefined,
        tags: ["FlavorCoach", "Checkout Completed", "Free until Jan 1"],
        // customField: {} // keep commented until you map fields
      }),
    });
    const text = await res.text();
    console.log("GHL v1 upsert contact:", res.status, text.slice(0, 400));
    const json = safeJson(text);
    contactId = json?.contact?.id || json?.id || json?.data?.id;
  } catch (e) {
    console.warn("GHL v1 upsert failed:", e.message);
    return; // don’t try to create an opp without a contact
  }

  // ----- v2: create opportunity in Trial stage -----
  const pipelineId = process.env.GHL_PIPELINE_ID;
  const pipelineStageId = process.env.GHL_TRIAL_STAGE_ID;

  if (!GHL_V2_ACCESS_TOKEN || !GHL_LOCATION_ID) {
    console.warn("Skip GHL v2 opportunity: missing GHL_V2_ACCESS_TOKEN or GHL_LOCATION_ID");
    return;
  }

  if (contactId && pipelineId && pipelineStageId) {
    try {
      const v2Headers = {
        Authorization: `Bearer ${GHL_V2_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        LocationId: GHL_LOCATION_ID, // header (required)
        Version: "2021-07-28",
      };

      console.log("GHL v2 create payload", {
        pipelineId,
        pipelineStageId,
        contactId,
        locationId: GHL_LOCATION_ID,
      });

      const res = await fetch("https://services.leadconnectorhq.com/v2/opportunities/", {
        method: "POST",
        headers: v2Headers,
        body: JSON.stringify({
          contactId,
          name: "FlavorCoach – $10/mo",
          status: "open",
          monetaryValue: 10,
          pipelineId,
          pipelineStageId, // NOTE: v2 uses pipelineStageId
        }),
      });

      const text = await res.text();
      console.log("GHL v2 create opportunity:", res.status, text.slice(0, 400));
      if (!res.ok) throw new Error(`GHL v2 opportunity failed ${res.status} ${text}`);
    } catch (e) {
      console.warn("GHL v2 opportunity error:", e.message);
    }
  } else {
    console.warn("GHL v2 create skipped: missing value(s)", {
      contactId,
      pipelineId,
      pipelineStageId,
    });
  }

  function safeJson(t) {
    try { return JSON.parse(t); } catch { return {}; }
  }
}

// simple stage mapper; expand later to “find & move existing opportunity”
async function moveGhlStageForStatus(_customerId, _status) {
  return; // no-op for now; safe to add later
}

/* ---------- ConvertKit helper ---------- */
async function convertKitSubscribe({ email, firstName }) {
  const key = process.env.CONVERTKIT_API_KEY;
  if (!key) return;
  if (process.env.CONVERTKIT_FORM_ID) {
    try {
      await fetch(`https://api.convertkit.com/v3/forms/${process.env.CONVERTKIT_FORM_ID}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, email, first_name: firstName || "" }),
      });
    } catch (e) {
      console.warn("ConvertKit subscribe skipped:", e.message);
    }
  }
  const tagIds = (process.env.CONVERTKIT_TAG_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  for (const tagId of tagIds) {
    try {
      await fetch(`https://api.convertkit.com/v3/tags/${tagId}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, email }),
      });
    } catch (e) {
      console.warn("ConvertKit tag skipped:", e.message);
    }
  }
}

/* ---------- Firestore helpers ---------- */
async function setStripeStatus(customerId, fields) {
  if (!db || !customerId) return;
  await db.collection("stripe_customers").doc(String(customerId)).set(
    { ...fields, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function attachToUserIfExists(customerId, subscriptionFields) {
  if (!db || !customerId) return;
  const snap = await db.collection("users").where("stripeCustomerId", "==", customerId).limit(1).get();
  if (!snap.empty) {
    await snap.docs[0].ref.set({ subscription: subscriptionFields }, { merge: true });
  }
}

export { registerStripeWebhooks };
